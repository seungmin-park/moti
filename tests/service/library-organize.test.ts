import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  toCollectionRenameCommand,
  toLinkSaveCommand,
  toProductChangeCommand,
  type ProductChangeInput,
} from "../../src/features/library/application/commands";
import { createLibraryService } from "../../src/features/library/application/library-service";
import type { Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const today = "2026-11-13";
const service = (client = fixture.owner.client) => createLibraryService(createSupabaseLibraryStore(client));
const change = async (product: Product, revision: number, input: ProductChangeInput["change"]) =>
  service().changeProduct(toProductChangeCommand(product.id, { revision, change: input }, today));
const reread = async (product: Product) => (await service().snapshot()).products.find((item) => item.id === product.id)!;

async function saved(collectionIds: string[] = []) {
  return (await service().saveLink(toLinkSaveCommand({ url: `https://shop.example/${randomUUID()}`, option: "", collectionIds }))).product;
}

describe("실제 저장소를 쓰는 상품 정리 서비스", () => {
  it("이름·메모·컬렉션을 고친 뒤 구매·되돌리기·다시 구매·구매 기록·위시 복귀를 거쳐도 메모와 컬렉션이 남는다", async () => {
    const desk = await service().createCollection({ name: "책상" });
    const gift = await service().createCollection({ name: "선물" });
    const product = await saved([desk.id]);
    const kept = { title: "책상 조명", note: "생일 선물로", collectionIds: [gift.id] };

    let current = await change(product, 1, { type: "details", ...kept, collectionIds: [gift.id.toUpperCase()] });
    expect(current).toMatchObject({ ...kept, revision: 2 });
    for (const step of [
      { type: "purchase" },
      { type: "wish" },
      { type: "purchase" },
      { type: "purchase.record", date: "2026-11-01", price: { amountMinor: 0, currency: "KRW" } },
    ] satisfies ProductChangeInput["change"][]) {
      current = await change(product, current.revision, step);
      expect(await reread(product)).toEqual(current);
      expect(current).toMatchObject(kept);
    }
    expect(current.purchase).toEqual({ status: "purchased", date: "2026-11-01", price: { amountMinor: 0, currency: "KRW" } });

    current = await change(product, current.revision, { type: "wish" });
    expect(await reread(product)).toMatchObject({ ...kept, revision: 7, purchase: { status: "wish" } });
  });

  it("컬렉션 이름을 바꾸면 새로 읽은 보관함에서 같은 상품이 새 이름 아래에 있다", async () => {
    const desk = await service().createCollection({ name: "책상" });
    const product = await saved([desk.id]);

    const renamed = await service().renameCollection(toCollectionRenameCommand(desk.id, { revision: 1, name: " 작업 공간 " }));

    expect(renamed).toMatchObject({ id: desk.id, name: "작업 공간", revision: 2 });
    const library = await service().snapshot();
    expect(library.collections).toEqual([renamed]);
    expect(library.products.find((item) => item.id === product.id)?.collectionIds).toEqual([desk.id]);
  });

  it("다른 곳에서 먼저 바뀐 상품을 오래된 revision으로 고치면 revision_conflict이고 저장된 값은 그대로다", async () => {
    const product = await saved();
    const first = await change(product, 1, { type: "details", title: null, note: "먼저 저장", collectionIds: [] });

    await expect(change(product, 1, { type: "details", title: null, note: "늦은 저장", collectionIds: [] }))
      .rejects.toMatchObject({ code: "revision_conflict" });
    await expect(change(product, 1, { type: "purchase" })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await reread(product)).toEqual(first);
  });

  it.each([
    ["공백뿐인 이름", "title", { type: "details", title: " ", note: "", collectionIds: [] }],
    ["3001자 메모", "note", { type: "details", title: null, note: "가".repeat(3001), collectionIds: [] }],
    ["UUID가 아닌 컬렉션", "collection", { type: "details", title: null, note: "", collectionIds: ["not-a-uuid"] }],
    ["미래 구매일", "date", { type: "purchase.record", date: "2999-01-01", price: null }],
    ["원화가 아닌 실구매가", "price", { type: "purchase.record", date: null, price: { amountMinor: 1000, currency: "USD" } }],
  ] satisfies [string, string, ProductChangeInput["change"]][])("업무 규칙에 맞지 않는 %s는 %s 칸의 입력 오류이고 저장하지 않는다", async (_, field, input) => {
    const product = await saved();
    const purchased = await change(product, 1, { type: "purchase" });
    await expect(change(product, 2, input)).rejects.toMatchObject({ code: "invalid_input", field });
    expect(await reread(product)).toEqual(purchased);
  });

  it("다른 소유자의 컬렉션을 넣으면 collection_missing이고 소속은 그대로다", async () => {
    const product = await saved();
    const foreign = await fixture.admin.query<{ id: string }>(
      "insert into moti.collections (owner_id, name) values ($1, '다른 소유자') returning id", [fixture.stranger.id],
    );
    await expect(change(product, 1, { type: "details", title: null, note: "", collectionIds: [foreign.rows[0].id] }))
      .rejects.toMatchObject({ code: "collection_missing" });
    expect(await reread(product)).toEqual(product);
  });

  it("허용하지 않은 사용자는 서비스에서도 상품과 컬렉션을 정리하지 못한다", async () => {
    const desk = await service().createCollection({ name: "책상" });
    const product = await saved([desk.id]);
    const denied = service(fixture.stranger.client);

    await expect(denied.changeProduct(toProductChangeCommand(product.id, { revision: 1, change: { type: "purchase" } }, today)))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(denied.renameCollection(toCollectionRenameCommand(desk.id, { revision: 1, name: "가져가기" })))
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(await reread(product)).toEqual(product);
  });
});
