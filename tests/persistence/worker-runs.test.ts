import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { readDatabaseConfig } from "../support/database-config";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

type Issued = { key: { id: string }; secret: string };
type Begun = { run: string; lease: string };

async function rpc<T = unknown>(name: string, parameters: Record<string, unknown> = {}, client: SupabaseClient = fixture.anonymous) {
  const { data, error } = await client.rpc(name, parameters);
  return { data: data as T, code: error?.code ?? null, message: error?.message ?? null };
}

async function issue(replaces: string | null = null, name = "moti_worker_key_issue"): Promise<Issued> {
  const { data, code } = await rpc<Issued>(name, { p_replaces: replaces }, fixture.owner.client);
  if (code) throw new Error(`${name} 실패: ${code}`);
  return data;
}

async function begin(secret: string): Promise<Begun> {
  const { data, code } = await rpc<Begun>("moti_worker_begin", { p_key: secret });
  if (code) throw new Error(`moti_worker_begin 실패: ${code}`);
  return data;
}

const finish = (secret: string, { run, lease }: Begun, stop = "done") =>
  rpc("moti_worker_finish", { p_key: secret, p_run: run, p_lease: lease, p_stop: stop });

const wellFormed = () => `moti_wk_${randomBytes(32).toString("base64url")}`;

async function runs() {
  const { rows } = await fixture.admin.query<{
    id: string; stop_reason: string | null; open: boolean; lease_seconds: number | null; finished_at_lease: boolean | null;
  }>(
    `select id, stop_reason, finished_at is null as open,
       round(extract(epoch from lease_until - started_at))::int as lease_seconds,
       finished_at = started_at + interval '90 seconds' as finished_at_lease
     from moti.worker_runs where owner_id = $1 order by started_at, id`,
    [fixture.owner.id],
  );
  return rows;
}

async function lastUsed(keyId: string) {
  const { rows } = await fixture.admin.query<{ last_used_at: Date | null }>("select last_used_at from moti.worker_keys where id = $1", [keyId]);
  return rows[0].last_used_at;
}

const backdate = (id: string, ago: string) => fixture.admin.query(
  `update moti.worker_runs set started_at = now() - $2::interval, lease_until = now() - $2::interval + interval '90 seconds'
   where id = $1`,
  [id, ago],
);

async function pastRuns(keyId: string, agos: string[]) {
  for (const ago of agos) {
    await fixture.admin.query(
      `insert into moti.worker_runs (owner_id, key_id, started_at, finished_at, stop_reason)
       values ($1, $2, now() - $3::interval, now() - $3::interval + interval '20 seconds', 'done')`,
      [fixture.owner.id, keyId, ago],
    );
  }
}

