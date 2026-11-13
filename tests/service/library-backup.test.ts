import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  toLibraryRestoreCommand,
  toLinkSaveCommand,
  toProductChangeCommand,
  type ProductChangeInput,
} from "../../src/features/library/application/commands";
import { createLibraryService } from "../../src/features/library/application/library-service";
import { followUpRestore } from "../../src/features/library/application/restore-follow-up";
import type { Library, Product } from "../../src/features/library/domain/library";
import { createPictureStore, PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { readLibraryBackup, toLibraryBackupDocument, type LibraryBackupDocument } from "../../src/features/library/presentation/library-backup";
import { createCollectionRunner, type PageSource } from "../../src/features/metadata/application/collection";
import { createPictureCopier, type ImageSource } from "../../src/features/metadata/application/picture-copy";
import { readProductPage } from "../../src/features/metadata/infrastructure/html-reader";
import { normalizePicture } from "../../src/features/metadata/infrastructure/sharp-normalizer";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
let photo: Buffer;
beforeAll(async () => {
  photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#777777" } }).jpeg().toBuffer();
});
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const today = "2026-11-13";
const offerPage = readFileSync(resolve(import.meta.dirname, "../fixtures/pages/offer.html"), "utf8");
// Stand in for the shop; the runner, sharp, Storage and the database are the real ones.
const pageSource: PageSource = { read: async (url) => ({ ok: true, page: { html: offerPage, url, status: 200 } }) };
const images: ImageSource = { read: async () => ({ ok: true, bytes: photo }) };

const service = () => createLibraryService(createSupabaseLibraryStore(fixture.owner.client));
const pictures = () => createPictureStore(fixture.owner.client);
const runner = () => createCollectionRunner({
  store: createSupabaseCollectionStore(fixture.owner.client),
  source: pageSource,
  read: readProductPage,
  copier: createPictureCopier({ source: images, normalize: normalizePicture, pictures: pictures() }),
});

async function saved(url: string, collectionIds: string[] = []): Promise<Product> {
  return (await service().saveLink(toLinkSaveCommand({ url, option: "", collectionIds }))).product;
}

const change = (product: Product, revision: number, input: ProductChangeInput["change"]) =>
  service().changeProduct(toProductChangeCommand(product.id, { revision, change: input }, today));

// What the owner downloads, as the bytes of the file.
async function downloaded(at: Date): Promise<string> {
  return JSON.stringify(toLibraryBackupDocument(await service().exportLibrary(), at));
}

async function restored(text: string) {
  const reading = readLibraryBackup(JSON.parse(text));
  if (!reading.ok) throw new Error(`백업을 읽지 못했습니다: ${reading.problem} ${reading.path}`);
  return service().restoreLibrary(toLibraryRestoreCommand(reading.document, today));
}

const withoutTime = (document: LibraryBackupDocument) => ({ ...document, exportedAt: undefined });
const parsed = (text: string) => JSON.parse(text) as LibraryBackupDocument;

// What the owner sees for each product, with collection names instead of ids.
function visible(library: Library) {
  const names = new Map(library.collections.map(({ id, name }) => [id, name]));
  return {
    collections: library.collections.map(({ name, createdAt }) => ({ name, createdAt })),
    products: library.products.map((product) => ({
      sourceUrl: product.sourceUrl, option: product.option, title: product.title, note: product.note,
      collections: product.collectionIds.map((id) => names.get(id)).toSorted(), addedAt: product.addedAt,
      purchase: product.purchase, lastSuccessfulPrice: product.lastSuccessfulPrice, picture: product.picture !== null,
    })),
  };
}

async function storedPictures(): Promise<string[]> {
  const { rows } = await fixture.admin.query<{ name: string }>(
    "select name from storage.objects where bucket_id = $1 and starts_with(name, $2) order by name", [PICTURE_BUCKET, `${fixture.owner.id}/`],
  );
  return rows.map(({ name }) => name);
}

async function buildLibrary() {
  const living = await service().createCollection({ name: "거실" });
  const desk = await service().createCollection({ name: "Desk" });
  const headphones = await saved("https://shop.example/headphones?utm_source=moti", [living.id]);
  await runner().run({ productId: headphones.id, generation: 1 });
  const lamp = await saved("https://shop.example/lamp", [desk.id]);
  await change(lamp, 1, { type: "details", title: "책상 조명", note: "  선물용\n사이즈 확인  ", collectionIds: [living.id, desk.id] });
  const chair = await saved("https://shop.example/chair");
  await change(chair, 1, { type: "purchase" });
  await change(chair, 2, { type: "purchase.record", date: null, price: { amountMinor: 0, currency: "KRW" } });
  const table = await saved("https://shop.example/table");
  await change(table, 1, { type: "purchase" });
  await change(table, 2, { type: "purchase.record", date: "2026-11-01", price: null });
  return { living, desk, headphones, lamp, chair, table };
}

describe("실제 저장소를 쓰는 백업과 복원", () => {
  it("내려받은 파일로 같은 보관함을 복원한 뒤 다시 내려받으면 내보낸 시각만 다르고 보이는 값이 같다", async () => {
    await buildLibrary();
    const before = await service().snapshot();
    const text = await downloaded(new Date("2026-11-13T05:00:00.000Z"));
    expect(visible(before).products.find(({ sourceUrl }) => sourceUrl.includes("headphones"))).toMatchObject({
      title: "무선 헤드폰 블랙", lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW" }, picture: true,
    });

    const result = await restored(text);

    const again = parsed(await downloaded(new Date("2026-11-13T06:00:00.000Z")));
    expect(withoutTime(again)).toEqual(withoutTime(parsed(text)));
    expect(again.exportedAt).not.toBe(parsed(text).exportedAt);
    expect(visible(result.library)).toEqual(visible(before));
    expect(result.library.products.map(({ id }) => id)).toEqual(before.products.map(({ id }) => id));
    expect(result.replacedPictures).toEqual([]);
  });

  it("새 프로젝트처럼 빈 보관함에 복원해도 다시 내려받은 파일이 같고 사진은 수집으로 다시 생긴다", async () => {
    await buildLibrary();
    const before = await service().snapshot();
    const text = await downloaded(new Date("2026-11-13T05:00:00.000Z"));
    const emptied = await restored(JSON.stringify(toLibraryBackupDocument({ collections: [], products: [] }, new Date())));
    await followUpRestore(emptied, { pictures: pictures(), collect: () => Promise.resolve(), now: Date.now });
    expect(await service().snapshot()).toEqual({ collections: [], products: [] });
    expect(await storedPictures()).toEqual([]);

    const result = await restored(text);

    expect(withoutTime(parsed(await downloaded(new Date())))).toEqual(withoutTime(parsed(text)));
    expect(visible(result.library)).toEqual(visible({
      ...before,
      products: before.products.map((product) => ({ ...product, picture: null })),
    }));
    await followUpRestore(result, { pictures: pictures(), collect: runner().run, now: Date.now });
    const collected = await service().snapshot();
    expect(collected.products.every(({ metadata, picture }) => metadata.phase === "ready" && picture !== null)).toBe(true);
    expect(collected.products.find(({ sourceUrl }) => sourceUrl.includes("lamp"))).toMatchObject({ title: "책상 조명", note: "  선물용\n사이즈 확인  " });
  });

  it("복원 뒤 정리는 파일에 없는 상품의 사본을 버리고 새 상품을 수집하며 남은 상품의 사본은 지킨다", async () => {
    const kept = await saved("https://shop.example/kept");
    await runner().run({ productId: kept.id, generation: 1 });
    const removed = await saved("https://shop.example/removed");
    await runner().run({ productId: removed.id, generation: 1 });
    const file = parsed(await downloaded(new Date()));
    const keptPicture = (await storedPictures()).find((name) => name.includes(kept.id))!;

    const result = await restored(JSON.stringify({
      ...file,
      products: [
        { ...file.products.find(({ sourceUrl }) => sourceUrl.endsWith("/kept"))!, note: "복원한 메모" },
        { ...file.products[0], sourceUrl: "https://shop.example/new", collectedTitle: "새로 담은 상품", lastSuccessfulPrice: null },
      ],
    }));
    expect(result.replacedPictures).toEqual([expect.stringContaining(`/${removed.id}/`)]);
    await followUpRestore(result, { pictures: pictures(), collect: runner().run, now: Date.now });

    const library = await service().snapshot();
    expect(library.products.map(({ sourceUrl, title, note, metadata }) => ({ sourceUrl, title, note, phase: metadata.phase }))).toEqual([
      { sourceUrl: "https://shop.example/new", title: "무선 헤드폰 블랙", note: "", phase: "ready" },
      { sourceUrl: "https://shop.example/kept", title: "무선 헤드폰 블랙", note: "복원한 메모", phase: "ready" },
    ]);
    const newcomer = library.products[0];
    const left = await storedPictures();
    expect(left).toHaveLength(2);
    expect(left).toContain(keptPicture);
    expect(left.some((name) => name.startsWith(`${fixture.owner.id}/${newcomer.id}/`))).toBe(true);
  });
});
