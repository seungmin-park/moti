import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { toShareLinkAddCommand } from "../../src/features/share/application/commands";
import { ShareError, parseShareSecret, type ShareSecret } from "../../src/features/share/domain/share-key";
import { createSupabaseShareLinkStore } from "../../src/features/share/infrastructure/supabase-share-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { readDatabaseConfig } from "../support/database-config";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

type Issued = { key: { id: string }; secret: string };

const library = () => createSupabaseLibraryStore(fixture.owner.client);

async function rpc(name: string, parameters: Record<string, unknown> = {}, client: SupabaseClient = fixture.owner.client) {
  const { data, error } = await client.rpc(name, parameters);
  return { data, code: error?.code ?? null, error };
}

async function issue(replaces: string | null = null): Promise<Issued> {
  const { data, code } = await rpc("moti_share_key_issue", { p_replaces: replaces });
  if (code) throw new Error(`moti_share_key_issue 실패: ${code}`);
  return data as Issued;
}

function linkOf(url: string) {
  const { sourceUrl, identityUrl, option, shop } = toLinkSaveCommand({ url, option: "", collectionIds: [] });
  return { p_source_url: sourceUrl, p_identity_url: identityUrl, p_option: option, p_shop: shop };
}

const add = (key: string | null, url: string, client: SupabaseClient = fixture.anonymous) =>
  rpc("moti_share_add", { p_key: key, ...linkOf(url) }, client);

const wellFormed = () => `moti_sk_${randomBytes(32).toString("base64url")}`;

async function counts() {
  const { rows } = await fixture.admin.query<{ products: number; jobs: number }>(
    `select (select count(*)::int from moti.products where owner_id = $1) as products,
       (select count(*)::int from moti.metadata_jobs where owner_id = $1) as jobs`,
    [fixture.owner.id],
  );
  return rows[0];
}

async function keyRow(id: string) {
  const { rows } = await fixture.admin.query<{ last_used_at: Date | null; window_uses: number; window_started_at: Date | null }>(
    "select last_used_at, window_uses, window_started_at from moti.share_keys where id = $1", [id],
  );
  return rows[0];
}

const ownerView = (product: Product) =>
  ({ ...product, id: undefined, sourceUrl: undefined, identityUrl: undefined, addedAt: undefined, updatedAt: undefined });

