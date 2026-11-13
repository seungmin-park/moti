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

const prepared = () => toLinkSaveCommand({ url: "https://example.com/item", option: "", collectionIds: [] });

describe("실제 DB 소유자 경계", () => {
  it.each(["anonymous", "stranger", "missing_config", "missing_google", "wrong_subject"])(
    "%s 접근은 조회와 두 쓰기 명령을 모두 거절한다",
    async (scenario) => {
      if (scenario === "missing_config") {
        await fixture.admin.query("delete from moti.owner_config where owner_id = $1", [fixture.owner.id]);
      }
      if (scenario === "missing_google") {
        await fixture.admin.query("delete from auth.identities where user_id = $1 and provider = 'google'", [fixture.owner.id]);
      }
      if (scenario === "wrong_subject") {
        await fixture.admin.query("update moti.owner_config set google_subject = 'unconfigured-google-subject' where owner_id = $1", [fixture.owner.id]);
      }
      const client = scenario === "anonymous" ? fixture.anonymous
        : scenario === "stranger" ? fixture.stranger.client : fixture.owner.client;
      const store = createSupabaseLibraryStore(client);

      const raw = await client.rpc("moti_snapshot");
      expect(raw.error?.code).toBe(scenario === "anonymous" ? "42501" : "M0001");
      await expect(store.snapshot()).rejects.toMatchObject({ code: "unauthorized" });
      await expect(store.saveLink(prepared())).rejects.toMatchObject({ code: "unauthorized" });
      await expect(store.createCollection({ name: "거절할 컬렉션" })).rejects.toMatchObject({ code: "unauthorized" });
      const result = await fixture.admin.query(
        `select
          (select count(*)::int from moti.products where owner_id = any($1::uuid[])) as products,
          (select count(*)::int from moti.collections where owner_id = any($1::uuid[])) as collections,
          (select count(*)::int from moti.metadata_jobs where owner_id = any($1::uuid[])) as jobs`,
        [[fixture.owner.id, fixture.stranger.id]],
      );
      expect(result.rows).toEqual([{ products: 0, collections: 0, jobs: 0 }]);
    },
  );

  it("공개 REST에서 테이블을 노출하지 않는다", async () => {
    for (const client of [fixture.owner.client, fixture.anonymous]) {
      const privateTable = await client.schema("moti").from("products").select("id");
      expect(privateTable.data).toBeNull();
      expect(privateTable.error?.code).toBe("PGRST106");
      const publicTable = await client.from("products").select("id");
      expect(publicTable.data).toBeNull();
      expect(publicTable.error?.code).toBe("PGRST205");
    }
  });

  it("모든 저장 테이블에 FORCE RLS를 두고 RPC는 별도의 비우회 역할로 실행한다", async () => {
    const tables = await fixture.admin.query<{ relname: string; owner: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select c.relname, r.rolname as owner, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_roles r on r.oid = c.relowner where n.nspname = 'moti' and c.relkind = 'r'`,
    );
    expect(tables.rows.map((row) => row.relname).toSorted()).toEqual([
      "collections", "metadata_jobs", "owner_config", "product_collections", "products",
    ]);
    expect(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const functions = await fixture.admin.query<{
      proname: string; owner: string; rolbypassrls: boolean; rolsuper: boolean;
      prosecdef: boolean; anon_execute: boolean; authenticated_execute: boolean;
    }>(
      `select p.proname, r.rolname as owner, r.rolbypassrls, r.rolsuper, p.prosecdef,
       has_function_privilege('anon', p.oid, 'execute') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
       where n.nspname = 'public' and p.proname like 'moti_%'`,
    );
    expect(functions.rows.map((row) => row.proname).toSorted()).toEqual([
      "moti_create_collection", "moti_metadata_claim", "moti_metadata_complete", "moti_metadata_fail",
      "moti_metadata_retry", "moti_picture_locate", "moti_save_link", "moti_snapshot",
    ]);
    for (const row of functions.rows) {
      expect(row).toMatchObject({ rolbypassrls: false, rolsuper: false, prosecdef: true, anon_execute: false, authenticated_execute: true });
      expect(tables.rows.every((table) => table.owner !== row.owner)).toBe(true);
    }
  });

  it("RPC 역할로 직접 읽거나 써도 다른 소유자의 행에는 RLS가 적용된다", async () => {
    const saved = await createSupabaseLibraryStore(fixture.owner.client).saveLink(prepared());
    const connection = await fixture.admin.connect();
    try {
      await connection.query("set role moti_rpc");
      await connection.query("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ sub: fixture.owner.id, role: "authenticated" }),
      ]);
      expect((await connection.query("select id from moti.products")).rows).toEqual([{ id: saved.product.id }]);
      await connection.query("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ sub: fixture.stranger.id, role: "authenticated" }),
      ]);
      expect((await connection.query("select id from moti.products")).rows).toEqual([]);
      await expect(connection.query(
        "insert into moti.products(owner_id, source_url, identity_url, shop) values ($1, 'https://example.com/forged', 'https://example.com/forged', 'example.com')",
        [fixture.owner.id],
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await connection.query("reset role");
      await connection.query("select set_config('request.jwt.claims', '', false)");
      connection.release();
    }
  });

  it.each([
    { p_source_url: "" },
    { p_source_url: "javascript:alert(1)" },
    { p_source_url: "https://name:secret@example.com/item" },
    { p_source_url: `https://example.com/${"x".repeat(4096)}` },
    { p_identity_url: "" },
    { p_option: "x".repeat(121) },
    { p_collection_ids: null },
  ])("클라이언트 검증을 거치지 않은 RPC 입력도 DB가 거절한다: %j", async (override) => {
    const response = await fixture.owner.client.rpc("moti_save_link", {
      p_source_url: "https://example.com/item",
      p_identity_url: "https://example.com/item",
      p_option: "",
      p_shop: "example.com",
      p_collection_ids: [],
      ...override,
    });
    expect(response.error?.code).toBe("M0002");
    const rows = await fixture.admin.query("select id from moti.products where owner_id = $1", [fixture.owner.id]);
    expect(rows.rows).toEqual([]);
  });

  it("failed 수집 상태는 오류 코드가 없으면 DB가 거절한다", async () => {
    await expect(fixture.admin.query(
      `insert into moti.products(owner_id, source_url, identity_url, shop, metadata_phase, metadata_error_code)
       values ($1, 'https://example.com/invalid-state', 'https://example.com/invalid-state', 'example.com', 'failed', null)`,
      [fixture.owner.id],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it.each([" ", "가".repeat(41), null])("RPC가 유효하지 않은 컬렉션 이름 %s를 거절한다", async (name) => {
    const response = await fixture.owner.client.rpc("moti_create_collection", { p_name: name });
    expect(response.error?.code).toBe("M0002");
    expect((await fixture.admin.query("select id from moti.collections where owner_id = $1", [fixture.owner.id])).rows)
      .toEqual([]);
  });
});
