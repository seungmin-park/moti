import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toProductChangeCommand } from "../../src/features/library/application/commands";
import { createLibraryService } from "../../src/features/library/application/library-service";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createPictureStore } from "../../src/features/library/infrastructure/product-pictures";
import { createCollectionRunner, type PageRead, type PageSource } from "../../src/features/metadata/application/collection";
import { WAKE_LIMIT } from "../../src/features/metadata/application/commands";
import { createPictureCopier, type ImageSource } from "../../src/features/metadata/application/picture-copy";
import { normalizePicture } from "../../src/features/metadata/infrastructure/sharp-normalizer";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { readProductPage } from "../../src/features/metadata/infrastructure/html-reader";
import { toShareLinkAddCommand } from "../../src/features/share/application/commands";
import { createShareKeyService, createShareLinkService } from "../../src/features/share/application/share-service";
import { createSupabaseShareKeyStore, createSupabaseShareLinkStore } from "../../src/features/share/infrastructure/supabase-share-store";
import { createScheduledRunService } from "../../src/features/worker/application/scheduled-run";
import { createWorkerKeyService } from "../../src/features/worker/application/worker-service";
import { createSupabaseWorkerKeyStore, createSupabaseWorkerRunStore } from "../../src/features/worker/infrastructure/supabase-worker-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
let photo: Buffer;
beforeAll(async () => {
  photo = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#777777" } }).jpeg().toBuffer();
});
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const page = (name: string) => readFileSync(resolve(import.meta.dirname, `../fixtures/pages/${name}.html`), "utf8");
const offerPage = page("offer");
const served = (html: string): PageRead => ({ ok: true, page: { html, url: "https://shop.example/headphones", status: 200 } });

// Stands in for the shop's server; the worker's store, the reader and the database are the real ones.
function shop(answer: () => PageRead) {
  return { read: vi.fn<PageSource["read"]>(async () => answer()) };
}

const owner = () => createLibraryService(createSupabaseLibraryStore(fixture.owner.client));
const workerKeys = () => createWorkerKeyService(createSupabaseWorkerKeyStore(fixture.owner.client));
const worker = (source: PageSource) => createScheduledRunService({
  store: createSupabaseWorkerRunStore(fixture.anonymous),
  source,
  read: readProductPage,
  now: Date.now,
});

async function sharedLink(...urls: string[]) {
  const { secret } = await createShareKeyService(createSupabaseShareKeyStore(fixture.owner.client)).issue({ replaces: null });
  for (const url of urls) await createShareLinkService(createSupabaseShareLinkStore(fixture.anonymous)).add(toShareLinkAddCommand(secret, url));
}

async function objects() {
  const { rows } = await fixture.admin.query<{ count: number }>(
    "select count(*)::int as count from storage.objects where split_part(name, '/', 1) = $1",
    [fixture.owner.id],
  );
  return rows[0].count;
}

describe("실제 저장소를 쓰는 예약 실행", () => {
  it("키로 담고 아무도 열지 않은 상품을 작업 키로 수집하면 이름과 가격을 쓰고, 사진은 소유자를 기다리며 Storage에는 아무것도 만들지 않는다", async () => {
    await sharedLink("https://shop.example/headphones?utm_source=share");
    const { secret } = await workerKeys().issue({ replaces: null });
    const source = shop(() => served(offerPage));

    const result = await worker(source).run({ secret });

    expect(result).toEqual({
      kind: "finished",
      stop: "done",
      collections: { collected: 1, failed: 0 },
      prices: { confirmed: 0, kept: 0 },
      failures: {},
    });
    expect(source.read).toHaveBeenCalledExactlyOnceWith("https://shop.example/headphones?utm_source=share");
    const [product] = (await owner().snapshot()).products;
    expect(product).toMatchObject({
      title: "무선 헤드폰 블랙",
      metadata: { phase: "ready", generation: 1, attempts: 1, image: { outcome: "waiting" } },
      lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW" },
      picture: null,
    });
    expect(await objects()).toBe(0);
    const { runs } = await workerKeys().read();
    expect(runs).toEqual([expect.objectContaining({ state: "done", collections: { collected: 1, failed: 0 } })]);
  });

  it("쇼핑몰이 막으면 이유를 남기고, 폐기한 키로는 실행하지 못하며 아무것도 쓰지 않는다", async () => {
    await sharedLink("https://shop.example/blocked");
    const first = await workerKeys().issue({ replaces: null });
    const blocked = shop(() => ({ ok: false, code: "blocked_by_site", status: 403 }));

    expect(await worker(blocked).run({ secret: first.secret })).toMatchObject({
      kind: "finished", stop: "done", collections: { collected: 0, failed: 1 }, failures: { blocked_by_site: 1 },
    });
    expect((await owner().snapshot()).products[0].metadata).toMatchObject({ phase: "failed", errorCode: "blocked_by_site" });

    await workerKeys().revoke({ keyId: first.key.id });
    const before = await owner().snapshot();
    expect(await worker(blocked).run({ secret: first.secret })).toEqual({ kind: "refused", code: "key_rejected" });
    expect(await owner().snapshot()).toEqual(before);
  });

  it("작업자가 남긴 사진은 소유자가 moti를 열면 깨워 소유자 세션으로 비공개 사본을 만든다", async () => {
    await sharedLink("https://shop.example/headphones");
    const { secret } = await workerKeys().issue({ replaces: null });
    await worker(shop(() => served(offerPage))).run({ secret });
    const jobs = createSupabaseCollectionStore(fixture.owner.client);

    const { products } = await jobs.wake({ limit: WAKE_LIMIT });

    expect(products.map(({ title, metadata }) => ({ title, metadata }))).toEqual([
      { title: "무선 헤드폰 블랙", metadata: { phase: "queued", generation: 2, attempts: 0, stalled: false } },
    ]);
    const images: ImageSource = { read: async () => ({ ok: true, bytes: photo }) };
    const runner = createCollectionRunner({
      store: jobs,
      source: shop(() => served(offerPage)),
      read: readProductPage,
      copier: createPictureCopier({ source: images, normalize: normalizePicture, pictures: createPictureStore(fixture.owner.client) }),
    });
    expect(await runner.run({ productId: products[0].id, generation: 2 })).toMatchObject({ kind: "collected" });
    const [after] = (await owner().snapshot()).products;
    expect(after).toMatchObject({ metadata: { phase: "ready", generation: 2, image: { outcome: "copied" } }, picture: { version: expect.any(String) } });
    expect(await objects()).toBe(1);
    expect((await jobs.wake({ limit: WAKE_LIMIT })).products).toEqual([]);
  });
});