describe("작업 실행의 시작과 끝", () => {
  it("작업 키로 시작하면 90초 임대의 열린 실행 하나를 만들고 키를 마지막으로 쓴 때를 남긴다", async () => {
    const { key, secret } = await issue();
    const begun = await begin(secret);

    expect(begun).toEqual({ run: expect.stringMatching(/^[0-9a-f-]{36}$/), lease: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await runs()).toEqual([{ id: begun.run, stop_reason: null, open: true, lease_seconds: 90, finished_at_lease: null }]);
    expect(await lastUsed(key.id)).not.toBeNull();
    const shown = await rpc<{ runs: { state: string }[] }>("moti_worker_read", {}, fixture.owner.client);
    expect(shown.data.runs.map(({ state }) => state)).toEqual(["running"]);
  });

  it("형식이 다르거나 모르거나 폐기했거나 공유 키이거나 소유자 설정이 바뀐 키는 모두 같은 M0012이고 아무것도 쓰지 않는다", async () => {
    const revoked = await issue();
    const active = await issue(revoked.key.id);
    const share = await issue(null, "moti_share_key_issue");
    const refused = [
      null, "", wellFormed(), `${active.secret}x`, active.secret.slice(0, -1), active.secret.toUpperCase(),
      active.secret.replace("moti_wk_", "moti_sk_"), share.secret, revoked.secret, ` ${active.secret}`,
    ];
    for (const key of refused) {
      expect(await rpc("moti_worker_begin", { p_key: key }), String(key)).toMatchObject({ code: "M0012", message: "worker key rejected" });
    }
    await fixture.admin.query("delete from auth.identities where user_id = $1 and provider = 'google'", [fixture.owner.id]);
    expect((await rpc("moti_worker_begin", { p_key: active.secret })).code).toBe("M0012");
    await fixture.admin.query("update moti.owner_config set owner_id = $1, google_subject = $2",
      [fixture.stranger.id, fixture.stranger.googleSubject]);
    expect((await rpc("moti_worker_begin", { p_key: active.secret })).code).toBe("M0012");
    expect(await runs()).toEqual([]);
    expect(await lastUsed(active.key.id)).toBeNull();
  });

  it("열린 실행이 있으면 다음 시작은 M0014다. 임대가 끝난 실행은 임대가 끝난 때 cut으로 닫고 새 실행을 시작한다", async () => {
    const { secret } = await issue();
    const first = await begin(secret);
    expect((await rpc("moti_worker_begin", { p_key: secret })).code).toBe("M0014");
    const together = await Promise.all(Array.from({ length: 4 }, () => rpc("moti_worker_begin", { p_key: secret })));
    expect(together.map(({ code }) => code)).toEqual(["M0014", "M0014", "M0014", "M0014"]);
    expect(await runs()).toHaveLength(1);

    await backdate(first.run, "5 minutes");
    const second = await begin(secret);
    expect(await runs()).toEqual([
      { id: first.run, stop_reason: "cut", open: false, lease_seconds: null, finished_at_lease: true },
      { id: second.run, stop_reason: null, open: true, lease_seconds: 90, finished_at_lease: null },
    ]);
    expect(await finish(secret, first)).toMatchObject({ code: "M0013" });
  });

  it("24시간 안에 8번 시작했으면 9번째는 M0015이고 아무것도 쓰지 않는다. 30일이 지난 기록은 시작할 때 지운다", async () => {
    const { key, secret } = await issue();
    await pastRuns(key.id, ["31 days", "25 hours", "23 hours", "21 hours", "18 hours", "15 hours", "12 hours", "8 hours", "4 hours", "1 hour"]);
    const before = await runs();
    expect(await rpc("moti_worker_begin", { p_key: secret })).toMatchObject({ code: "M0015", message: "worker run limit" });
    expect(await runs()).toEqual(before);
    expect(await lastUsed(key.id)).toBeNull();

    await fixture.admin.query("delete from moti.worker_runs where owner_id = $1 and started_at > now() - interval '2 hours'", [fixture.owner.id]);
    const begun = await begin(secret);
    const after = await runs();
    expect(after).toHaveLength(9);
    expect(after.at(-1)?.id).toBe(begun.run);
    expect(after.some((row) => row.id === before[0].id)).toBe(false);
  });

  it("끝내면 done이나 deadline으로 닫고 셈을 돌려준다. 다른 임대·닫힌 실행·다른 키는 M0013·M0012이고 다른 끝은 M0002다", async () => {
    const { secret } = await issue();
    const begun = await begin(secret);
    expect((await finish(secret, { ...begun, lease: randomUUID() })).code).toBe("M0013");
    expect((await finish(secret, { ...begun, run: randomUUID() })).code).toBe("M0013");
    expect((await finish(wellFormed(), begun)).code).toBe("M0012");
    expect((await finish(secret, begun, "cut")).code).toBe("M0002");
    expect((await finish(secret, begun, "revoked")).code).toBe("M0002");
    expect((await runs())[0]).toMatchObject({ open: true });

    expect(await finish(secret, begun, "deadline")).toEqual({
      code: null,
      message: null,
      data: { stop: "deadline", collected: 0, collect_failed: 0, prices_confirmed: 0, prices_kept: 0, failures: {} },
    });
    expect((await runs())[0]).toMatchObject({ stop_reason: "deadline", open: false });
    expect((await finish(secret, begun)).code).toBe("M0013");
  });

  it("임대가 끝난 실행의 다음 단계는 M0013이다", async () => {
    const { secret } = await issue();
    const begun = await begin(secret);
    await backdate(begun.run, "100 seconds");
    expect((await finish(secret, begun)).code).toBe("M0013");
  });

  it("실행 중에 키를 폐기하면 다음 단계는 M0012이고 실행은 revoked로 읽는다", async () => {
    const { key, secret } = await issue();
    const begun = await begin(secret);
    await rpc("moti_worker_key_revoke", { p_key_id: key.id }, fixture.owner.client);
    expect((await finish(secret, begun)).code).toBe("M0012");
    const shown = await rpc<{ runs: { state: string }[] }>("moti_worker_read", {}, fixture.owner.client);
    expect(shown.data.runs.map(({ state }) => state)).toEqual(["revoked"]);
  });

  it("로그인 세션은 작업 함수를 실행하지 못하고, PostgREST에 작업 키를 Bearer로 보내면 세션이 아니라서 거절한다", async () => {
    const { secret } = await issue();
    expect((await rpc("moti_worker_begin", { p_key: secret }, fixture.owner.client)).code).toBe("42501");
    expect((await rpc("moti_worker_finish", { p_key: secret, p_run: randomUUID(), p_lease: randomUUID(), p_stop: "done" }, fixture.owner.client)).code)
      .toBe("42501");
    const { apiUrl, anonKey } = readDatabaseConfig();
    for (const name of ["moti_snapshot", "moti_worker_read", "moti_worker_begin"]) {
      const response = await fetch(new URL(`/rest/v1/rpc/${name}`, apiUrl), {
        method: "POST",
        headers: { apikey: anonKey, authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(name === "moti_worker_begin" ? { p_key: secret } : {}),
      });
      expect(response.status, name).toBe(401);
    }
    expect(await runs()).toEqual([]);
  });

  it("공유 키 함수에 작업 키를 보내면 M0009다", async () => {
    const { secret } = await issue();
    const response = await rpc("moti_share_add", {
      p_key: secret, p_source_url: "https://shop.example/lamp", p_identity_url: "https://shop.example/lamp", p_option: "", p_shop: "shop.example",
    });
    expect(response.code).toBe("M0009");
  });
});

describe("작업 역할의 권한", () => {
  it("moti_worker는 로그인할 수 없고 상속·RLS 우회가 없으며 구성원은 postgres뿐이다. 소유한 것은 익명이 실행하는 작업 함수뿐이다", async () => {
    const role = await fixture.admin.query(
      `select rolsuper, rolbypassrls, rolinherit, rolcanlogin, rolcreaterole, rolcreatedb,
         (select count(*)::int from pg_auth_members m where m.member = r.oid) as member_of
       from pg_roles r where rolname = 'moti_worker'`,
    );
    expect(role.rows).toEqual([{
      rolsuper: false, rolbypassrls: false, rolinherit: false, rolcanlogin: false, rolcreaterole: false, rolcreatedb: false, member_of: 0,
    }]);
    const members = await fixture.admin.query(
      `select distinct m.member::regrole::text as member from pg_auth_members m where m.roleid = 'moti_worker'::regrole order by 1`,
    );
    expect(members.rows).toEqual([{ member: "postgres" }]);
    const owned = await fixture.admin.query<{ name: string; prosecdef: boolean; anon: boolean; authenticated: boolean; service: boolean }>(
      `select p.oid::regprocedure::text as name, p.prosecdef,
         has_function_privilege('anon', p.oid, 'execute') as anon,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
         has_function_privilege('service_role', p.oid, 'execute') as service
       from pg_proc p where p.proowner = 'moti_worker'::regrole
       union all select c.oid::regclass::text, false, false, false, false from pg_class c where c.relowner = 'moti_worker'::regrole
       order by 1`,
    );
    expect(owned.rows).toEqual(WORKER_FUNCTIONS.map((name) => ({ name, prosecdef: true, anon: true, authenticated: false, service: false })));
  });

  it("moti_worker 역할에 직접 준 권한과 정책은 작업에 필요한 것뿐이다", async () => {
    const { rows } = await fixture.admin.query<{ grant: string }>(
      `with worker as (select 'moti_worker'::regrole::oid as oid)
       select g.grant from (
         select format('schema %s %s', n.nspname, a.privilege_type) as grant
         from pg_namespace n, aclexplode(n.nspacl) a, worker where a.grantee = worker.oid
         union all
         select format('table %s %s', c.oid::regclass, a.privilege_type)
         from pg_class c, aclexplode(c.relacl) a, worker where a.grantee = worker.oid
         union all
         select format('column %s.%s %s', c.oid::regclass, t.attname, a.privilege_type)
         from pg_attribute t join pg_class c on c.oid = t.attrelid, aclexplode(t.attacl) a, worker where a.grantee = worker.oid
         union all
         select format('function %s %s', p.oid::regprocedure, a.privilege_type)
         from pg_proc p, aclexplode(p.proacl) a, worker where a.grantee = worker.oid and p.proowner <> worker.oid
       ) g order by g.grant`,
    );
    expect(rows.map((row) => row.grant)).toEqual(WORKER_GRANTS);
    const policies = await fixture.admin.query<{ policy: string }>(
      `select format('%s %s %s', tablename, policyname, cmd) as policy from pg_policies
       where schemaname = 'moti' and 'moti_worker' = any(roles) order by 1`,
    );
    expect(policies.rows.map((row) => row.policy)).toEqual(WORKER_POLICIES);
  });

  it("moti_worker 역할로는 정한 권한 밖의 읽기·쓰기·함수 실행을 모두 거절한다", async () => {
    const { key } = await issue();
    const share = await issue(null, "moti_share_key_issue");
    const { rows } = await fixture.admin.query<{ id: string }>(
      `insert into moti.products (owner_id, source_url, identity_url, shop) values ($1, 'https://shop.example/lamp', 'https://shop.example/lamp', 'shop.example')
       returning id`,
      [fixture.owner.id],
    );
    const product = rows[0].id;
    const connection = await fixture.admin.connect();
    const refused = [
      "select owner_title from moti.products",
      "select note from moti.products",
      "select title from moti.products",
      "select option from moti.products",
      "select * from moti.products",
      `update moti.products set owner_title = 'x' where id = '${product}'`,
      `update moti.products set note = 'x' where id = '${product}'`,
      `update moti.products set purchase_status = 'purchased' where id = '${product}'`,
      `update moti.products set picture_job_id = null where id = '${product}'`,
      `insert into moti.products (owner_id, source_url, identity_url, shop) values ('${fixture.owner.id}', 'https://x.example', 'https://x.example', 'x')`,
      `delete from moti.products where id = '${product}'`,
      "select id from moti.collections",
      `insert into moti.collections (owner_id, name) values ('${fixture.owner.id}', 'x')`,
      "select product_id from moti.product_collections",
      "select hint from moti.share_keys",
      `update moti.share_keys set revoked_at = now() where id = '${share.key.id}'`,
      "select hint from moti.worker_keys",
      `update moti.worker_keys set revoked_at = now() where id = '${key.id}'`,
      `insert into moti.worker_keys (owner_id, token_hash, hint) values ('${fixture.owner.id}', '\\x00', 'abcd')`,
      `insert into moti.metadata_jobs (owner_id, product_id, generation) values ('${fixture.owner.id}', '${product}', 2)`,
      "select singleton from moti.owner_config",
      "select name from storage.objects",
      "select moti.require_owner()",
      `select moti.edit_product('${fixture.owner.id}', '${product}', 1, 'x', '', '{}')`,
      `select moti.metadata_claim('${fixture.owner.id}', '${product}', 1)`,
      "select public.moti_snapshot()",
      "select public.moti_worker_read()",
      `select public.moti_share_add('${share.secret}', 'https://x.example', 'https://x.example', '', 'x')`,
    ];
    try {
      await connection.query("set role moti_worker");
      for (const statement of refused) {
        await expect(connection.query(statement), statement).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await connection.query("reset role");
      connection.release();
    }
    const after = await fixture.admin.query("select owner_title, note, purchase_status from moti.products where id = $1", [product]);
    expect(after.rows).toEqual([{ owner_title: null, note: "", purchase_status: "wish" }]);
  });
});

const WORKER_FUNCTIONS = [
  "moti_worker_begin(text)",
  "moti_worker_finish(text,uuid,uuid,text)",
];

const WORKER_GRANTS = [
  "column moti.owner_config.google_subject SELECT",
  "column moti.owner_config.owner_id SELECT",
  "column moti.worker_keys.id SELECT",
  "column moti.worker_keys.last_used_at UPDATE",
  "column moti.worker_keys.owner_id SELECT",
  "column moti.worker_keys.revoked_at SELECT",
  "column moti.worker_keys.token_hash SELECT",
  "column moti.worker_runs.collect_failed UPDATE",
  "column moti.worker_runs.collected UPDATE",
  "column moti.worker_runs.failures UPDATE",
  "column moti.worker_runs.finished_at UPDATE",
  "column moti.worker_runs.key_id INSERT",
  "column moti.worker_runs.lease_token INSERT",
  "column moti.worker_runs.lease_token UPDATE",
  "column moti.worker_runs.lease_until INSERT",
  "column moti.worker_runs.lease_until UPDATE",
  "column moti.worker_runs.owner_id INSERT",
  "column moti.worker_runs.stop_reason UPDATE",
  "function moti.has_google_identity(uuid,text) EXECUTE",
  "function moti.worker_run_owner(text,uuid,uuid) EXECUTE",
  "schema extensions USAGE",
  "schema moti USAGE",
  "table moti.worker_runs DELETE",
  "table moti.worker_runs SELECT",
];

const WORKER_POLICIES = [
  "owner_config worker_reads_owner SELECT",
  "worker_keys worker_finds_active_key SELECT",
  "worker_keys worker_marks_use UPDATE",
  "worker_runs worker_keeps_runs ALL",
];
