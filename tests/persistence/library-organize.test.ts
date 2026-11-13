import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Collection, Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore, productRowSchema, toProduct } from "../../src/features/library/infrastructure/supabase-library-store";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const library = () => createSupabaseLibraryStore(fixture.owner.client);

async function saved(collectionIds: string[] = []): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({ url: `https://shop.example/${randomUUID()}`, option: "", collectionIds }))).product;
}

async function rpc(name: string, parameters: Record<string, unknown>, client: SupabaseClient = fixture.owner.client) {
  const { data, error } = await client.rpc(name, parameters);
  return { data, code: error?.code ?? null };
}

async function changed(name: string, parameters: Record<string, unknown>): Promise<Product> {
  const { data, code } = await rpc(name, parameters);
  if (code) throw new Error(`${name} 실패: ${code}`);
  return toProduct(productRowSchema.parse(data));
}

type Details = { title?: string | null; note: string; collectionIds: string[] };
const edit = (product: Product, revision: number, { title = null, note, collectionIds }: Details) =>
  ({ p_product_id: product.id, p_revision: revision, p_title: title, p_note: note, p_collection_ids: collectionIds });
const at = (product: Product, revision: number) => ({ p_product_id: product.id, p_revision: revision });
const record = (product: Product, revision: number, date: string | null, amount: number | null, currency: string | null = amount === null ? null : "KRW") =>
  ({ ...at(product, revision), p_date: date, p_amount_minor: amount, p_currency: currency });
const rename = (collection: Collection, revision: number, name: string) =>
  ({ p_collection_id: collection.id, p_revision: revision, p_name: name });

async function current(product: Product): Promise<Product> {
  return (await library().snapshot()).products.find((item) => item.id === product.id)!;
}

async function columns(product: Product) {
  const { rows } = await fixture.admin.query<{ title: string; owner_title: string | null; revision: number }>(
    "select title, owner_title, revision from moti.products where id = $1", [product.id],
  );
  return rows[0];
}

