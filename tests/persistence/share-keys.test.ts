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
type Issued = { key: KeyRow; secret: string };

const secretFormat = /^moti_sk_[A-Za-z0-9_-]{43}$/;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

async function rpc<T = unknown>(name: string, parameters: Record<string, unknown> = {}, client: SupabaseClient = fixture.owner.client) {
  const { data, error } = await client.rpc(name, parameters);
  return { data: data as T, code: error?.code ?? null, message: error?.message ?? null };
}

async function issue(replaces: string | null = null): Promise<Issued> {
  const { data, code } = await rpc<Issued>("moti_share_key_issue", { p_replaces: replaces });
  if (code) throw new Error(`moti_share_key_issue 실패: ${code}`);
  return data;
}

async function stored() {
  const { rows } = await fixture.admin.query<{ id: string; token_hash: Buffer; hint: string; revoked_at: Date | null; row: string }>(
    `select k.id, k.token_hash, k.hint, k.revoked_at, row_to_json(k)::text as row
     from moti.share_keys k where k.owner_id = $1 order by k.created_at, k.id`,
    [fixture.owner.id],
  );
  return rows;
}

describe("소유자의 저장 키", () => {
  it("만들면 moti_sk_ 비밀을 한 번 돌려주고 DB에는 SHA-256 해시와 끝 네 글자만 남긴다", async () => {
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
    expect(rows[0].hint).toBe(issued.secret.slice(-4));
    expect(rows[0].row).not.toContain(issued.secret.slice("moti_sk_".length, -4));

    const read = await rpc("moti_share_key_read");
    expect(read).toMatchObject({ code: null, data: issued.key });
    expect(JSON.stringify(read.data)).not.toContain(issued.secret);
  });

  it("두 번 만든 비밀은 서로 다르다", async () => {
    const first = await issue();
    const second = await issue(first.key.id);
    expect(second.secret).not.toBe(first.secret);
    expect(second.secret).toMatch(secretFormat);
  });

  it("새 키로 바꾸면 이전 키를 폐기하고 활성 키는 하나다. 화면이 본 키가 아니면 M0008이고 아무것도 바꾸지 않는다", async () => {
    const first = await issue();
    expect((await rpc("moti_share_key_issue", { p_replaces: null })).code).toBe("M0008");
    expect((await rpc("moti_share_key_issue", { p_replaces: randomUUID() })).code).toBe("M0008");
    expect((await stored()).map(({ id, revoked_at }) => ({ id, revoked: revoked_at !== null }))).toEqual([{ id: first.key.id, revoked: false }]);

    const second = await issue(first.key.id);

    const rows = await stored();
    expect(rows.map(({ id, revoked_at }) => ({ id, revoked: revoked_at !== null }))).toEqual([
      { id: first.key.id, revoked: true },
      { id: second.key.id, revoked: false },
    ]);
    expect((await rpc("moti_share_key_read")).data).toEqual(second.key);
    expect((await rpc("moti_share_key_issue", { p_replaces: first.key.id })).code).toBe("M0008");
  });

  it("동시에 여러 번 만들어도 하나만 커밋하고 나머지는 M0008이다", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => rpc("moti_share_key_issue", { p_replaces: null })));
    expect(results.filter((result) => result.code === null)).toHaveLength(1);
    expect(results.filter((result) => result.code === "M0008")).toHaveLength(5);
    expect((await stored()).filter((row) => row.revoked_at === null)).toHaveLength(1);
  });

  it("폐기는 멱등이고 폐기한 키를 그대로 보여준다. 소유자에게 없는 키는 M0011이다", async () => {
    const issued = await issue();
    const revoked = await rpc<KeyRow>("moti_share_key_revoke", { p_key_id: issued.key.id });
    expect(revoked).toMatchObject({ code: null, data: { ...issued.key, revoked_at: expect.any(String) } });
    const again = await rpc<KeyRow>("moti_share_key_revoke", { p_key_id: issued.key.id });
    expect(again.data).toEqual(revoked.data);
    expect((await rpc("moti_share_key_read")).data).toEqual(revoked.data);
    expect((await rpc("moti_share_key_revoke", { p_key_id: randomUUID() })).code).toBe("M0011");

    const next = await issue(null);
    expect((await rpc("moti_share_key_read")).data).toEqual(next.key);
  });

  it("키가 없으면 읽기는 null이다", async () => {
    expect(await rpc("moti_share_key_read")).toMatchObject({ code: null, data: null });
  });

  it.each(["anonymous", "stranger"])("%s 요청은 읽기·만들기·폐기를 모두 거절하고 아무것도 쓰지 않는다", async (who) => {
    const issued = await issue();
    const client = who === "anonymous" ? fixture.anonymous : fixture.stranger.client;
    const refused = who === "anonymous" ? "42501" : "M0001";
    expect((await rpc("moti_share_key_read", {}, client)).code).toBe(refused);
    expect((await rpc("moti_share_key_issue", { p_replaces: issued.key.id }, client)).code).toBe(refused);
    expect((await rpc("moti_share_key_revoke", { p_key_id: issued.key.id }, client)).code).toBe(refused);
    expect((await stored()).map(({ id, revoked_at }) => ({ id, revoked_at }))).toEqual([{ id: issued.key.id, revoked_at: null }]);
    const { rows } = await fixture.admin.query("select id from moti.share_keys where owner_id = $1", [fixture.stranger.id]);
    expect(rows).toEqual([]);
  });

  it("RPC 역할은 소유자의 키 행도 해시는 읽지 못한다", async () => {
    await issue();
    const connection = await fixture.admin.connect();
    try {
      await connection.query("set role moti_rpc");
      await connection.query("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ sub: fixture.owner.id, role: "authenticated" }),
      ]);
      expect((await connection.query("select hint from moti.share_keys")).rows).toHaveLength(1);
      await expect(connection.query("select token_hash from moti.share_keys")).rejects.toMatchObject({ code: "42501" });
      await expect(connection.query("select window_uses from moti.share_keys")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await connection.query("reset role");
      await connection.query("select set_config('request.jwt.claims', '', false)");
      connection.release();
    }
  });

  it("백업은 저장 키를 담지 않고 복원은 저장 키를 바꾸지 않는다", async () => {
    const issued = await issue();
    const library = createSupabaseLibraryStore(fixture.owner.client);
    await library.saveLink(toLinkSaveCommand({ url: "https://shop.example/lamp", option: "", collectionIds: [] }));
    const before = await stored();

    const backup = await rpc("moti_backup");
    expect(JSON.stringify(backup.data)).not.toContain(issued.key.id);
    expect(JSON.stringify(backup.data)).not.toContain(issued.secret);
    await library.restoreLibrary({ backup: { collections: [], products: [] } });

    expect(await stored()).toEqual(before);
  });
});
