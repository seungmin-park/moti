import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLibraryService } from "../../src/features/library/application/library-service";
import { createPictureStore } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createCollectionRunner, type PageSource } from "../../src/features/metadata/application/collection";
import { WAKE_LIMIT } from "../../src/features/metadata/application/commands";
import { createPictureCopier, type ImageSource } from "../../src/features/metadata/application/picture-copy";
import { readProductPage } from "../../src/features/metadata/infrastructure/html-reader";
import { normalizePicture } from "../../src/features/metadata/infrastructure/sharp-normalizer";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { toShareLinkAddCommand } from "../../src/features/share/application/commands";
import { createShareKeyService, createShareLinkService } from "../../src/features/share/application/share-service";
import { createSupabaseShareKeyStore, createSupabaseShareLinkStore } from "../../src/features/share/infrastructure/supabase-share-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const links = () => createShareLinkService(createSupabaseShareLinkStore(fixture.anonymous));
const owner = () => createLibraryService(createSupabaseLibraryStore(fixture.owner.client));
const keys = () => createShareKeyService(createSupabaseShareKeyStore(fixture.owner.client));

describe("실제 저장소를 쓰는 공유 담기 서비스", () => {
  it("키로 담은 링크는 소유자 보관함에서 수집을 기다리는 새 상품이고, 다시 담으면 duplicate만 알린다", async () => {
    const { secret } = await keys().issue({ replaces: null });

    expect(await links().add(toShareLinkAddCommand(secret, " https://www.shop.example/lamp?utm_source=share "))).toEqual({ kind: "added" });

    const { products } = await owner().snapshot();
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      sourceUrl: "https://www.shop.example/lamp?utm_source=share",
      identityUrl: "https://www.shop.example/lamp",
      shop: "shop.example",
      title: "새로 담은 상품",
      collectionIds: [],
      metadata: { phase: "queued", generation: 1, attempts: 0, stalled: false },
    });
    expect(await links().add(toShareLinkAddCommand(secret, "https://www.shop.example/lamp"))).toEqual({ kind: "duplicate" });
    expect((await owner().snapshot()).products).toEqual(products);
  });

  it("폐기한 키는 key_rejected이고 보관함은 그대로다", async () => {
    const { key, secret } = await keys().issue({ replaces: null });
    await keys().revoke({ keyId: key.id });

    await expect(links().add(toShareLinkAddCommand(secret, "https://shop.example/lamp"))).rejects.toMatchObject({ code: "key_rejected" });

    expect((await owner().snapshot()).products).toEqual([]);
  });

  it("키를 바꾸면 이전 키로는 담지 못하고 새 키로 담으며, 마지막으로 담은 시각은 담은 키에만 남는다", async () => {
    const first = await keys().issue({ replaces: null });
    await links().add(toShareLinkAddCommand(first.secret, "https://shop.example/lamp"));
    const used = await keys().read();
    expect(used).toMatchObject({ id: first.key.id, lastUsedAt: expect.any(String), revokedAt: null });

    const second = await keys().issue({ replaces: first.key.id });

    await expect(links().add(toShareLinkAddCommand(first.secret, "https://shop.example/desk"))).rejects.toMatchObject({ code: "key_rejected" });
    expect(await links().add(toShareLinkAddCommand(second.secret, "https://shop.example/desk"))).toEqual({ kind: "added" });
    expect(await keys().read()).toMatchObject({ id: second.key.id, lastUsedAt: expect.any(String), revokedAt: null });
    expect((await owner().snapshot()).products.map((product) => product.sourceUrl).toSorted())
      .toEqual(["https://shop.example/desk", "https://shop.example/lamp"]);
  });

  it("소유자가 깨우면 키로 담은 상품을 실제 수집 실행기가 맡아 이름과 가격을 남긴다", async () => {
    const offerPage = readFileSync(resolve(import.meta.dirname, "../fixtures/pages/offer.html"), "utf8");
    // Only the shop is replaced; the store, reader, database and picture store are the real ones.
    const shop: PageSource = { read: vi.fn(async () => ({ ok: true as const, page: { html: offerPage, url: "https://shop.example/headphones", status: 200 } })) };
    const noImages: ImageSource = { read: async () => ({ ok: false, code: "blocked_by_site" }) };
    const jobs = createSupabaseCollectionStore(fixture.owner.client);
    const runner = createCollectionRunner({
      store: jobs,
      source: shop,
      read: readProductPage,
      copier: createPictureCopier({ source: noImages, normalize: normalizePicture, pictures: createPictureStore(fixture.owner.client) }),
    });
    const { secret } = await keys().issue({ replaces: null });
    await links().add(toShareLinkAddCommand(secret, "https://shop.example/headphones?utm_source=share"));

    const { products } = await jobs.wake({ limit: WAKE_LIMIT });
    const runs = await Promise.all(products.map(({ id, metadata }) => runner.run({ productId: id, generation: metadata.generation })));

    expect(runs.map((run) => run.kind)).toEqual(["collected"]);
    expect(shop.read).toHaveBeenCalledExactlyOnceWith("https://shop.example/headphones?utm_source=share");
    expect((await owner().snapshot()).products).toEqual([expect.objectContaining({
      title: "무선 헤드폰 블랙",
      metadata: expect.objectContaining({ phase: "ready", attempts: 1 }),
      lastSuccessfulPrice: expect.objectContaining({ amountMinor: 289000, currency: "KRW" }),
    })]);
    expect((await jobs.wake({ limit: WAKE_LIMIT })).products).toEqual([]);
  });
});
