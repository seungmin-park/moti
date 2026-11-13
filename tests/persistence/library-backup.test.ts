import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const library = () => createSupabaseLibraryStore(fixture.owner.client);

async function saved(url: string, option: string, collectionIds: string[] = []): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({ url, option, collectionIds }))).product;
}

async function collected(product: Product, title: string, amountMinor: number | null) {
  const jobs = createSupabaseCollectionStore(fixture.owner.client);
  const claim = await jobs.claim({ productId: product.id, generation: product.metadata.generation });
  if (claim.kind !== "claimed") throw new Error("작업을 맡지 못했습니다.");
  const price = amountMinor === null ? null : { amountMinor, currency: "KRW" };
  await jobs.complete(claim.job, { title, price, imageSourceUrl: null }, { outcome: "absent" });
}

describe("백업 내보내기", () => {
  it("보이는 값과 소유자가 정한 값을 수집한 이름·소유자 이름을 나눠, 소속은 컬렉션 이름으로 돌려준다", async () => {
    const living = await library().createCollection({ name: "거실" });
    const desk = await library().createCollection({ name: "Desk" });
    const table = await saved("https://shop.example/table?utm_source=x", "블랙 / M", [desk.id, living.id]);
    const lamp = await saved("https://www.shop.example/lamp", "");
    await collected(table, "오크 사이드 테이블", null);
    await collected(lamp, "무드등", 129000);
    await library().changeProduct({
      productId: table.id, revision: 1, change: { type: "details", title: "내 테이블", note: "  선물용\n사이즈 확인  ", collectionIds: [living.id, desk.id] },
    });
    await library().changeProduct({ productId: table.id, revision: 2, change: { type: "purchase" } });
    await library().changeProduct({
      productId: table.id, revision: 3, change: { type: "purchase.record", date: null, price: { amountMinor: 0, currency: "KRW" } },
    });
    await fixture.admin.query(
      `insert into moti.products (owner_id, source_url, identity_url, shop) values ($1, 'https://other.example/x', 'https://other.example/x', 'other.example')`,
      [fixture.stranger.id],
    );
    const snapshot = await library().snapshot();
    const shown = (product: Product) => snapshot.products.find((item) => item.id === product.id)!;

    const backup = await library().exportLibrary();

    expect(backup).toEqual({
      collections: [
        { name: "거실", createdAt: living.createdAt },
        { name: "Desk", createdAt: desk.createdAt },
      ],
      products: [
        {
          sourceUrl: "https://www.shop.example/lamp",
          identityUrl: "https://www.shop.example/lamp",
          option: "",
          shop: "shop.example",
          collectedTitle: "무드등",
          ownerTitle: null,
          note: "",
          collectionNames: [],
          addedAt: lamp.addedAt,
          purchase: { status: "wish" },
          lastSuccessfulPrice: { amountMinor: 129000, currency: "KRW", checkedAt: shown(lamp).lastSuccessfulPrice!.checkedAt },
        },
        {
          sourceUrl: "https://shop.example/table?utm_source=x",
          identityUrl: "https://shop.example/table",
          option: "블랙 / M",
          shop: "shop.example",
          collectedTitle: "오크 사이드 테이블",
          ownerTitle: "내 테이블",
          note: "  선물용\n사이즈 확인  ",
          collectionNames: ["거실", "Desk"],
          addedAt: table.addedAt,
          purchase: { status: "purchased", date: null, price: { amountMinor: 0, currency: "KRW" } },
          lastSuccessfulPrice: null,
        },
      ],
    });
    expect(shown(table).title).toBe("내 테이블");
  });

  it("빈 보관함은 빈 목록이다", async () => {
    expect(await library().exportLibrary()).toEqual({ collections: [], products: [] });
  });

  it("다른 계정과 익명은 내보낼 수 없다", async () => {
    await saved("https://shop.example/private", "");

    expect((await fixture.stranger.client.rpc("moti_backup")).error?.code).toBe("M0001");
    expect((await fixture.anonymous.rpc("moti_backup")).error?.code).toBe("42501");
    await expect(createSupabaseLibraryStore(fixture.stranger.client).exportLibrary()).rejects.toMatchObject({ code: "unauthorized" });
  });
});
