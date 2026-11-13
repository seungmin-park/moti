import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

type KeyRow = { id: string; hint: string; created_at: string; last_used_at: string | null; revoked_at: string | null };
type RunRow = {
  id: string; started_at: string; finished_at: string | null; state: string;
  collected: number; collect_failed: number; prices_confirmed: number; prices_kept: number; failures: Record<string, number>;
};
type Read = { key: KeyRow | null; runs: RunRow[] };
type Issued = { key: KeyRow; secret: string };

const secretFormat = /^moti_wk_[A-Za-z0-9_-]{43}$/;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

async function rpc<T = unknown>(name: string, parameters: Record<string, unknown> = {}, client: SupabaseClient = fixture.owner.client) {
  const { data, error } = await client.rpc(name, parameters);
  return { data: data as T, code: error?.code ?? null };
}

async function issue(replaces: string | null = null): Promise<Issued> {
  const { data, code } = await rpc<Issued>("moti_worker_key_issue", { p_replaces: replaces });
  if (code) throw new Error(`moti_worker_key_issue 실패: ${code}`);
  return data;
}

const read = async () => (await rpc<Read>("moti_worker_read")).data;

async function stored() {
  const { rows } = await fixture.admin.query<{ id: string; token_hash: Buffer; hint: string; revoked_at: Date | null; row: string }>(
    `select k.id, k.token_hash, k.hint, k.revoked_at, row_to_json(k)::text as row
     from moti.worker_keys k where k.owner_id = $1 order by k.created_at, k.id`,
    [fixture.owner.id],
  );
  return rows;
}

// A run as the worker leaves it, written directly: the worker's own functions come with its role.
async function run(keyId: string, values: { startedAgo: string; open: boolean; leaseLeft?: string; stop?: string; collected?: number }) {
  const { rows } = await fixture.admin.query<{ id: string }>(
    `insert into moti.worker_runs (owner_id, key_id, started_at, lease_token, lease_until, finished_at, stop_reason, collected, failures)
     values ($1, $2, now() - $3::interval,
       case when $4 then gen_random_uuid() end, case when $4 then now() + $5::interval end,
       case when $4 then null else now() - $3::interval + interval '30 seconds' end, case when $4 then null else $6 end,
       $7, case when $7 > 0 then '{"timeout": 1}'::jsonb else '{}'::jsonb end)
     returning id`,
    [fixture.owner.id, keyId, values.startedAgo, values.open, values.leaseLeft ?? "90 seconds", values.stop ?? "done", values.collected ?? 0],
  );
  return rows[0].id;
}

async function runState(id: string) {
  const { rows } = await fixture.admin.query<{ stop_reason: string | null; lease_token: string | null; closed_at_lease: boolean }>(
    `select stop_reason, lease_token, finished_at = started_at + interval '90 seconds' as closed_at_lease
     from moti.worker_runs where id = $1`,
    [id],
  );
  return rows[0];
}

