import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { createPictureStore, PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createCollectionRunner, type PageRead, type PageSource } from "../../src/features/metadata/application/collection";
import { createPictureCopier, type ImageRead, type ImageSource, type PictureStore } from "../../src/features/metadata/application/picture-copy";
import { readProductPage } from "../../src/features/metadata/infrastructure/html-reader";
import { normalizePicture } from "../../src/features/metadata/infrastructure/sharp-normalizer";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
let photo: Buffer;
beforeAll(async () => {
  photo = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#3366aa" } })
    .jpeg().withExif({ IFD0: { Artist: "shop-photographer" } }).toBuffer();
});
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const sourceUrl = "https://shop.example/headphones?utm_source=moti";
const offerPage = readFileSync(resolve(import.meta.dirname, "../fixtures/pages/offer.html"), "utf8");
const pageSource: PageSource = {
  read: async (): Promise<PageRead> => ({ ok: true, page: { html: offerPage, url: "https://shop.example/headphones", status: 200 } }),
};

// Stands in for the shop's image server; the copier, sharp, Storage and the database are the real ones.
function shopImage(answer: () => Promise<ImageRead> | ImageRead = () => ({ ok: true, bytes: photo })) {
  return { read: vi.fn<ImageSource["read"]>(async () => answer()) };
}

const library = () => createSupabaseLibraryStore(fixture.owner.client);
const jobs = () => createSupabaseCollectionStore(fixture.owner.client);
const runner = (images: ImageSource, pictures: PictureStore = createPictureStore(fixture.owner.client)) =>
  createCollectionRunner({
    store: jobs(),
    source: pageSource,
    read: readProductPage,
    copier: createPictureCopier({ source: images, normalize: normalizePicture, pictures }),
  });

async function saved(): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({ url: sourceUrl, option: "", collectionIds: [] }))).product;
}

async function stored(product: Product): Promise<Product> {
  return (await library().snapshot()).products.find((item) => item.id === product.id)!;
}

async function objects(product: Product): Promise<string[]> {
  const { rows } = await fixture.admin.query<{ name: string }>(
    "select name from storage.objects where bucket_id = $1 and starts_with(name, $2) order by name",
    [PICTURE_BUCKET, `${fixture.owner.id}/${product.id}/`],
  );
  return rows.map((row) => row.name);
}

async function jobIds(product: Product): Promise<string[]> {
  const { rows } = await fixture.admin.query<{ id: string }>(
    "select id from moti.metadata_jobs where product_id = $1 order by generation", [product.id],
  );
  return rows.map((row) => row.id);
}

// Puts a ready product back in the retry path the way a later failure would.
async function failLater(product: Product) {
  await fixture.admin.query(
    `update moti.products set metadata_phase = 'failed', metadata_error_code = 'timeout', metadata_completed_at = null,
     metadata_image = null, metadata_image_error_code = null where id = $1`,
    [product.id],
  );
}

