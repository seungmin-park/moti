import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLibraryRestoreCommand, toLinkSaveCommand, type LibraryRestoreInput } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore, productRowSchema, toProduct } from "../../src/features/library/infrastructure/supabase-library-store";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { seoulToday } from "../../src/features/wishlist/product-fields";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const library = () => createSupabaseLibraryStore(fixture.owner.client);
const jobs = () => createSupabaseCollectionStore(fixture.owner.client);

async function rpc<T = unknown>(name: string, parameters: Record<string, unknown>, client: SupabaseClient = fixture.owner.client) {
  const { data, error } = await client.rpc(name, parameters);
  return { data: data as T, code: error?.code ?? null };
}

async function changed(name: string, parameters: Record<string, unknown>): Promise<Product> {
  const { data, code } = await rpc(name, parameters);
  if (code) throw new Error(`${name} 실패: ${code}`);
  return toProduct(productRowSchema.parse(data));
}

async function saved(path: string = randomUUID()): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({ url: `https://smartstore.example/${path}`, option: "", collectionIds: [] }))).product;
}

const at = (product: Product, revision: number) => ({ p_product_id: product.id, p_revision: revision });
const price = (product: Product, revision: number, amount: number | null, currency: string | null = amount === null ? null : "KRW") =>
  ({ ...at(product, revision), p_amount_minor: amount, p_currency: currency });
const setPrice = (product: Product, revision: number, amount: number | null, currency?: string | null) =>
  changed("moti_set_wish_price", price(product, revision, amount, currency));

async function current(product: Product): Promise<Product> {
  return (await library().snapshot()).products.find((item) => item.id === product.id)!;
}

async function columns(product: Product) {
  const { rows } = await fixture.admin.query<{
    wish_amount_minor: string | null; wish_currency: string | null; last_success_amount_minor: string | null; revision: number;
  }>("select wish_amount_minor, wish_currency, last_success_amount_minor, revision from moti.products where id = $1", [product.id]);
  return rows[0];
}

const krw = (amountMinor: number) => ({ amountMinor, currency: "KRW" });

