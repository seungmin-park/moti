import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand, toPicturePasteCommand } from "../../src/features/library/application/commands";
import { createPicturePasteService } from "../../src/features/library/application/picture-paste";
import type { Product } from "../../src/features/library/domain/library";
import { createPictureStore, PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import {
  createSupabaseLibraryStore,
  createSupabasePicturePasteStore,
} from "../../src/features/library/infrastructure/supabase-library-store";
import { createCollectionRunner, type PageRead, type PageSource } from "../../src/features/metadata/application/collection";
import { createPictureCopier, type ImageSource } from "../../src/features/metadata/application/picture-copy";
import { readProductPage } from "../../src/features/metadata/infrastructure/html-reader";
import { normalizePicture } from "../../src/features/metadata/infrastructure/sharp-normalizer";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
let pasted: Buffer;
let shopPhoto: Buffer;
beforeAll(async () => {
  // What the owner copied: a large JPEG with EXIF and a GPS position that must not reach Storage.
  pasted = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#6f6a64" } })
    .jpeg().withExif({ IFD0: { Artist: "owner-phone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "37/1 33/1 0/1" } }).toBuffer();
  shopPhoto = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#3366aa" } }).jpeg().toBuffer();
});
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const offerPage = readFileSync(resolve(import.meta.dirname, "../fixtures/pages/offer.html"), "utf8");
const pageSource: PageSource = {
  read: async (): Promise<PageRead> => ({ ok: true, page: { html: offerPage, url: "https://shop.example/headphones", status: 200 } }),
};
// Stands in for the shop's image server only; the runner, sharp, Storage and the database are the real ones.
const shopImage: ImageSource = { read: async () => ({ ok: true, bytes: shopPhoto }) };

const library = () => createSupabaseLibraryStore(fixture.owner.client);
const service = () => createPicturePasteService({
  store: createSupabasePicturePasteStore(fixture.owner.client),
  normalize: normalizePicture,
  pictures: createPictureStore(fixture.owner.client),
});
const runner = () => createCollectionRunner({
  store: createSupabaseCollectionStore(fixture.owner.client),
  source: pageSource,
  read: readProductPage,
  copier: createPictureCopier({ source: shopImage, normalize: normalizePicture, pictures: createPictureStore(fixture.owner.client) }),
});

async function saved(): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({ url: "https://shop.example/headphones", option: "", collectionIds: [] }))).product;
}

async function objects(product: Product): Promise<string[]> {
  const { rows } = await fixture.admin.query<{ name: string }>(
    "select name from storage.objects where bucket_id = $1 and starts_with(name, $2) order by name",
    [PICTURE_BUCKET, `${fixture.owner.id}/${product.id}/`],
  );
  return rows.map((row) => row.name);
}

async function download(name: string): Promise<Buffer> {
  const { data, error } = await fixture.owner.client.storage.from(PICTURE_BUCKET).download(name);
  if (error) throw new Error(error.message);
  return Buffer.from(await data.arrayBuffer());
}

describe("실제 저장소를 쓰는 사진 붙여넣기", () => {
  it("붙여 넣은 JPEG를 1200px 안의 메타데이터 없는 WebP로 올려 상품에 걸고, 다시 붙여 넣으면 이전 사본을 지운다", async () => {
    const product = await saved();

    const first = await service().paste(toPicturePasteCommand(product.id, new Uint8Array(pasted)));
    if (first.kind !== "pasted") throw new Error(JSON.stringify(first));
    const [firstName] = await objects(product);
    const metadata = await sharp(await download(firstName)).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 1200, height: 800 });
    expect(metadata.exif).toBeUndefined();
    expect(first.product.picture).toEqual({ version: firstName.split("/")[2].replace(/-1\.webp$/, ""), pasted: true });

    const second = await service().paste(toPicturePasteCommand(product.id, new Uint8Array(shopPhoto)));
    if (second.kind !== "pasted") throw new Error(JSON.stringify(second));
    const names = await objects(product);
    expect(names).toHaveLength(1);
    expect(names).not.toContain(firstName);
  });

  it("실제 수집 실행이 끝나도 붙여 넣은 사진이 남고, 지우면 수집한 사본으로 돌아가며 붙여 넣은 사본은 지워진다", async () => {
    const product = await saved();
    const result = await service().paste(toPicturePasteCommand(product.id, new Uint8Array(pasted)));
    if (result.kind !== "pasted") throw new Error(JSON.stringify(result));
    const [pastedName] = await objects(product);

    await runner().run({ productId: product.id, generation: 1 });

    const after = (await library().snapshot()).products.find((item) => item.id === product.id)!;
    expect(after.metadata).toMatchObject({ phase: "ready", image: { outcome: "copied" } });
    expect(after.picture).toEqual(result.product.picture);
    expect(await objects(product)).toHaveLength(2);

    const cleared = await service().clear({ productId: product.id });
    const remaining = await objects(product);
    expect(remaining).toHaveLength(1);
    expect(remaining).not.toContain(pastedName);
    expect(cleared.picture).toEqual({ version: remaining[0].split("/")[2].replace(/-1\.webp$/, ""), pasted: false });
  });

  it("HTML·SVG 바이트와 잘린 PNG는 올리지 않고 거절한다", async () => {
    const product = await saved();
    const truncated = (await sharp({ create: { width: 400, height: 400, channels: 3, background: "#123456" } }).png().toBuffer()).subarray(0, 120);

    expect(await service().paste(toPicturePasteCommand(product.id, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))))
      .toEqual({ kind: "refused", problem: "unsupported_format" });
    expect(await service().paste(toPicturePasteCommand(product.id, new Uint8Array(truncated))))
      .toEqual({ kind: "refused", problem: "unreadable" });
    expect(await objects(product)).toEqual([]);
  });
});