describe("저장 키로 링크 담기", () => {
  it("키로 담으면 소유자가 저장한 것과 같은 상품과 첫 수집 작업을 만들고 결과의 종류만 돌려준다", async () => {
    const { secret } = await issue();

    const added = await add(secret, "https://shop.example/lamp?utm_source=share#white");
    const saved = (await library().saveLink(toLinkSaveCommand({ url: "https://shop.example/desk", option: "", collectionIds: [] }))).product;

    expect(added).toMatchObject({ code: null, data: { kind: "added" } });
    expect(Object.keys(added.data as object)).toEqual(["kind"]);
    const products = (await library().snapshot()).products;
    const shared = products.find((product) => product.sourceUrl === "https://shop.example/lamp?utm_source=share#white")!;
    expect(shared).toMatchObject({ identityUrl: "https://shop.example/lamp#white", shop: "shop.example" });
    expect(ownerView(shared)).toEqual(ownerView(saved));
    const { rows } = await fixture.admin.query<{ product_id: string; generation: number; status: string; attempts: number }>(
      "select product_id, generation, status, attempts from moti.metadata_jobs where owner_id = $1 order by created_at",
      [fixture.owner.id],
    );
    expect(rows.find((row) => row.product_id === shared.id)).toEqual({ product_id: shared.id, generation: 1, status: "queued", attempts: 0 });
  });

  it("이미 담은 링크는 duplicate만 알리고 아무것도 더 쓰지 않는다", async () => {
    const { secret } = await issue();
    await library().saveLink(toLinkSaveCommand({ url: "https://shop.example/lamp", option: "", collectionIds: [] }));

    const repeated = await add(secret, "https://shop.example/lamp?utm_source=share");

    expect(repeated).toMatchObject({ code: null, data: { kind: "duplicate" } });
    expect(Object.keys(repeated.data as object)).toEqual(["kind"]);
    expect(await counts()).toEqual({ products: 1, jobs: 1 });
  });

  it("모르는 키, 한 글자 틀린 키, 형식이 다른 키와 폐기한 키는 모두 같은 M0009와 같은 메시지로 거절하고 아무것도 쓰지 않는다", async () => {
    const live = await issue();
    const revoked = await issue(live.key.id);
    await rpc("moti_share_key_revoke", { p_key_id: revoked.key.id });
    const last = live.secret.at(-1) === "A" ? "B" : "A";
    const refused = [
      wellFormed(),
      `${live.secret.slice(0, -1)}${last}`,
      live.secret,
      revoked.secret,
      null,
      "",
      "moti_sk_short",
      `Bearer ${revoked.secret}`,
      `${revoked.secret}=`,
      revoked.secret.slice(0, -1),
      `moti_sk_${"+".repeat(43)}`,
      `moti_pk_${revoked.secret.slice(8)}`,
      "x".repeat(100_000),
    ];

    const results = [];
    for (const key of refused) results.push(await add(key, "https://shop.example/lamp"));

    for (const result of results) {
      expect(result.code).toBe("M0009");
      expect(result.error?.message).toBe("share key rejected");
      expect(JSON.stringify(result.error)).not.toContain(fixture.owner.id);
    }
    expect(await counts()).toEqual({ products: 0, jobs: 0 });
    expect(await keyRow(revoked.key.id)).toMatchObject({ last_used_at: null, window_uses: 0 });
  });

  it("소유자 세션은 저장 키 함수를 실행하지 못하고, 익명은 다른 moti 함수를 실행하지 못한다", async () => {
    const { secret, key } = await issue();
    expect((await add(secret, "https://shop.example/lamp", fixture.owner.client)).code).toBe("42501");
    for (const [name, parameters] of [
      ["moti_snapshot", {}],
      ["moti_backup", {}],
      ["moti_restore_library", { p_collections: [], p_products: [] }],
      ["moti_edit_product", { p_product_id: randomUUID(), p_revision: 1, p_title: null, p_note: "", p_collection_ids: [] }],
      ["moti_save_link", { ...linkOf("https://shop.example/lamp"), p_collection_ids: [] }],
      ["moti_share_key_read", {}],
      ["moti_share_key_issue", { p_replaces: key.id }],
      ["moti_share_key_revoke", { p_key_id: key.id }],
    ] as const) {
      expect((await rpc(name, parameters, fixture.anonymous)).code, name).toBe("42501");
    }
    expect(await counts()).toEqual({ products: 0, jobs: 0 });
    expect((await fixture.admin.query("select revoked_at from moti.share_keys where id = $1", [key.id])).rows).toEqual([{ revoked_at: null }]);
  });

  it("PostgREST에 비밀을 Bearer로 보내면 세션이 아니라서 거절한다", async () => {
    const { secret } = await issue();
    const { apiUrl, anonKey } = readDatabaseConfig();
    for (const name of ["moti_snapshot", "moti_share_add"]) {
      const response = await fetch(new URL(`/rest/v1/rpc/${name}`, apiUrl), {
        method: "POST",
        headers: { apikey: anonKey, authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(name === "moti_share_add" ? { p_key: secret, ...linkOf("https://shop.example/lamp") } : {}),
      });
      expect(response.status, name).toBe(401);
    }
    expect(await counts()).toEqual({ products: 0, jobs: 0 });
  });

  it("소유자 설정이 다른 계정으로 바뀌거나 Google 연결이 없어지면 이전 키는 M0009다", async () => {
    const { secret } = await issue();
    await fixture.admin.query("delete from auth.identities where user_id = $1 and provider = 'google'", [fixture.owner.id]);
    expect((await add(secret, "https://shop.example/lamp")).code).toBe("M0009");
    await fixture.admin.query("update moti.owner_config set owner_id = $1, google_subject = $2",
      [fixture.stranger.id, fixture.stranger.googleSubject]);
    expect((await add(secret, "https://shop.example/lamp")).code).toBe("M0009");
    expect(await counts()).toEqual({ products: 0, jobs: 0 });
  });

  it("한 키로 한 시간에 30번까지 담고 31번째는 M0010이며 아무것도 쓰지 않는다. 한 시간이 지나면 다시 담는다", async () => {
    const { secret, key } = await issue();
    for (let index = 0; index < 30; index += 1) {
      const result = await add(secret, `https://shop.example/item-${index % 20}`);
      expect(result.code).toBeNull();
    }
    const thirtieth = await keyRow(key.id);
    expect(thirtieth.window_uses).toBe(30);

    const refused = await add(secret, "https://shop.example/one-more");

    expect(refused.code).toBe("M0010");
    expect(await counts()).toEqual({ products: 20, jobs: 20 });
    expect(await keyRow(key.id)).toEqual(thirtieth);

    await fixture.admin.query("update moti.share_keys set window_started_at = now() - interval '61 minutes' where id = $1", [key.id]);
    expect((await add(secret, "https://shop.example/one-more")).data).toEqual({ kind: "added" });
    expect((await keyRow(key.id)).window_uses).toBe(1);
  });

  it.each([
    ["javascript 링크", { p_source_url: "javascript:alert(1)" }],
    ["계정이 든 링크", { p_source_url: "https://name:secret@example.com/item" }],
    ["빈 정체성", { p_identity_url: "" }],
    ["긴 옵션", { p_option: "x".repeat(121) }],
    ["빈 쇼핑몰", { p_shop: "" }],
  ])("Next를 거치지 않은 %s도 SQL이 M0002로 거절하고 키 사용 시각을 남기지 않는다", async (_name, override) => {
    const { secret, key } = await issue();
    const result = await rpc("moti_share_add", { p_key: secret, ...linkOf("https://shop.example/lamp"), ...override }, fixture.anonymous);
    expect(result.code).toBe("M0002");
    expect(await counts()).toEqual({ products: 0, jobs: 0 });
    expect(await keyRow(key.id)).toMatchObject({ last_used_at: null, window_uses: 0 });
  });

  it("검사를 지난 값을 테이블이 거절해도 행 내용 없이 M0002로 바꾼다", async () => {
    const { secret } = await issue();
    await fixture.admin.query("alter table moti.products add constraint share_test_refuses check (shop <> 'refuse.example') not valid");
    try {
      const result = await add(secret, "https://refuse.example/lamp");
      expect(result.code).toBe("M0002");
      expect(result.error?.message).toBe("invalid link input");
      expect(JSON.stringify(result.error)).not.toContain(fixture.owner.id);
      expect(JSON.stringify(result.error)).not.toContain("refuse.example");
    } finally {
      await fixture.admin.query("alter table moti.products drop constraint share_test_refuses");
    }
    expect(await counts()).toEqual({ products: 0, jobs: 0 });
  });

  it("폐기는 진행 중인 담기가 끝나기를 기다리고, 폐기 뒤의 담기는 M0009다", async () => {
    const { secret, key } = await issue();
    const adding = await fixture.admin.connect();
    try {
      await adding.query("begin");
      await adding.query("set local role anon");
      const link = linkOf("https://shop.example/lamp");
      await adding.query("select public.moti_share_add($1, $2, $3, $4, $5)",
        [secret, link.p_source_url, link.p_identity_url, link.p_option, link.p_shop]);

      const revoking = rpc("moti_share_key_revoke", { p_key_id: key.id });
      await expect.poll(async () => (await fixture.admin.query<{ waiting: number }>(
        "select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and query like '%moti_share_key_revoke%'",
      )).rows[0].waiting, { timeout: 5000 }).toBe(1);
      await adding.query("commit");

      expect((await revoking).code).toBeNull();
    } finally {
      await adding.query("rollback").catch(() => undefined);
      adding.release();
    }
    expect(await counts()).toEqual({ products: 1, jobs: 1 });
    expect(await keyRow(key.id)).toMatchObject({ window_uses: 1, last_used_at: expect.any(Date) });
    expect((await add(secret, "https://shop.example/desk")).code).toBe("M0009");
    expect(await counts()).toEqual({ products: 1, jobs: 1 });
  });
});

describe("저장 키 역할의 권한", () => {
  it("익명으로 실행할 수 있는 moti 함수는 moti_share가 소유한 moti_share_add와 moti_worker가 소유한 작업 단계뿐이고 로그인 세션은 실행하지 못한다", async () => {
    const { rows } = await fixture.admin.query<{ proname: string; owner: string; prosecdef: boolean; authenticated: boolean; service: boolean }>(
      `select p.proname, r.rolname as owner, p.prosecdef,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
         has_function_privilege('service_role', p.oid, 'execute') as service
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
       where n.nspname in ('public', 'moti', 'moti_storage') and has_function_privilege('anon', p.oid, 'execute')
       order by p.proname`,
    );
    const keyOnly = (proname: string, owner: string) => ({ proname, owner, prosecdef: true, authenticated: false, service: false });
    expect(rows).toEqual([
      keyOnly("moti_share_add", "moti_share"),
      keyOnly("moti_worker_begin", "moti_worker"),
      keyOnly("moti_worker_complete", "moti_worker"),
      keyOnly("moti_worker_fail", "moti_worker"),
      keyOnly("moti_worker_finish", "moti_worker"),
      keyOnly("moti_worker_next", "moti_worker"),
      keyOnly("moti_worker_price", "moti_worker"),
    ]);
    const role = await fixture.admin.query(
      `select rolsuper, rolbypassrls, rolinherit, rolcanlogin, rolcreaterole, rolcreatedb,
         (select count(*)::int from pg_auth_members m where m.member = r.oid) as member_of
       from pg_roles r where rolname = 'moti_share'`,
    );
    expect(role.rows).toEqual([{
      rolsuper: false, rolbypassrls: false, rolinherit: false, rolcanlogin: false, rolcreaterole: false, rolcreatedb: false, member_of: 0,
    }]);
    const owned = await fixture.admin.query(
      `select p.oid::regprocedure::text as name from pg_proc p where p.proowner = 'moti_share'::regrole
       union all select c.oid::regclass::text from pg_class c where c.relowner = 'moti_share'::regrole`,
    );
    expect(owned.rows).toEqual([{ name: "moti_share_add(text,text,text,text,text)" }]);
    // Only the migration owner may act as the role (one row per grantor): a member such as authenticator would hold its grants.
    const members = await fixture.admin.query(
      `select distinct m.member::regrole::text as member from pg_auth_members m where m.roleid = 'moti_share'::regrole order by 1`,
    );
    expect(members.rows).toEqual([{ member: "postgres" }]);
  });

  it("moti_share 역할에 직접 준 권한은 추가에 필요한 것뿐이다", async () => {
    const { rows } = await fixture.admin.query<{ grant: string }>(
      `with share as (select 'moti_share'::regrole::oid as oid)
       select g.grant from (
         select format('schema %s %s', n.nspname, a.privilege_type) as grant
         from pg_namespace n, aclexplode(n.nspacl) a, share where a.grantee = share.oid
         union all
         select format('table %s %s', c.oid::regclass, a.privilege_type)
         from pg_class c, aclexplode(c.relacl) a, share where a.grantee = share.oid
         union all
         select format('column %s.%s %s', c.oid::regclass, t.attname, a.privilege_type)
         from pg_attribute t join pg_class c on c.oid = t.attrelid, aclexplode(t.attacl) a, share where a.grantee = share.oid
         union all
         select format('function %s %s', p.oid::regprocedure, a.privilege_type)
         from pg_proc p, aclexplode(p.proacl) a, share where a.grantee = share.oid and p.proowner <> share.oid
       ) g order by g.grant`,
    );
    expect(rows.map((row) => row.grant)).toEqual([
      "column moti.metadata_jobs.generation INSERT",
      "column moti.metadata_jobs.owner_id INSERT",
      "column moti.metadata_jobs.product_id INSERT",
      "column moti.owner_config.google_subject SELECT",
      "column moti.owner_config.owner_id SELECT",
      "column moti.products.id SELECT",
      "column moti.products.identity_hash SELECT",
      "column moti.products.identity_url INSERT",
      "column moti.products.identity_url SELECT",
      "column moti.products.metadata_generation SELECT",
      "column moti.products.option INSERT",
      "column moti.products.option SELECT",
      "column moti.products.owner_id INSERT",
      "column moti.products.owner_id SELECT",
      "column moti.products.shop INSERT",
      "column moti.products.source_url INSERT",
      "column moti.share_keys.id SELECT",
      "column moti.share_keys.last_used_at UPDATE",
      "column moti.share_keys.owner_id SELECT",
      "column moti.share_keys.revoked_at SELECT",
      "column moti.share_keys.token_hash SELECT",
      "column moti.share_keys.window_started_at SELECT",
      "column moti.share_keys.window_started_at UPDATE",
      "column moti.share_keys.window_uses SELECT",
      "column moti.share_keys.window_uses UPDATE",
      "function moti.add_link(uuid,text,text,text,text) EXECUTE",
      "function moti.has_google_identity(uuid,text) EXECUTE",
      "function moti.is_clean_title(text) EXECUTE",
      "function moti.is_collection_error(text) EXECUTE",
      "function moti.is_image_error(text) EXECUTE",
      "function moti.is_link_input(text,text,text,text) EXECUTE",
      "function moti.is_web_url(text,integer) EXECUTE",
      "schema extensions USAGE",
      "schema moti USAGE",
    ]);
    const policies = await fixture.admin.query<{ policy: string }>(
      `select format('%s %s %s', tablename, policyname, cmd) as policy from pg_policies
       where schemaname = 'moti' and 'moti_share' = any(roles) order by 1`,
    );
    expect(policies.rows.map((row) => row.policy)).toEqual([
      "metadata_jobs key_adds_job INSERT",
      "owner_config key_reads_owner SELECT",
      "products key_adds_product INSERT",
      "products key_reads_dedupe SELECT",
      "share_keys key_finds_active_key SELECT",
      "share_keys key_marks_use UPDATE",
    ]);
  });

  it("moti_share 역할로는 정한 권한 밖의 읽기·쓰기·함수 실행을 모두 거절한다", async () => {
    const { key } = await issue();
    const product = (await library().saveLink(toLinkSaveCommand({ url: "https://shop.example/lamp", option: "", collectionIds: [] }))).product;
    const connection = await fixture.admin.connect();
    const refused = [
      "select title from moti.products",
      "select note from moti.products",
      "select * from moti.products",
      "select id from moti.collections",
      "select product_id from moti.product_collections",
      "select status from moti.metadata_jobs",
      "select hint from moti.share_keys",
      "select singleton from moti.owner_config",
      `update moti.products set note = 'x' where id = '${product.id}'`,
      `delete from moti.products where id = '${product.id}'`,
      `update moti.share_keys set revoked_at = null where id = '${key.id}'`,
      `insert into moti.collections (owner_id, name) values ('${fixture.owner.id}', 'x')`,
      `insert into moti.share_keys (owner_id, token_hash, hint) values ('${fixture.owner.id}', '\\x00', 'abcd')`,
      "select moti.require_owner()",
      `select moti.edit_product('${fixture.owner.id}', '${product.id}', 1, 'x', '', '{}')`,
      "select public.moti_snapshot()",
      "select public.moti_share_key_read()",
      "select name from storage.objects",
    ];
    try {
      await connection.query("set role moti_share");
      for (const statement of refused) {
        await expect(connection.query(statement), statement).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await connection.query("reset role");
      connection.release();
    }
    expect((await library().snapshot()).products).toEqual([product]);
  });
});

describe("공유 담기 어댑터", () => {
  const store = () => createSupabaseShareLinkStore(fixture.anonymous);
  const command = (secret: string, url = "https://shop.example/lamp") => toShareLinkAddCommand(secret as ShareSecret, url);

  it("익명 클라이언트로 담은 결과를 종류로 돌려준다", async () => {
    const secret = parseShareSecret((await issue()).secret)!;
    expect(await store().add(command(secret))).toEqual({ kind: "added" });
    expect(await store().add(command(secret, "https://shop.example/lamp?utm_source=again"))).toEqual({ kind: "duplicate" });
    expect(await counts()).toEqual({ products: 1, jobs: 1 });
  });

  it("거절한 키·한도·잘못된 링크를 ShareError 코드로 바꾸고 메시지에 DB 문구를 싣지 않는다", async () => {
    const issued = await issue();
    await expect(store().add(command(wellFormed()))).rejects.toMatchObject({ code: "key_rejected" });
    await fixture.admin.query(
      "update moti.share_keys set window_uses = 30, window_started_at = now() where id = $1", [issued.key.id],
    );
    await expect(store().add(command(issued.secret))).rejects.toMatchObject({ code: "key_busy" });
    await fixture.admin.query("update moti.share_keys set window_uses = 0 where id = $1", [issued.key.id]);
    const forged = { secret: issued.secret as ShareSecret, link: { sourceUrl: "javascript:alert(1)", identityUrl: "javascript:alert(1)", option: "", shop: "x" } };
    const refused = await store().add(forged).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ShareError);
    expect(refused).toMatchObject({ code: "invalid_input" });
    expect((refused as Error).message).not.toMatch(/M000|invalid link input/);
  });

  it("소유자 세션 클라이언트로 부르면 저장소를 쓸 수 없다고 끝내고 아무것도 담지 않는다", async () => {
    const secret = (await issue()).secret;
    await expect(createSupabaseShareLinkStore(fixture.owner.client).add(command(secret))).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(await counts()).toEqual({ products: 0, jobs: 0 });
  });
});