describe("실제 저장소를 쓰는 사진 사본 복사", () => {
  it("페이지의 사진을 비공개 WebP 사본으로 저장하고 이름·가격과 함께 사본을 보여준다", async () => {
    const product = await saved();
    const images = shopImage();

    const run = await runner(images).run({ productId: product.id, generation: 1 });

    const after = await stored(product);
    expect(run).toEqual({ kind: "collected", product: after });
    const [job] = await jobIds(product);
    expect(after).toMatchObject({
      sourceUrl,
      title: "무선 헤드폰 블랙",
      lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW" },
      metadata: { phase: "ready", generation: 1, image: { outcome: "copied" } },
      picture: { version: job },
    });
    expect(images.read).toHaveBeenCalledExactlyOnceWith("https://shop.example/images/headphones.jpg",
      { pageUrl: "https://shop.example/headphones", signal: expect.any(AbortSignal) });
    const name = `${fixture.owner.id}/${product.id}/${job}-1.webp`;
    expect(await objects(product)).toEqual([name]);

    const signed = await fixture.owner.client.storage.from(PICTURE_BUCKET).createSignedUrl(name, 60);
    const download = await fetch(signed.data!.signedUrl);
    expect(download.headers.get("content-type")).toBe("image/webp");
    const copy = Buffer.from(await download.arrayBuffer());
    expect(await sharp(copy).metadata()).toMatchObject({ format: "webp", width: 1200, height: 900 });
    expect(copy.includes("shop-photographer")).toBe(false);
  });

  it("사진 요청이 시간 초과여도 링크·이름·가격은 저장하고 다시 가져오면 사진을 복사한다", async () => {
    const product = await saved();

    const run = await runner(shopImage(() => ({ ok: false, code: "timeout" }))).run({ productId: product.id, generation: 1 });

    expect(run.kind).toBe("collected");
    expect(await stored(product)).toMatchObject({
      sourceUrl,
      title: "무선 헤드폰 블랙",
      lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW" },
      metadata: { phase: "ready", image: { outcome: "failed", errorCode: "timeout" } },
      picture: null,
    });
    expect(await objects(product)).toEqual([]);

    const retried = await jobs().retry({ productId: product.id, expectedGeneration: 1 });
    expect(retried.product.metadata).toMatchObject({ phase: "queued", generation: 2 });
    await runner(shopImage()).run({ productId: product.id, generation: 2 });

    const [, second] = await jobIds(product);
    expect(await stored(product)).toMatchObject({ metadata: { image: { outcome: "copied" } }, picture: { version: second } });
    expect(await objects(product)).toEqual([`${fixture.owner.id}/${product.id}/${second}-1.webp`]);
  });

  it("사진이라고 밝힌 SVG는 디코더에 넘기지 않고 아무것도 저장하지 않는다", async () => {
    const product = await saved();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    await runner(shopImage(() => ({ ok: true, bytes: svg }))).run({ productId: product.id, generation: 1 });

    expect((await stored(product)).metadata).toMatchObject({ image: { outcome: "failed", errorCode: "unsupported_content" } });
    expect(await objects(product)).toEqual([]);
  });

  it("새 사본이 생기면 이전 사본을 지워 상품마다 사본이 하나만 남는다", async () => {
    const product = await saved();
    await runner(shopImage()).run({ productId: product.id, generation: 1 });
    await failLater(product);
    await jobs().retry({ productId: product.id, expectedGeneration: 1 });

    await runner(shopImage()).run({ productId: product.id, generation: 2 });

    const [, second] = await jobIds(product);
    expect((await stored(product)).picture).toEqual({ version: second });
    expect(await objects(product)).toEqual([`${fixture.owner.id}/${product.id}/${second}-1.webp`]);
  });

  it("올린 뒤 새 세대로 바뀐 실행은 결과를 쓰지 않고 자기 사본을 지운다", async () => {
    const product = await saved();
    const pictures = createPictureStore(fixture.owner.client);
    const superseding: PictureStore = {
      put: async (object, picture) => {
        const put = await pictures.put(object, picture);
        await fixture.admin.query("update moti.products set metadata_generation = 2, metadata_phase = 'queued' where id = $1", [product.id]);
        return put;
      },
      discard: pictures.discard,
    };

    expect(await runner(shopImage(), superseding).run({ productId: product.id, generation: 1 })).toEqual({ kind: "stale" });

    expect(await stored(product)).toMatchObject({ title: product.title, picture: null, lastSuccessfulPrice: null });
    expect(await objects(product)).toEqual([]);
  });

  it("임대가 끝나 저장소가 올리기를 거절해도 링크·이름·가격은 남고 올리기 실패로 기록한다", async () => {
    const product = await saved();
    const expiring = shopImage(async () => {
      await fixture.admin.query("update moti.metadata_jobs set lease_until = now() - interval '1 second' where product_id = $1", [product.id]);
      return { ok: true, bytes: photo };
    });

    await runner(expiring).run({ productId: product.id, generation: 1 });

    expect(await stored(product)).toMatchObject({
      title: "무선 헤드폰 블랙",
      lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW" },
      metadata: { phase: "ready", image: { outcome: "failed", errorCode: "upload_failed" } },
      picture: null,
    });
    expect(await objects(product)).toEqual([]);
  });
});