describe("소유자의 작업 키", () => {
  it("만들면 moti_wk_ 비밀을 한 번 돌려주고 DB에는 SHA-256 해시와 끝 네 글자만 남긴다", async () => {
    const issued = await issue();

    expect(issued.secret).toMatch(secretFormat);
    expect(issued.key).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      hint: issued.secret.slice(-4),
      created_at: expect.any(String),
      last_used_at: null,
      revoked_at: null,
    });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash.equals(sha256(issued.secret))).toBe(true);
    expect(rows[0].row).not.toContain(issued.secret.slice("moti_wk_".length, -4));

    const shown = await read();
    expect(shown).toEqual({ key: issued.key, runs: [] });
    expect(JSON.stringify(shown)).not.toContain(issued.secret);
    const shareKeys = await fixture.admin.query("select id from moti.share_keys where owner_id = $1", [fixture.owner.id]);
    expect(shareKeys.rows).toEqual([]);
  });

  it("새 키로 바꾸면 이전 키를 폐기하고 활성 키는 하나다. 화면이 본 키가 아니면 M0008이고 아무것도 바꾸지 않는다", async () => {
    const first = await issue();
    expect((await rpc("moti_worker_key_issue", { p_replaces: null })).code).toBe("M0008");
    expect((await rpc("moti_worker_key_issue", { p_replaces: randomUUID() })).code).toBe("M0008");
    expect((await stored()).map(({ id, revoked_at }) => ({ id, revoked: revoked_at !== null }))).toEqual([{ id: first.key.id, revoked: false }]);

    const second = await issue(first.key.id);

    expect(second.secret).not.toBe(first.secret);
    expect((await stored()).map(({ id, revoked_at }) => ({ id, revoked: revoked_at !== null }))).toEqual([
      { id: first.key.id, revoked: true },
      { id: second.key.id, revoked: false },
    ]);
    expect((await read()).key).toEqual(second.key);
  });

  it("동시에 여러 번 만들어도 하나만 커밋하고 나머지는 M0008이다", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => rpc("moti_worker_key_issue", { p_replaces: null })));
    expect(results.filter((result) => result.code === null)).toHaveLength(1);
    expect(results.filter((result) => result.code === "M0008")).toHaveLength(5);
    expect((await stored()).filter((row) => row.revoked_at === null)).toHaveLength(1);
  });

  it("폐기는 멱등이고 폐기한 키를 그대로 보여준다. 소유자에게 없는 키는 M0016이다", async () => {
    const issued = await issue();
    const revoked = await rpc<KeyRow>("moti_worker_key_revoke", { p_key_id: issued.key.id });
    expect(revoked).toMatchObject({ code: null, data: { ...issued.key, revoked_at: expect.any(String) } });
    expect((await rpc<KeyRow>("moti_worker_key_revoke", { p_key_id: issued.key.id })).data).toEqual(revoked.data);
    expect((await read()).key).toEqual(revoked.data);
    expect((await rpc("moti_worker_key_revoke", { p_key_id: randomUUID() })).code).toBe("M0016");
    const share = await rpc<Issued>("moti_share_key_issue", { p_replaces: null });
    expect((await rpc("moti_worker_key_revoke", { p_key_id: share.data.key.id })).code).toBe("M0016");
  });

  it("키가 없으면 키는 null이고 실행 기록은 비어 있다", async () => {
    expect(await rpc("moti_worker_read")).toEqual({ code: null, data: { key: null, runs: [] } });
  });

  it("폐기하거나 새 키로 바꾸면 그 키의 열린 실행을 멈춘다. 임대가 남은 실행은 revoked, 이미 끝난 임대는 그때 cut이다", async () => {
    const first = await issue();
    const live = await run(first.key.id, { startedAgo: "10 seconds", open: true });
    await rpc("moti_worker_key_revoke", { p_key_id: first.key.id });
    expect(await runState(live)).toMatchObject({ stop_reason: "revoked", lease_token: null });

    const second = await issue(null);
    const lapsed = await run(second.key.id, { startedAgo: "2 minutes", open: true, leaseLeft: "-30 seconds" });
    await issue(second.key.id);
    expect(await runState(lapsed)).toEqual({ stop_reason: "cut", lease_token: null, closed_at_lease: true });
  });

  it("실행 기록은 최근 다섯 개를 최신순으로 보이고, 임대가 끝난 열린 실행은 임대가 끝난 때 cut으로 읽는다", async () => {
    const { key } = await issue();
    for (const ago of ["7 hours", "6 hours", "5 hours", "4 hours", "3 hours"]) {
      await run(key.id, { startedAgo: ago, open: false, stop: "deadline", collected: 2 });
    }
    const cut = await run(key.id, { startedAgo: "2 minutes", open: true, leaseLeft: "-30 seconds" });

    const { runs } = await read();
    expect(runs).toHaveLength(5);
    expect(runs[0]).toEqual({
      id: cut, started_at: expect.any(String), finished_at: expect.any(String), state: "cut",
      collected: 0, collect_failed: 0, prices_confirmed: 0, prices_kept: 0, failures: {},
    });
    expect(Date.parse(runs[0].finished_at!) - Date.parse(runs[0].started_at)).toBe(90_000);
    expect(runs.slice(1).map(({ state, collected, failures }) => ({ state, collected, failures })))
      .toEqual(Array.from({ length: 4 }, () => ({ state: "deadline", collected: 2, failures: { timeout: 1 } })));
    expect(runs.map((item) => Date.parse(item.started_at))).toEqual(runs.map((item) => Date.parse(item.started_at)).toSorted((a, b) => b - a));

    await fixture.admin.query("update moti.worker_runs set lease_until = now() + interval '1 minute' where id = $1", [cut]);
    expect((await read()).runs[0]).toMatchObject({ state: "running", finished_at: null });
  });

  it.each(["anonymous", "stranger"])("%s 요청은 읽기·만들기·폐기를 모두 거절하고 아무것도 쓰지 않는다", async (who) => {
    const issued = await issue();
    const client = who === "anonymous" ? fixture.anonymous : fixture.stranger.client;
    const refused = who === "anonymous" ? "42501" : "M0001";
    expect((await rpc("moti_worker_read", {}, client)).code).toBe(refused);
    expect((await rpc("moti_worker_key_issue", { p_replaces: issued.key.id }, client)).code).toBe(refused);
    expect((await rpc("moti_worker_key_revoke", { p_key_id: issued.key.id }, client)).code).toBe(refused);
    expect((await stored()).map(({ id, revoked_at }) => ({ id, revoked_at }))).toEqual([{ id: issued.key.id, revoked_at: null }]);
  });

  it("RPC 역할은 소유자의 키 해시와 실행 임대 토큰을 읽지 못한다", async () => {
    const { key } = await issue();
    await run(key.id, { startedAgo: "10 seconds", open: true });
    const connection = await fixture.admin.connect();
    try {
      await connection.query("set role moti_rpc");
      await connection.query("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ sub: fixture.owner.id, role: "authenticated" }),
      ]);
      expect((await connection.query("select hint from moti.worker_keys")).rows).toHaveLength(1);
      expect((await connection.query("select stop_reason from moti.worker_runs")).rows).toHaveLength(1);
      await expect(connection.query("select token_hash from moti.worker_keys")).rejects.toMatchObject({ code: "42501" });
      await expect(connection.query("select lease_token from moti.worker_runs")).rejects.toMatchObject({ code: "42501" });
      await expect(connection.query(`insert into moti.worker_runs (owner_id, key_id, lease_token, lease_until)
        values ('${fixture.owner.id}', '${key.id}', gen_random_uuid(), now())`)).rejects.toMatchObject({ code: "42501" });
      await expect(connection.query("delete from moti.worker_runs")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await connection.query("reset role");
      await connection.query("select set_config('request.jwt.claims', '', false)");
      connection.release();
    }
  });

  it("백업은 작업 키와 실행 기록을 담지 않고 복원은 둘을 바꾸지 않는다", async () => {
    const issued = await issue();
    await run(issued.key.id, { startedAgo: "1 hour", open: false, collected: 1 });
    const library = createSupabaseLibraryStore(fixture.owner.client);
    await library.saveLink(toLinkSaveCommand({ url: "https://shop.example/lamp", option: "", collectionIds: [] }));
    const before = { keys: await stored(), read: await read() };

    const backup = await rpc("moti_backup");
    expect(JSON.stringify(backup.data)).not.toContain(issued.key.id);
    await library.restoreLibrary({ backup: { collections: [], products: [] } });

    expect({ keys: await stored(), read: await read() }).toEqual(before);
  });
});