const seoulDay = (offsetDays: number) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("상품 정리: 이름·메모·컬렉션", () => {
  it("이름·메모·컬렉션을 한 번에 고치면 revision과 수정 시각이 바뀌고 새로 읽어도 같다", async () => {
    const desk = await library().createCollection({ name: "책상" });
    const gift = await library().createCollection({ name: "선물" });
    const product = await saved([desk.id]);

    const edited = await changed("moti_edit_product", edit(product, 1, {
      title: "책상 조명", note: "선물용\n사이즈 확인", collectionIds: [gift.id, gift.id],
    }));

    expect(edited).toMatchObject({ title: "책상 조명", note: "선물용\n사이즈 확인", collectionIds: [gift.id], revision: 2 });
    expect(Date.parse(edited.updatedAt)).toBeGreaterThan(Date.parse(product.updatedAt));
    expect(await current(product)).toEqual(edited);
    expect(await columns(product)).toEqual({ title: "새로 담은 상품", owner_title: "책상 조명", revision: 2 });
  });

  it("이름을 보내지 않거나 보이는 이름과 같으면 소유자 이름을 정하지 않는다", async () => {
    const product = await saved();

    const noted = await changed("moti_edit_product", edit(product, 1, { note: "메모", collectionIds: [] }));
    const same = await changed("moti_edit_product", edit(product, 2, { title: "새로 담은 상품", note: "메모", collectionIds: [] }));

    expect(noted).toMatchObject({ title: "새로 담은 상품", note: "메모", revision: 2 });
    expect(same).toEqual(noted);
    expect(await columns(product)).toEqual({ title: "새로 담은 상품", owner_title: null, revision: 2 });
  });

  it("소유자가 이름을 고친 뒤 수집이 끝나도 고친 이름을 보이고 수집한 이름은 따로 남으며 revision은 그대로다", async () => {
    const fixed = await saved();
    const untouched = await saved();
    await changed("moti_edit_product", edit(fixed, 1, { title: "내가 붙인 이름", note: "", collectionIds: [] }));
    const jobs = createSupabaseCollectionStore(fixture.owner.client);
    for (const product of [fixed, untouched]) {
      const claim = await jobs.claim({ productId: product.id, generation: 1 });
      if (claim.kind !== "claimed") throw new Error("작업을 맡지 못했습니다.");
      await jobs.complete(claim.job, { title: "무선 헤드폰", price: null, imageSourceUrl: null }, { outcome: "absent" });
    }

    expect(await current(fixed)).toMatchObject({ title: "내가 붙인 이름", revision: 2, metadata: { phase: "ready" } });
    expect(await columns(fixed)).toEqual({ title: "무선 헤드폰", owner_title: "내가 붙인 이름", revision: 2 });
    expect(await current(untouched)).toMatchObject({ title: "무선 헤드폰", revision: 1 });
  });

  it("없는 컬렉션이나 다른 소유자의 컬렉션을 섞으면 M0003이고 소속과 메모를 바꾸지 않는다", async () => {
    const desk = await library().createCollection({ name: "책상" });
    const product = await saved([desk.id]);
    const foreign = await fixture.admin.query<{ id: string }>(
      "insert into moti.collections (owner_id, name) values ($1, '다른 소유자') returning id", [fixture.stranger.id],
    );

    for (const other of [randomUUID(), foreign.rows[0].id]) {
      expect((await rpc("moti_edit_product", edit(product, 1, { note: "바뀌면 안 됨", collectionIds: [desk.id, other] }))).code)
        .toBe("M0003");
    }
    expect(await current(product)).toEqual(product);
  });

  it("다른 소유자의 상품이나 없는 상품은 M0006이다", async () => {
    const foreign = await fixture.admin.query<{ id: string }>(
      `insert into moti.products (owner_id, source_url, identity_url, shop)
       values ($1, 'https://shop.example/other', 'https://shop.example/other', 'shop.example') returning id`,
      [fixture.stranger.id],
    );
    for (const id of [foreign.rows[0].id, randomUUID()]) {
      const product = { id } as Product;
      expect((await rpc("moti_edit_product", edit(product, 1, { note: "", collectionIds: [] }))).code).toBe("M0006");
      expect((await rpc("moti_purchase_product", at(product, 1))).code).toBe("M0006");
      expect((await rpc("moti_record_purchase", record(product, 1, null, null))).code).toBe("M0006");
      expect((await rpc("moti_return_to_wish", at(product, 1))).code).toBe("M0006");
    }
    const { rows } = await fixture.admin.query("select note, revision, purchase_status from moti.products where id = $1", [foreign.rows[0].id]);
    expect(rows).toEqual([{ note: "", revision: 1, purchase_status: "wish" }]);
  });

  it.each([
    ["앞뒤 공백 이름", { p_title: " 조명 " }],
    ["빈 이름", { p_title: "" }],
    ["121자 이름", { p_title: "가".repeat(121) }],
    ["제어 문자 이름", { p_title: "조명\u0007" }],
    ["NFC가 아닌 이름", { p_title: "가방".normalize("NFD") }],
    ["3001자 메모", { p_note: "가".repeat(3001) }],
    ["메모 없음", { p_note: null }],
    ["컬렉션 목록 없음", { p_collection_ids: null }],
    ["비어 있는 컬렉션 ID", { p_collection_ids: [null] }],
    ["101개 컬렉션", { p_collection_ids: Array.from({ length: 101 }, () => randomUUID()) }],
    ["0 revision", { p_revision: 0 }],
  ])("클라이언트 검증을 거치지 않은 %s 수정은 M0002이고 아무것도 쓰지 않는다", async (_, override) => {
    const product = await saved();
    expect((await rpc("moti_edit_product", { ...edit(product, 1, { note: "", collectionIds: [] }), ...override })).code).toBe("M0002");
    expect(await current(product)).toEqual(product);
  });
});