describe("실제 저장소를 쓰는 매일 가격 확인", () => {
  // Moves every stored check, price and collection a day back, as if the run happened yesterday in Seoul.
  const dayPasses = () => fixture.admin.query(
    `update moti.products set price_checked_at = price_checked_at - interval '1 day', last_success_at = last_success_at - interval '1 day',
       metadata_completed_at = metadata_completed_at - interval '1 day' where owner_id = $1`,
    [fixture.owner.id],
  );
  const runs = async () => (await workerKeys().read()).runs;

  async function collectedYesterday(urls: string[]) {
    await sharedLink(...urls);
    const { secret } = await workerKeys().issue({ replaces: null });
    expect(await worker(shop(() => served(offerPage))).run({ secret })).toMatchObject({ collections: { collected: urls.length } });
    await dayPasses();
    return secret;
  }

  it("수집이 끝난 위시 상품을 다음 날 확인하면 같은 통화의 새 가격으로 바꾸고 이름·사진은 그대로다. 같은 날 다음 실행은 다시 읽지 않는다", async () => {
    const secret = await collectedYesterday(["https://shop.example/headphones"]);
    const [before] = (await owner().snapshot()).products;
    const source = shop(() => served(page("meta-only")));

    expect(await worker(source).run({ secret })).toEqual({
      kind: "finished", stop: "done", collections: { collected: 0, failed: 0 }, prices: { confirmed: 1, kept: 0 }, failures: {},
    });

    expect(source.read).toHaveBeenCalledExactlyOnceWith("https://shop.example/headphones");
    const [after] = (await owner().snapshot()).products;
    expect(after).toEqual({
      ...before,
      lastSuccessfulPrice: { amountMinor: 129000, currency: "KRW", checkedAt: expect.any(String) },
      priceCheck: { checkedAt: expect.any(String), code: null },
    });
    expect(Date.parse(after.lastSuccessfulPrice!.checkedAt)).toBeGreaterThan(Date.parse(before.lastSuccessfulPrice!.checkedAt));
    expect(after).toMatchObject({ title: "무선 헤드폰 블랙", metadata: { image: { outcome: "waiting" } }, picture: null });
    expect(await objects()).toBe(0);

    const again = shop(() => served(page("meta-only")));
    expect(await worker(again).run({ secret })).toMatchObject({ stop: "done", prices: { confirmed: 0, kept: 0 } });
    expect(again.read).not.toHaveBeenCalled();
  });

  it("가격이 여럿인 페이지, 다른 통화, 막힌 쇼핑몰은 이전 가격과 그 시각을 지키고 이유를 실행 기록에 남긴다", async () => {
    const urls = ["https://shop.example/camera", "https://shop.example/speaker", "https://shop.example/blocked"];
    const secret = await collectedYesterday(urls);
    const before = (await owner().snapshot()).products;
    const pages: Record<string, PageRead> = {
      [urls[0]]: served(page("conflict")),
      [urls[1]]: served(page("graph")),
      [urls[2]]: { ok: false, code: "blocked_by_site", status: 403 },
    };

    const result = await worker({ read: async (url) => pages[url] }).run({ secret });

    const counts = { prices: { confirmed: 0, kept: 3 }, failures: { no_single_price: 1, other_currency: 1, blocked_by_site: 1 } };
    expect(result).toEqual({ kind: "finished", stop: "done", collections: { collected: 0, failed: 0 }, ...counts });
    expect((await owner().snapshot()).products.map((product) => product.lastSuccessfulPrice))
      .toEqual(before.map((product) => product.lastSuccessfulPrice));
    expect((await runs())[0]).toMatchObject({ state: "done", ...counts });
  });

  it("구매완료로 옮긴 상품은 다음 날에도 확인하지 않는다", async () => {
    const secret = await collectedYesterday(["https://shop.example/bought"]);
    const [product] = (await owner().snapshot()).products;
    await owner().changeProduct(toProductChangeCommand(product.id, { revision: product.revision, change: { type: "purchase" } }, "2026-11-14"));
    const source = shop(() => served(page("meta-only")));

    expect(await worker(source).run({ secret })).toMatchObject({ stop: "done", prices: { confirmed: 0, kept: 0 } });
    expect(source.read).not.toHaveBeenCalled();
  });
});