describe("내가 살 가격 저장", () => {
  it("위시 상품에 가격을 저장하면 revision과 수정 시각이 바뀌고 자동 확인 가격과 따로 남으며 새로 읽어도 같다", async () => {
    const product = await saved();

    const priced = await setPrice(product, 1, 3000);

    expect(priced).toMatchObject({ revision: 2, wishPrice: krw(3000), lastSuccessfulPrice: null });
    expect(Date.parse(priced.updatedAt)).toBeGreaterThan(Date.parse(product.updatedAt));
    expect(await current(product)).toEqual(priced);
    expect(await columns(product)).toEqual({ wish_amount_minor: "3000", wish_currency: "KRW", last_success_amount_minor: null, revision: 2 });
  });

  it("null로 지우면 직접 입력한 가격이 없어지고, 0원은 빈 값과 다른 가격이다", async () => {
    const product = await saved();
    await setPrice(product, 1, 3000);

    const cleared = await setPrice(product, 2, null);
    expect(cleared).toMatchObject({ revision: 3, wishPrice: null });
    const free = await setPrice(product, 3, 0);
    expect(free).toMatchObject({ revision: 4, wishPrice: krw(0) });
  });

  it("지금 저장된 값과 같은 가격은 오래된 revision이어도 그대로 돌려주고 revision을 올리지 않는다", async () => {
    const product = await saved();
    const priced = await setPrice(product, 1, 3000);

    expect(await setPrice(product, 1, 3000)).toEqual(priced);
    const untouched = await saved();
    expect(await setPrice(untouched, 1, null)).toEqual(untouched);
  });

  it("오래된 revision으로 다른 가격을 보내면 M0008이고 아무것도 쓰지 않는다", async () => {
    const product = await saved();
    const latest = await changed("moti_edit_product", { ...at(product, 1), p_title: null, p_note: "다른 탭", p_collection_ids: [] });

    expect((await rpc("moti_set_wish_price", price(product, 1, 3000))).code).toBe("M0008");
    expect(await current(product)).toEqual(latest);
  });

  it("구매완료 상품은 지금 revision이면 M0002, 오래된 revision이면 M0008이다", async () => {
    const product = await saved();
    const purchased = await changed("moti_purchase_product", at(product, 1));

    expect((await rpc("moti_set_wish_price", price(product, 2, 3000))).code).toBe("M0002");
    expect((await rpc("moti_set_wish_price", price(product, 1, 3000))).code).toBe("M0008");
    expect(await current(product)).toEqual(purchased);
  });

  it("다른 소유자의 상품이나 없는 상품은 M0006이다", async () => {
    const foreign = await fixture.admin.query<{ id: string }>(
      `insert into moti.products (owner_id, source_url, identity_url, shop)
       values ($1, 'https://shop.example/other', 'https://shop.example/other', 'shop.example') returning id`,
      [fixture.stranger.id],
    );
    for (const id of [foreign.rows[0].id, randomUUID()]) {
      expect((await rpc("moti_set_wish_price", price({ id } as Product, 1, 3000))).code).toBe("M0006");
    }
    const { rows } = await fixture.admin.query("select wish_amount_minor, revision from moti.products where id = $1", [foreign.rows[0].id]);
    expect(rows).toEqual([{ wish_amount_minor: null, revision: 1 }]);
  });

  it.each([
    ["원화가 아닌 통화", { p_amount_minor: 1000, p_currency: "USD" }],
    ["음수 금액", { p_amount_minor: -1, p_currency: "KRW" }],
    ["안전한 정수를 넘는 금액", { p_amount_minor: 9007199254740992, p_currency: "KRW" }],
    ["통화 없는 금액", { p_amount_minor: 1000, p_currency: null }],
    ["금액 없는 통화", { p_amount_minor: null, p_currency: "KRW" }],
    ["0 revision", { p_revision: 0 }],
    ["revision 없음", { p_revision: null }],
  ])("클라이언트 검증을 거치지 않은 %s는 M0002이고 아무것도 쓰지 않는다", async (_, override) => {
    const product = await saved();
    expect((await rpc("moti_set_wish_price", { ...price(product, 1, 3000), ...override })).code).toBe("M0002");
    expect(await current(product)).toEqual(product);
  });

  it("테이블 제약도 한 쪽만 있거나 원화가 아닌 가격을 거절한다", async () => {
    const product = await saved();
    for (const assignment of ["wish_amount_minor = 1000", "wish_currency = 'KRW'", "wish_amount_minor = 1000, wish_currency = 'USD'",
      "wish_amount_minor = -1, wish_currency = 'KRW'"]) {
      await expect(fixture.admin.query(`update moti.products set ${assignment} where id = $1`, [product.id]))
        .rejects.toMatchObject({ code: "23514" });
    }
  });

  it("세션 없는 요청은 실행하지 못하고 다른 계정은 소유자가 아니라 M0001이다", async () => {
    const product = await saved();
    expect((await rpc("moti_set_wish_price", price(product, 1, 3000), fixture.anonymous)).code).toBe("42501");
    expect((await rpc("moti_set_wish_price", price(product, 1, 3000), fixture.stranger.client)).code).toBe("M0001");
    expect(await current(product)).toEqual(product);
  });
});

