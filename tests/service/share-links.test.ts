import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibraryService } from "../../src/features/library/application/library-service";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { toShareLinkAddCommand } from "../../src/features/share/application/commands";
import { createShareLinkService } from "../../src/features/share/application/share-service";
import { parseShareSecret, type ShareSecret } from "../../src/features/share/domain/share-key";
import { createSupabaseShareLinkStore } from "../../src/features/share/infrastructure/supabase-share-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const links = () => createShareLinkService(createSupabaseShareLinkStore(fixture.anonymous));
const owner = () => createLibraryService(createSupabaseLibraryStore(fixture.owner.client));

async function issue(): Promise<{ id: string; secret: ShareSecret }> {
  const { data, error } = await fixture.owner.client.rpc("moti_share_key_issue", { p_replaces: null });
  if (error) throw new Error(`키를 만들지 못했습니다: ${error.code}`);
  return { id: data.key.id, secret: parseShareSecret(data.secret)! };
}

describe("실제 저장소를 쓰는 공유 담기 서비스", () => {
  it("키로 담은 링크는 소유자 보관함에서 수집을 기다리는 새 상품이고, 다시 담으면 duplicate만 알린다", async () => {
    const { secret } = await issue();

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
    const { id, secret } = await issue();
    await fixture.owner.client.rpc("moti_share_key_revoke", { p_key_id: id });

    await expect(links().add(toShareLinkAddCommand(secret, "https://shop.example/lamp"))).rejects.toMatchObject({ code: "key_rejected" });

    expect((await owner().snapshot()).products).toEqual([]);
  });
});
