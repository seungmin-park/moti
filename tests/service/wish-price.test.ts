import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  toLibraryRestoreCommand,
  toLinkSaveCommand,
  toProductChangeCommand,
  type ProductChangeInput,
} from "../../src/features/library/application/commands";
import { createLibraryService } from "../../src/features/library/application/library-service";
import type { Product } from "../../src/features/library/domain/library";
import { createPictureStore } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { readLibraryBackup, toLibraryBackupDocument } from "../../src/features/library/presentation/library-backup";
import { createCollectionRunner, type PageSource } from "../../src/features/metadata/application/collection";
import { createPictureCopier, type ImageSource } from "../../src/features/metadata/application/picture-copy";
import { readProductPage } from "../../src/features/metadata/infrastructure/html-reader";
import { normalizePicture } from "../../src/features/metadata/infrastructure/sharp-normalizer";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { seoulToday } from "../../src/features/wishlist/product-fields";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const today = () => seoulToday(new Date());
const service = () => createLibraryService(createSupabaseLibraryStore(fixture.owner.client));
const change = (product: Product, revision: number, input: ProductChangeInput["change"]) =>
  service().changeProduct(toProductChangeCommand(product.id, { revision, change: input }, today()));
const reread = async (product: Product) => (await service().snapshot()).products.find((item) => item.id === product.id)!;

const offerPage = readFileSync(resolve(import.meta.dirname, "../fixtures/pages/offer.html"), "utf8");
// Stands in for the shop's servers; the stores, reader and database are the real ones.
const shop: PageSource = { read: vi.fn(async () => ({ ok: true as const, page: { html: offerPage, url: "https://shop.example/headphones", status: 200 } })) };
const noImages: ImageSource = { read: async () => ({ ok: false, code: "blocked_by_site" }) };
const runner = () => createCollectionRunner({
  store: createSupabaseCollectionStore(fixture.owner.client),
  source: shop,
  read: readProductPage,
  copier: createPictureCopier({ source: noImages, normalize: normalizePicture, pictures: createPictureStore(fixture.owner.client) }),
});

async function saved(): Promise<Product> {
  return (await service().saveLink(toLinkSaveCommand({ url: "https://shop.example/headphones", option: "", collectionIds: [] }))).product;
}

describe("실제 저장소를 쓰는 내가 살 가격", () => {
  it("직접 입력한 가격을 저장한 뒤 수집이 쇼핑몰 가격을 가져와도 직접 입력한 가격은 그대로이고 쇼핑몰 가격은 자동 확인 가격으로 남는다", async () => {
    const product = await saved();
    const priced = await change(product, 1, { type: "wish.price", price: { amountMinor: 259000, currency: "KRW" } });
    expect(priced).toMatchObject({ revision: 2, wishPrice: { amountMinor: 259000, currency: "KRW" }, lastSuccessfulPrice: null });

    expect((await runner().run({ productId: product.id, generation: 1 })).kind).toBe("collected");

    expect(await reread(product)).toMatchObject({
      revision: 2,
      wishPrice: { amountMinor: 259000, currency: "KRW" },
      lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW" },
    });
  });

  it("지우면 자동 확인 가격만 남고, 구매완료 상품에는 저장하지 못한다", async () => {
    const product = await saved();
    await change(product, 1, { type: "wish.price", price: { amountMinor: 259000, currency: "KRW" } });

    const cleared = await change(product, 2, { type: "wish.price", price: null });
    expect(cleared).toMatchObject({ revision: 3, wishPrice: null });

    const purchased = await change(product, 3, { type: "purchase" });
    await expect(change(product, purchased.revision, { type: "wish.price", price: { amountMinor: 1, currency: "KRW" } }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(change(product, 1, { type: "wish.price", price: { amountMinor: 1, currency: "KRW" } }))
      .rejects.toMatchObject({ code: "revision_conflict" });
    expect(await reread(product)).toEqual(purchased);
  });

  it("백업 파일로 내보냈다가 같은 파일을 읽어 복원하면 직접 입력한 가격이 돌아온다", async () => {
    const product = await saved();
    await change(product, 1, { type: "wish.price", price: { amountMinor: 3000, currency: "KRW" } });
    const text = JSON.stringify(toLibraryBackupDocument(await service().exportLibrary(), new Date()));
    await change(product, 2, { type: "wish.price", price: null });

    const reading = readLibraryBackup(JSON.parse(text));
    if (!reading.ok) throw new Error(`백업을 읽지 못했습니다: ${reading.problem}`);
    expect(reading.document.products[0].wishPrice).toEqual({ amountMinor: 3000, currency: "KRW" });
    const result = await service().restoreLibrary(toLibraryRestoreCommand(reading.document, today()));

    expect(result.library.products).toHaveLength(1);
    expect(result.library.products[0]).toMatchObject({ id: product.id, wishPrice: { amountMinor: 3000, currency: "KRW" } });
    expect(await reread(product)).toEqual(result.library.products[0]);
  });
});
