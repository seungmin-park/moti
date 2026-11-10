import { createHash, randomUUID } from "node:crypto";
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

const command = (url = "https://example.com/item?size=M", option = "", collectionIds: string[] = []) =>
  toLinkSaveCommand({ url, option, collectionIds });
const store = () => createSupabaseLibraryStore(fixture.owner.client);

async function storedCounts() {
  const { rows } = await fixture.admin.query<{ products: number; memberships: number; jobs: number }>(
    `select
      (select count(*)::int from moti.products where owner_id = $1) as products,
      (select count(*)::int from moti.product_collections where owner_id = $1) as memberships,
      (select count(*)::int from moti.metadata_jobs where owner_id = $1) as jobs`,
    [fixture.owner.id],
  );
  return rows[0];
}

describe("실제 Supabase 저장소", () => {
  it("새 소유자의 보관함을 빈 도메인 값으로 읽는다", async () => {
    expect(await store().snapshot()).toEqual({ products: [], collections: [] });
  });

  it("링크, 선택 컬렉션과 초기 수집 작업을 함께 커밋하고 다시 읽는다", async () => {
    const first = await store().createCollection({ name: "책상" });
    const second = await store().createCollection({ name: "생일 선물" });
    const result = await store().saveLink(command(
      "https://example.com/item?size=M&utm_source=one#blue", "블랙", [first.id, second.id],
    ));

    expect(result.kind).toBe("added");
    expect(result.product).toMatchObject({
      sourceUrl: "https://example.com/item?size=M&utm_source=one#blue",
      identityUrl: "https://example.com/item?size=M#blue",
      option: "블랙",
      revision: 1,
      note: "",
      purchase: { status: "wish" },
      metadata: { phase: "queued", generation: 1, attempts: 0 },
      lastSuccessfulPrice: null,
    });
    expect(result.product.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.product.collectionIds.toSorted()).toEqual([first.id, second.id].toSorted());
    expect(Number.isNaN(Date.parse(result.product.addedAt))).toBe(false);
    expect(await storedCounts()).toEqual({ products: 1, memberships: 2, jobs: 1 });
    const jobs = await fixture.admin.query(
      "select product_id, generation, status from moti.metadata_jobs where owner_id = $1", [fixture.owner.id],
    );
    expect(jobs.rows).toEqual([{ product_id: result.product.id, generation: 1, status: "queued" }]);
    const reconnected = createSupabaseLibraryStore(fixture.owner.client);
    expect((await reconnected.snapshot()).products).toEqual([result.product]);
  });

  it("중복은 기존 원문, 메모, 컬렉션과 revision을 바꾸지 않는다", async () => {
    const first = await store().createCollection({ name: "원래 묶음" });
    const second = await store().createCollection({ name: "새 묶음" });
    const saved = await store().saveLink(command("https://example.com/item?size=M&utm_source=one", "가", [first.id]));
    await fixture.admin.query("update moti.products set note = $1 where id = $2", ["기억할 메모", saved.product.id]);
    const before = (await store().snapshot()).products[0];

    const duplicate = await store().saveLink(command("https://example.com/item?utm_medium=two&size=M", " 가 ", [second.id]));

    expect(duplicate).toEqual({ kind: "duplicate", product: before });
    expect(await storedCounts()).toEqual({ products: 1, memberships: 1, jobs: 1 });
    expect((await store().snapshot()).products).toEqual([before]);
  });

  it("동시 재요청 12개가 상품과 초기 작업을 하나씩만 만든다", async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      store().saveLink(command(`https://example.com/item?size=M&utm_source=${index}`, "블랙")),
    ));

    expect(responses.filter((result) => result.kind === "added")).toHaveLength(1);
    expect(responses.filter((result) => result.kind === "duplicate")).toHaveLength(11);
    expect(new Set(responses.map((result) => result.product.id)).size).toBe(1);
    expect(await storedCounts()).toEqual({ products: 1, memberships: 0, jobs: 1 });
  });

  it("옵션, 옵션 query와 fragment가 다르면 별도 상품으로 저장한다", async () => {
    await store().saveLink(command("https://example.com/item?size=M#red", "블랙"));
    await store().saveLink(command("https://example.com/item?size=M#red", "화이트"));
    await store().saveLink(command("https://example.com/item?size=L#red", "블랙"));
    await store().saveLink(command("https://example.com/item?size=M#blue", "블랙"));

    expect(await storedCounts()).toEqual({ products: 4, memberships: 0, jobs: 4 });
  });

  it("4096자 URL과 120자 옵션을 인덱스 크기 오류 없이 저장한다", async () => {
    const prefix = "https://example.com/item?variant=";
    const url = prefix + "x".repeat(4096 - prefix.length);
    const result = await store().saveLink(command(url, "가".repeat(120)));
    expect(result.product.sourceUrl).toBe(url);
    expect((await store().snapshot()).products[0]).toEqual(result.product);
  });

  it("길이로 구분한 원문과 옵션에서 generated SHA256을 계산한다", async () => {
    const first = await store().saveLink(command("https://example.com/a", "bc"));
    const second = await store().saveLink(command("https://example.com/ab", "c"));
    const { rows } = await fixture.admin.query<{ id: string; hash: string; generated: string }>(
      `select p.id, encode(p.identity_hash, 'hex') as hash, a.attgenerated as generated
       from moti.products p
       cross join pg_attribute a
       where p.owner_id = $1 and a.attrelid = 'moti.products'::regclass and a.attname = 'identity_hash'`,
      [fixture.owner.id],
    );
    expect(rows).toHaveLength(2);
    for (const { product } of [first, second]) {
      const expected = createHash("sha256")
        .update(`${[...product.identityUrl].length}:${product.identityUrl}${product.option}`)
        .digest("hex");
      expect(rows.find((row) => row.id === product.id)).toEqual({ id: product.id, hash: expected, generated: "s" });
    }
    expect(rows[0].hash).not.toBe(rows[1].hash);
  });

  it("없는 컬렉션을 섞으면 상품과 작업을 일부만 남기지 않는다", async () => {
    const collection = await store().createCollection({ name: "유효한 컬렉션" });
    await expect(store().saveLink(command("https://example.com/item", "", [collection.id, randomUUID()])))
      .rejects.toMatchObject({ code: "collection_missing" });
    expect(await storedCounts()).toEqual({ products: 0, memberships: 0, jobs: 0 });
    expect((await store().snapshot()).collections).toEqual([collection]);
  });

  it("다른 사용자의 컬렉션을 지정하면 쓰기를 남기지 않는다", async () => {
    const foreign = await fixture.admin.query<{ id: string }>(
      "insert into moti.collections(owner_id, name) values ($1, '다른 소유자') returning id", [fixture.stranger.id],
    );
    await expect(store().saveLink(command("https://example.com/item", "", [foreign.rows[0].id])))
      .rejects.toMatchObject({ code: "collection_missing" });
    expect(await storedCounts()).toEqual({ products: 0, memberships: 0, jobs: 0 });
  });

  it("중복 요청도 유효하지 않은 컬렉션 선택을 조용히 무시하지 않는다", async () => {
    const saved = await store().saveLink(command());
    await expect(store().saveLink(command("https://example.com/item?size=M", "", [randomUUID()])))
      .rejects.toMatchObject({ code: "collection_missing" });
    expect((await store().snapshot()).products).toEqual([saved.product]);
    expect(await storedCounts()).toEqual({ products: 1, memberships: 0, jobs: 1 });
  });

  it("초기 작업 삽입이 실패하면 앞서 저장한 상품과 소속도 롤백한다", async () => {
    const collection = await store().createCollection({ name: "책상" });
    await fixture.admin.query(`
      create function moti_test.reject_initial_job() returns trigger language plpgsql as $$
      begin raise exception using errcode = 'M0099', message = 'injected initial job failure'; end $$;
      create trigger moti_test_reject_initial_job before insert on moti.metadata_jobs
      for each row execute function moti_test.reject_initial_job();
    `);
    try {
      const prepared = command("https://example.com/item", "", [collection.id]);
      const response = await fixture.owner.client.rpc("moti_save_link", {
        p_source_url: prepared.sourceUrl,
        p_identity_url: prepared.identityUrl,
        p_option: prepared.option,
        p_shop: prepared.shop,
        p_collection_ids: prepared.collectionIds,
      });
      expect(response.error?.code).toBe("M0099");
      expect(await storedCounts()).toEqual({ products: 0, memberships: 0, jobs: 0 });
    } finally {
      await fixture.admin.query("drop trigger moti_test_reject_initial_job on moti.metadata_jobs; drop function moti_test.reject_initial_job()");
    }
  });

  it("수집 실패, 마지막 성공 가격과 0원 구매 정보를 서로 독립적으로 읽는다", async () => {
    const saved = await store().saveLink(command());
    await fixture.admin.query(
      `update moti.products set metadata_phase = 'failed', metadata_error_code = 'fetch_timeout',
       metadata_attempts = 2, last_success_amount_minor = 79000, last_success_currency = 'KRW',
       last_success_at = '2026-11-10T03:00:00Z', purchase_status = 'purchased',
       purchased_on = '2026-11-11', purchased_amount_minor = 0, purchased_currency = 'KRW', revision = 2
       where id = $1`, [saved.product.id],
    );
    const product = (await store().snapshot()).products[0];
    expect(product).toMatchObject({
      revision: 2,
      metadata: { phase: "failed", generation: 1, attempts: 2, errorCode: "fetch_timeout" },
      lastSuccessfulPrice: { amountMinor: 79000, currency: "KRW", checkedAt: "2026-11-10T03:00:00.000Z" },
      purchase: { status: "purchased", date: "2026-11-11", price: { amountMinor: 0, currency: "KRW" } },
    });
    expect(product).not.toHaveProperty("owner_id");
    expect(product).not.toHaveProperty("identity_hash");
  });

  it("컬렉션 이름의 대소문자 중복도 동시 생성에서 하나만 커밋한다", async () => {
    const results = await Promise.allSettled([store().createCollection({ name: "Desk" }), store().createCollection({ name: "desk" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "collection_duplicate" } });
    expect((await store().snapshot()).collections).toHaveLength(1);
  });

  it("DB 제약이 관리자 삽입에서도 서로 다른 소유자의 소속을 거절한다", async () => {
    const saved = await store().saveLink(command());
    const foreign = await fixture.admin.query<{ id: string }>(
      "insert into moti.collections(owner_id, name) values ($1, '다른 소유자') returning id", [fixture.stranger.id],
    );
    await expect(fixture.admin.query(
      "insert into moti.product_collections(owner_id, product_id, collection_id) values ($1, $2, $3)",
      [fixture.owner.id, saved.product.id, foreign.rows[0].id],
    )).rejects.toMatchObject({ code: "23503" });
    expect(await storedCounts()).toEqual({ products: 1, memberships: 0, jobs: 1 });
  });
});
