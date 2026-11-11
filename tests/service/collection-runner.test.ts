import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createCollectionRunner, type PageRead, type PageSource } from "../../src/features/metadata/application/collection";
import type { CollectionErrorCode } from "../../src/features/metadata/domain/collection-error";
import { readProductPage } from "../../src/features/metadata/infrastructure/html-reader";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const sourceUrl = "https://shop.example/headphones?utm_source=moti";
const offerPage = readFileSync(resolve(import.meta.dirname, "../fixtures/pages/offer.html"), "utf8");
const served = (html: string): PageRead => ({ ok: true, page: { html, url: "https://shop.example/headphones", status: 200 } });

// Stands in for the shop's server; the store, reader and database are the real ones.
function shop(answer: (url: string) => Promise<PageRead> | PageRead) {
  return { read: vi.fn<PageSource["read"]>(async (url) => answer(url)) };
}

const library = () => createSupabaseLibraryStore(fixture.owner.client);
const jobs = () => createSupabaseCollectionStore(fixture.owner.client);
const runner = (source: PageSource) => createCollectionRunner({ store: jobs(), source, read: readProductPage });

async function saved(): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({ url: sourceUrl, option: "", collectionIds: [] }))).product;
}

async function stored(product: Product): Promise<Product> {
  return (await library().snapshot()).products.find((item) => item.id === product.id)!;
}

describe("실제 저장소를 사용하는 수집 실행", () => {
  it("쇼핑몰 페이지를 읽어 이름과 하나의 가격을 저장하고 원본 링크는 그대로 둔다", async () => {
    const product = await saved();
    const source = shop(() => served(offerPage));

    const run = await runner(source).run({ productId: product.id, generation: 1 });

    expect(source.read).toHaveBeenCalledExactlyOnceWith(sourceUrl);
    const after = await stored(product);
    expect(run).toEqual({ kind: "collected", product: after });
    expect(after).toMatchObject({
      sourceUrl,
      title: "무선 헤드폰 블랙",
      metadata: { phase: "ready", generation: 1, attempts: 1 },
      lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW" },
    });
    expect(await runner(source).run({ productId: product.id, generation: 1 })).toEqual({ kind: "skipped", reason: "settled" });
    expect(source.read).toHaveBeenCalledOnce();
  });

  it.each<CollectionErrorCode>([
    "blocked_address", "dns_failed", "connect_failed", "timeout", "too_many_redirects", "blocked_by_site",
    "http_status", "unsupported_content", "too_large", "decode_failed",
  ])("쇼핑몰 요청이 %s로 실패해도 링크를 지키고 실패 코드를 기록한다", async (code) => {
    const product = await saved();
    const run = await runner(shop(() => ({ ok: false, code, status: null }))).run({ productId: product.id, generation: 1 });
    const after = await stored(product);
    expect(run).toEqual({ kind: "failed", code, product: after });
    expect(after).toMatchObject({
      sourceUrl,
      identityUrl: product.identityUrl,
      title: product.title,
      metadata: { phase: "failed", generation: 1, attempts: 1, errorCode: code },
      lastSuccessfulPrice: null,
    });
  });

  it("상품 이름이 없는 페이지는 지어내지 않고 상품 정보 없음으로 기록한다", async () => {
    const product = await saved();
    const run = await runner(shop(() => served("<html><body>빈 페이지</body></html>"))).run({ productId: product.id, generation: 1 });
    expect(run).toMatchObject({ kind: "failed", code: "no_product_data" });
    expect((await stored(product)).title).toBe(product.title);
  });

  it("쇼핑몰 요청이 예상하지 못한 오류를 던지면 내부 오류로 기록한다", async () => {
    const product = await saved();
    const run = await runner(shop(() => { throw new Error("socket exploded"); })).run({ productId: product.id, generation: 1 });
    expect(run).toMatchObject({ kind: "failed", code: "internal" });
    expect((await stored(product)).metadata).toMatchObject({ phase: "failed", errorCode: "internal" });
  });

  it("실패한 상품을 다시 가져오면 새 세대로 수집해 정보를 채운다", async () => {
    const product = await saved();
    await runner(shop(() => ({ ok: false, code: "timeout", status: null }))).run({ productId: product.id, generation: 1 });

    const retried = await jobs().retry({ productId: product.id, expectedGeneration: 1 });
    const run = await runner(shop(() => served(offerPage))).run({
      productId: product.id,
      generation: retried.product.metadata.generation,
    });

    expect(run.kind).toBe("collected");
    expect((await stored(product))).toMatchObject({
      title: "무선 헤드폰 블랙",
      metadata: { phase: "ready", generation: 2, attempts: 1 },
    });
  });

  it("읽는 사이 새 세대로 다시 시작된 이전 실행은 결과를 쓰지 않는다", async () => {
    const product = await saved();
    const slow = shop(async () => {
      await fixture.admin.query(
        "update moti.metadata_jobs set lease_until = now() - interval '1 second', attempts = 3 where product_id = $1",
        [product.id],
      );
      await jobs().retry({ productId: product.id, expectedGeneration: 1 });
      return served(offerPage);
    });

    expect(await runner(slow).run({ productId: product.id, generation: 1 })).toEqual({ kind: "stale" });

    expect(await stored(product)).toMatchObject({
      title: product.title,
      metadata: { phase: "queued", generation: 2, attempts: 0 },
      lastSuccessfulPrice: null,
    });
    expect(await runner(slow).run({ productId: product.id, generation: 1 })).toEqual({ kind: "skipped", reason: "stale" });
    const fresh = await runner(shop(() => served(offerPage))).run({ productId: product.id, generation: 2 });
    expect(fresh.kind).toBe("collected");
  });
});