describe("상품 정리: 구매 기록", () => {
  it("구매완료·구매 기록·위시로 되돌리기를 거쳐도 이름·메모·컬렉션은 그대로고 단계마다 revision이 오른다", async () => {
    const desk = await library().createCollection({ name: "책상" });
    const product = await saved();
    const kept = { title: "책상 조명", note: "선물용", collectionIds: [desk.id] };
    await changed("moti_edit_product", edit(product, 1, kept));

    const purchased = await changed("moti_purchase_product", at(product, 2));
    expect(purchased).toMatchObject({ ...kept, revision: 3, purchase: { status: "purchased", date: null, price: null } });

    const recorded = await changed("moti_record_purchase", record(product, 3, "2026-11-01", 0));
    expect(recorded).toMatchObject({ ...kept, revision: 4, purchase: { status: "purchased", date: "2026-11-01", price: { amountMinor: 0, currency: "KRW" } } });
    expect(await current(product)).toEqual(recorded);

    const cleared = await changed("moti_record_purchase", record(product, 4, null, null));
    expect(cleared).toMatchObject({ ...kept, revision: 5, purchase: { status: "purchased", date: null, price: null } });

    await changed("moti_record_purchase", record(product, 5, "2026-11-02", 289000));
    const wish = await changed("moti_return_to_wish", at(product, 6));
    expect(wish).toMatchObject({ ...kept, revision: 7, purchase: { status: "wish" } });
    expect(await current(product)).toEqual(wish);
    const { rows } = await fixture.admin.query(
      "select purchased_on, purchased_amount_minor, purchased_currency from moti.products where id = $1", [product.id],
    );
    expect(rows).toEqual([{ purchased_on: null, purchased_amount_minor: null, purchased_currency: null }]);
  });

  it("위시 상품의 구매 기록은 지금 revision이면 M0002, 오래된 revision이면 M0008이다", async () => {
    const product = await saved();
    expect((await rpc("moti_record_purchase", record(product, 1, "2026-11-01", 1000))).code).toBe("M0002");
    await changed("moti_edit_product", edit(product, 1, { note: "다른 탭", collectionIds: [] }));
    expect((await rpc("moti_record_purchase", record(product, 1, "2026-11-01", 1000))).code).toBe("M0008");
    expect((await current(product)).purchase).toEqual({ status: "wish" });
  });

  it.each([
    ["서울 기준 내일", () => ({ p_date: seoulDay(1) })],
    ["1900년 이전", () => ({ p_date: "1899-12-31" })],
    ["원화가 아닌 통화", () => ({ p_amount_minor: 1000, p_currency: "USD" })],
    ["음수 금액", () => ({ p_amount_minor: -1, p_currency: "KRW" })],
    ["안전한 정수를 넘는 금액", () => ({ p_amount_minor: 9007199254740992, p_currency: "KRW" })],
    ["통화 없는 금액", () => ({ p_amount_minor: 1000, p_currency: null })],
    ["금액 없는 통화", () => ({ p_amount_minor: null, p_currency: "KRW" })],
  ])("%s 기록은 M0002이고 아무것도 쓰지 않는다", async (_, override) => {
    const product = await saved();
    const purchased = await changed("moti_purchase_product", at(product, 1));
    expect((await rpc("moti_record_purchase", { ...record(product, 2, null, null), ...override() })).code).toBe("M0002");
    expect(await current(product)).toEqual(purchased);
  });

  it("서울 기준 오늘은 구매일로 받는다", async () => {
    const product = await saved();
    await changed("moti_purchase_product", at(product, 1));
    const recorded = await changed("moti_record_purchase", record(product, 2, seoulDay(0), null));
    expect(recorded.purchase).toEqual({ status: "purchased", date: seoulDay(0), price: null });
  });
});

describe("상품 정리: 같은 값과 오래된 revision", () => {
  it("이미 저장된 값과 같은 변경은 오래된 revision이어도 성공하고 revision과 수정 시각을 바꾸지 않는다", async () => {
    const desk = await library().createCollection({ name: "책상" });
    const product = await saved();
    const details = { title: "조명", note: "메모", collectionIds: [desk.id] };
    await changed("moti_edit_product", edit(product, 1, details));
    await changed("moti_purchase_product", at(product, 2));
    const latest = await changed("moti_record_purchase", record(product, 3, "2026-11-01", 0));

    expect(await changed("moti_edit_product", edit(product, 1, details))).toEqual(latest);
    expect(await changed("moti_purchase_product", at(product, 1))).toEqual(latest);
    expect(await changed("moti_record_purchase", record(product, 1, "2026-11-01", 0))).toEqual(latest);
    expect(await current(product)).toEqual(latest);

    const wish = await changed("moti_return_to_wish", at(product, 4));
    expect(await changed("moti_return_to_wish", at(product, 1))).toEqual(wish);
  });

  it("오래된 revision으로 다른 값을 보내면 M0008이고 아무것도 쓰지 않는다", async () => {
    const desk = await library().createCollection({ name: "책상" });
    const product = await saved([desk.id]);
    const latest = await changed("moti_edit_product", edit(product, 1, { note: "먼저 저장", collectionIds: [desk.id] }));

    expect((await rpc("moti_edit_product", edit(product, 1, { title: "늦은 이름", note: "늦은 메모", collectionIds: [] }))).code).toBe("M0008");
    expect((await rpc("moti_purchase_product", at(product, 1))).code).toBe("M0008");
    expect(await current(product)).toEqual(latest);

    const purchased = await changed("moti_purchase_product", at(product, 2));
    expect((await rpc("moti_record_purchase", record(product, 2, "2026-11-01", 0))).code).toBe("M0008");
    expect((await rpc("moti_return_to_wish", at(product, 2))).code).toBe("M0008");
    expect(await current(product)).toEqual(purchased);
  });

  it("같은 revision으로 동시에 12번 고치면 하나만 커밋하고 나머지는 M0008이다", async () => {
    const product = await saved();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      rpc("moti_edit_product", edit(product, 1, { note: `메모 ${index}`, collectionIds: [] }))));

    expect(results.filter((result) => result.code === null)).toHaveLength(1);
    expect(results.filter((result) => result.code === "M0008")).toHaveLength(11);
    expect((await columns(product)).revision).toBe(2);
  });
});

