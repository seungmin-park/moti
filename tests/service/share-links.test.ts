import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibraryService } from "../../src/features/library/application/library-service";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
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
});