describe("수집·매일 확인·구매와 내가 살 가격", () => {
  it("수집과 다시 가져오기가 끝나도 직접 입력한 가격은 그대로이고 자동 확인 가격만 바뀌며 revision은 그대로다", async () => {
    const product = await saved();
    await setPrice(product, 1, 3000);
    const claim = await jobs().claim({ productId: product.id, generation: 1 });
    if (claim.kind !== "claimed") throw new Error("작업을 맡지 못했습니다.");
    await jobs().complete(claim.job, { title: "키보드 스위치", price: krw(300), imageSourceUrl: null }, { outcome: "absent" });

    expect(await current(product)).toMatchObject({ revision: 2, wishPrice: krw(3000), lastSuccessfulPrice: krw(300) });

    // A picture that could not be copied makes the product retryable, as 다시 가져오기 offers.
    await fixture.admin.query("update moti.products set metadata_image = 'failed', metadata_image_error_code = 'upload_failed' where id = $1", [product.id]);
    const retried = await jobs().retry({ productId: product.id, expectedGeneration: 1 });
    const again = await jobs().claim({ productId: product.id, generation: retried.product.metadata.generation });
    if (again.kind !== "claimed") throw new Error("다시 가져오기 작업을 맡지 못했습니다.");
    await jobs().complete(again.job, { title: "키보드 스위치", price: krw(350), imageSourceUrl: null }, { outcome: "absent" });

    expect(await current(product)).toMatchObject({ revision: 2, wishPrice: krw(3000), lastSuccessfulPrice: krw(350) });
  });

  it("작업자의 매일 가격 확인은 자동 확인 가격만 바꾸고 그 이유도 자동 확인 가격에 남는다", async () => {
    const product = await saved();
    await fixture.admin.query(
      "update moti.metadata_jobs set status = 'succeeded', attempts = 1, finished_at = now() - interval '2 days' where product_id = $1",
      [product.id],
    );
    await fixture.admin.query(
      `update moti.products set metadata_phase = 'ready', metadata_attempts = 1, metadata_completed_at = now() - interval '2 days',
         metadata_image = 'absent', last_success_amount_minor = 300, last_success_currency = 'KRW', last_success_at = now() - interval '2 days'
       where id = $1`,
      [product.id],
    );
    await setPrice(product, 1, 3000);
    const issued = await rpc<{ secret: string }>("moti_worker_key_issue", { p_replaces: null });
    const begun = await rpc<{ run: string; lease: string }>("moti_worker_begin", { p_key: issued.data.secret }, fixture.anonymous);
    const step = { p_key: issued.data.secret, p_run: begun.data.run, p_lease: begun.data.lease };
    const picked = await rpc<{ kind: string; product: string; checked_at: string }>("moti_worker_next", step, fixture.anonymous);
    expect(picked.data).toMatchObject({ kind: "price", product: product.id });

    const settled = await rpc("moti_worker_price", {
      ...step, p_product: product.id, p_checked_at: picked.data.checked_at, p_amount_minor: 320, p_currency: "KRW", p_code: null,
    }, fixture.anonymous);

    expect(settled.code).toBeNull();
    expect(await current(product)).toMatchObject({ revision: 2, wishPrice: krw(3000), lastSuccessfulPrice: krw(320), priceCheck: { code: null } });
  });

  it("구매완료로 옮기고 되돌려도 직접 입력한 가격은 그대로 남고 실구매가로 옮겨 적지 않는다", async () => {
    const product = await saved();
    await setPrice(product, 1, 3000);

    const purchased = await changed("moti_purchase_product", at(product, 2));
    expect(purchased).toMatchObject({ wishPrice: krw(3000), purchase: { status: "purchased", date: null, price: null } });
    const recorded = await changed("moti_record_purchase", { ...at(product, 3), p_date: null, p_amount_minor: 2800, p_currency: "KRW" });
    expect(recorded.wishPrice).toEqual(krw(3000));
    const wish = await changed("moti_return_to_wish", at(product, 4));
    expect(wish).toMatchObject({ wishPrice: krw(3000), purchase: { status: "wish" } });
  });

  it("이름·메모를 고쳐도 직접 입력한 가격은 그대로다", async () => {
    const product = await saved();
    await setPrice(product, 1, 3000);
    const edited = await changed("moti_edit_product", { ...at(product, 2), p_title: "스위치 10개", p_note: "메모", p_collection_ids: [] });
    expect(edited).toMatchObject({ title: "스위치 10개", note: "메모", wishPrice: krw(3000), revision: 3 });
  });
});

