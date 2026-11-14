import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand, toProductChangeCommand, toProductDeleteCommand } from "../../src/features/library/application/commands";
import { createLibraryService } from "../../src/features/library/application/library-service";
import { sweepPictures } from "../../src/features/library/application/picture-sweep";
import { createPictureOrphanStore, createPictureStore, PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
// cleanup removes the test's pictures through the Storage API before it deletes the users.
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const service = (client = fixture.owner.client) => createLibraryService(createSupabaseLibraryStore(client));
// A 1×1 lossless WebP.
const webp = Buffer.from("524946461a000000574542505650384c0d0000002f0000001007101111888808", "hex");

async function saved(collectionIds: string[] = [], url = `https://shop.example/${randomUUID()}`) {
  return (await service().saveLink(toLinkSaveCommand({ url, option: "", collectionIds }))).product;
}

describe("실제 저장소를 쓰는 상품 삭제 서비스", () => {
  it("상품을 지우면 새로 읽은 보관함에서 상품과 컬렉션 소속이 사라지고 컬렉션은 남는다", async () => {
    const desk = await service().createCollection({ name: "책상" });
    const product = await saved([desk.id]);
    const kept = await saved([desk.id]);

    expect(await service().deleteProduct(toProductDeleteCommand(product.id.toUpperCase(), { revision: 1 })))
      .toEqual({ productId: product.id });

    const library = await service().snapshot();
    expect(library.products.map(({ id }) => id)).toEqual([kept.id]);
    expect(library.collections).toEqual([desk]);
    expect(library.products.filter((item) => item.collectionIds.includes(desk.id))).toHaveLength(1);
  });

  it("다른 곳에서 먼저 바뀐 상품을 오래된 revision으로 지우면 revision_conflict이고 상품은 남는다", async () => {
    const product = await saved();
    const changed = await service().changeProduct(toProductChangeCommand(product.id, { revision: 1, change: { type: "purchase" } }, "2026-11-13"));

    await expect(service().deleteProduct(toProductDeleteCommand(product.id, { revision: 1 }))).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await service().snapshot()).products).toEqual([changed]);
  });

  it("이미 지운 상품을 다시 지우면 product_missing이다", async () => {
    const product = await saved();
    await service().deleteProduct(toProductDeleteCommand(product.id, { revision: 1 }));
    await expect(service().deleteProduct(toProductDeleteCommand(product.id, { revision: 1 }))).rejects.toMatchObject({ code: "product_missing" });
  });

  it("허용하지 않은 사용자는 서비스에서도 상품을 지우지 못한다", async () => {
    const product = await saved();
    await expect(service(fixture.stranger.client).deleteProduct(toProductDeleteCommand(product.id, { revision: 1 })))
      .rejects.toMatchObject({ code: "unauthorized" });
    expect((await service().snapshot()).products.map(({ id }) => id)).toEqual([product.id]);
  });

  it("지운 뒤 같은 링크를 담으면 새 상품으로 담긴다", async () => {
    const url = `https://shop.example/${randomUUID()}`;
    const first = await saved([], url);
    await service().deleteProduct(toProductDeleteCommand(first.id, { revision: 1 }));
    const again = await service().saveLink(toLinkSaveCommand({ url, option: "", collectionIds: [] }));
    expect(again).toMatchObject({ kind: "added", product: { revision: 1 } });
    expect(again.product.id).not.toBe(first.id);
  });

  it("지운 상품의 사진 사본은 10분이 지나면 기존 남은 사본 정리가 Storage에서 지운다", async () => {
    const product = await saved();
    const jobs = createSupabaseCollectionStore(fixture.owner.client);
    const claim = await jobs.claim({ productId: product.id, generation: 1 });
    if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
    const pictures = fixture.owner.client.storage.from(PICTURE_BUCKET);
    expect((await pictures.upload(claim.job.picture, webp, { contentType: "image/webp", upsert: false })).error).toBeNull();
    await jobs.complete(claim.job, { title: "무선 헤드폰", price: null, imageSourceUrl: "https://cdn.shop.example/a.jpg" }, { outcome: "copied" });
    const sweep = () => sweepPictures({ orphans: createPictureOrphanStore(fixture.owner.client), pictures: createPictureStore(fixture.owner.client) });

    await service().deleteProduct(toProductDeleteCommand(product.id, { revision: 1 }));
    expect(await sweep()).toEqual({ kind: "requested", count: 0 });
    await fixture.admin.query(
      "update storage.objects set created_at = now() - interval '11 minutes' where bucket_id = $1 and name = $2",
      [PICTURE_BUCKET, claim.job.picture],
    );
    expect(await sweep()).toEqual({ kind: "requested", count: 1 });

    const { rows } = await fixture.admin.query("select name from storage.objects where bucket_id = $1 and name = $2", [PICTURE_BUCKET, claim.job.picture]);
    expect(rows).toEqual([]);
  });
});