describe("컬렉션 이름 바꾸기", () => {
  async function names() {
    const { rows } = await fixture.admin.query<{ name: string; revision: number }>(
      "select name, revision from moti.collections where owner_id = $1 order by created_at, id", [fixture.owner.id],
    );
    return rows;
  }

  it("이름을 바꾸면 revision이 오르고 소속 상품은 그대로다", async () => {
    const desk = await library().createCollection({ name: "책상" });
    const product = await saved([desk.id]);

    const { data, code } = await rpc("moti_rename_collection", rename(desk, 1, "작업 공간"));

    expect(code).toBeNull();
    expect(data).toMatchObject({ id: desk.id, name: "작업 공간", revision: 2 });
    expect((await library().snapshot()).collections).toEqual([expect.objectContaining({ id: desk.id, name: "작업 공간", revision: 2 })]);
    expect((await current(product)).collectionIds).toEqual([desk.id]);
  });

  it("대소문자만 바꾼 자기 이름은 받고, 다른 컬렉션과 대소문자만 다른 이름은 M0004다", async () => {
    const desk = await library().createCollection({ name: "Desk" });
    const room = await library().createCollection({ name: "Room" });

    expect((await rpc("moti_rename_collection", rename(desk, 1, "desk"))).code).toBeNull();
    expect((await rpc("moti_rename_collection", rename(room, 1, "DESK"))).code).toBe("M0004");
    expect(await names()).toEqual([{ name: "desk", revision: 2 }, { name: "Room", revision: 1 }]);
  });

  it("같은 이름은 오래된 revision이어도 바꾸지 않고, 다른 이름은 M0008이다", async () => {
    const desk = await library().createCollection({ name: "책상" });
    await rpc("moti_rename_collection", rename(desk, 1, "작업 공간"));

    expect((await rpc("moti_rename_collection", rename(desk, 1, "작업 공간"))).data).toMatchObject({ name: "작업 공간", revision: 2 });
    expect((await rpc("moti_rename_collection", rename(desk, 1, "늦은 이름"))).code).toBe("M0008");
    expect(await names()).toEqual([{ name: "작업 공간", revision: 2 }]);
  });

  it("없는 컬렉션이나 다른 소유자의 컬렉션은 M0003이다", async () => {
    const foreign = await fixture.admin.query<{ id: string }>(
      "insert into moti.collections (owner_id, name) values ($1, '다른 소유자') returning id", [fixture.stranger.id],
    );
    for (const id of [randomUUID(), foreign.rows[0].id]) {
      expect((await rpc("moti_rename_collection", rename({ id } as Collection, 1, "가져가기"))).code).toBe("M0003");
    }
    const { rows } = await fixture.admin.query("select name from moti.collections where id = $1", [foreign.rows[0].id]);
    expect(rows).toEqual([{ name: "다른 소유자" }]);
  });

  it.each([" 책상", "", "가".repeat(41), null, "가방".normalize("NFD")])("유효하지 않은 이름 %j은 M0002다", async (name) => {
    const desk = await library().createCollection({ name: "책상" });
    expect((await rpc("moti_rename_collection", rename(desk, 1, name as string))).code).toBe("M0002");
    expect(await names()).toEqual([{ name: "책상", revision: 1 }]);
  });
});

describe("정리 RPC의 소유자 경계", () => {
  it.each(["anonymous", "stranger"] as const)("%s는 다섯 정리 RPC를 실행하지 못하고 아무것도 바뀌지 않는다", async (who) => {
    const desk = await library().createCollection({ name: "책상" });
    const product = await saved([desk.id]);
    const client = who === "anonymous" ? fixture.anonymous : fixture.stranger.client;
    const denied = who === "anonymous" ? "42501" : "M0001";

    expect((await rpc("moti_edit_product", edit(product, 1, { note: "x", collectionIds: [] }), client)).code).toBe(denied);
    expect((await rpc("moti_purchase_product", at(product, 1), client)).code).toBe(denied);
    expect((await rpc("moti_record_purchase", record(product, 1, null, null), client)).code).toBe(denied);
    expect((await rpc("moti_return_to_wish", at(product, 1), client)).code).toBe(denied);
    expect((await rpc("moti_rename_collection", rename(desk, 1, "가져가기"), client)).code).toBe(denied);
    expect(await current(product)).toEqual(product);
    expect((await library().snapshot()).collections).toEqual([desk]);
  });
});