describe("백업과 복원의 내가 살 가격", () => {
  const today = () => seoulToday(new Date());
  const entry = (path: string, wishPrice?: { amountMinor: number; currency: string }): LibraryRestoreInput["products"][number] => ({
    sourceUrl: `https://smartstore.example/${path}`,
    option: "",
    collectedTitle: "키보드 스위치",
    ownerTitle: null,
    note: "",
    collections: [],
    addedAt: "2026-10-05T01:00:00.000Z",
    purchase: { status: "wish" },
    lastSuccessfulPrice: { amountMinor: 300, currency: "KRW", checkedAt: "2026-11-01T00:00:00.000Z" },
    ...(wishPrice && { wishPrice }),
  });

  it("내보내기는 직접 입력한 가격을 자동 확인 가격과 따로 담는다", async () => {
    const priced = await saved("priced");
    await saved("plain");
    await setPrice(priced, 1, 3000);

    const backup = await library().exportLibrary();
    expect(backup.products.map(({ sourceUrl, wishPrice }) => ({ sourceUrl, wishPrice })).toSorted((a, b) => a.sourceUrl.localeCompare(b.sourceUrl)))
      .toEqual([
        { sourceUrl: "https://smartstore.example/plain", wishPrice: null },
        { sourceUrl: "https://smartstore.example/priced", wishPrice: krw(3000) },
      ]);
  });

  it("복원은 맞은 상품과 새 상품 모두 파일의 가격을 받고, 가격이 없는 파일(이전 백업)의 상품은 직접 입력한 가격이 없어진다", async () => {
    const kept = await saved("kept");
    const old = await saved("old");
    await setPrice(kept, 1, 1000);
    await setPrice(old, 1, 2000);

    const result = await library().restoreLibrary(toLibraryRestoreCommand({
      collections: [],
      products: [entry("kept", krw(3000)), entry("old"), entry("new", krw(0))],
    }, today()));

    const byUrl = new Map(result.library.products.map((product) => [product.sourceUrl, product]));
    expect(byUrl.get("https://smartstore.example/kept")).toMatchObject({ id: kept.id, wishPrice: krw(3000) });
    expect(byUrl.get("https://smartstore.example/old")).toMatchObject({ id: old.id, wishPrice: null });
    expect(byUrl.get("https://smartstore.example/new")).toMatchObject({ wishPrice: krw(0), revision: 1 });
    expect((await library().snapshot()).products.map((product) => product.wishPrice).toSorted())
      .toEqual(result.library.products.map((product) => product.wishPrice).toSorted());
  });

  it("내보낸 파일로 복원하면 직접 입력한 가격이 그대로 돌아온다", async () => {
    const product = await saved("round");
    await setPrice(product, 1, 3000);
    const backup = await library().exportLibrary();
    await setPrice(product, 2, null);

    const result = await library().restoreLibrary({ backup });

    expect(result.library.products[0].wishPrice).toEqual(krw(3000));
  });

  it.each([
    ["원화가 아닌 가격", { wish_amount_minor: 3000, wish_currency: "USD" }],
    ["음수 가격", { wish_amount_minor: -1, wish_currency: "KRW" }],
    ["통화 없는 가격", { wish_amount_minor: 3000, wish_currency: null }],
    ["소수 가격", { wish_amount_minor: 1.5, wish_currency: "KRW" }],
  ])("앱을 거치지 않은 복원 입력의 %s은 M0002이고 보관함을 바꾸지 않는다", async (_, wish) => {
    const product = await saved("before");
    const before = await library().snapshot();
    const response = await rpc("moti_restore_library", {
      p_collections: [],
      p_products: [{
        source_url: "https://smartstore.example/file", identity_url: "https://smartstore.example/file", option: "", shop: "smartstore.example",
        title: "키보드 스위치", owner_title: null, note: "", collection_names: [], created_at: "2026-10-05T01:00:00.000Z",
        purchase_status: "wish", purchased_on: null, purchased_amount_minor: null, purchased_currency: null,
        last_success_amount_minor: null, last_success_currency: null, last_success_at: null, ...wish,
      }],
    });
    expect(response.code).toBe("M0002");
    expect(await library().snapshot()).toEqual(before);
    expect(await current(product)).toEqual(product);
  });
});
