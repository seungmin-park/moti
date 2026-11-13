import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import {
  errorResponseSchema,
  libraryReadResponseSchema,
  metadataRetryResponseSchema,
} from "../../src/features/library/presentation/library-dto";
import type { CollectedPage, CollectionJob } from "../../src/features/metadata/application/collection";
import type { ImageCopy } from "../../src/features/metadata/application/picture-copy";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { cookieHeader, signInCookies } from "../support/session";

const { appUrl, apiUrl } = readDatabaseConfig();
const origin = new URL(appUrl).origin;
// A loopback address the production policy refuses without connecting, so a re-run fails fast and keeps the link.
const blockedLink = "http://127.0.0.1:9/p";
const shopImage = "https://cdn.shop.example/secret-path/headphones.jpg";
const page: CollectedPage = { title: "무선 헤드폰", price: { amountMinor: 289000, currency: "KRW" }, imageSourceUrl: shopImage };

let fixture: DatabaseFixture;
let cookie: string;
let webp: Buffer;
beforeAll(async () => {
  webp = await sharp({ create: { width: 120, height: 90, channels: 3, background: "#556677" } }).webp().toBuffer();
});
beforeEach(async () => {
  fixture = await createDatabaseFixture({ ownerGoogleSubject: HTTP_OWNER_SUBJECT });
  cookie = cookieHeader(await signInCookies(fixture.owner));
});
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const get = (path: string, headers: Record<string, string> = { cookie }) =>
  fetch(new URL(path, appUrl), { redirect: "manual", headers });

async function saved(url = `https://shop.example/${randomUUID()}`): Promise<Product> {
  return (await createSupabaseLibraryStore(fixture.owner.client)
    .saveLink(toLinkSaveCommand({ url, option: "", collectionIds: [] }))).product;
}

// Seeds what a collection run leaves behind: the owner's token uploads to the name claim reserved, then settles.
async function settledWith(product: Product, image: ImageCopy): Promise<CollectionJob> {
  const jobs = createSupabaseCollectionStore(fixture.owner.client);
  const claim = await jobs.claim({ productId: product.id, generation: product.metadata.generation });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  if (image.outcome === "copied") {
    const upload = await fixture.owner.client.storage.from(PICTURE_BUCKET)
      .upload(claim.job.picture, webp, { contentType: "image/webp", upsert: false });
    if (upload.error) throw new Error(`사진을 올리지 못했습니다: ${upload.error.message}`);
  }
  await jobs.complete(claim.job, page, image);
  return claim.job;
}

describe("실제 HTTP 사진 사본", () => {
  it("보관함은 같은 출처의 사진 주소만 주고 그 주소는 서명한 비공개 사본으로 보낸다", async () => {
    const product = await saved();
    const job = await settledWith(product, { outcome: "copied" });

    const library = await get("/api/library");
    expect(library.status).toBe(200);
    const text = await library.text();
    const listed = libraryReadResponseSchema.parse(JSON.parse(text)).products.find((item) => item.id === product.id)!;
    expect(listed).toMatchObject({
      metadata: { phase: "ready", image: { outcome: "copied" } },
      picture: { src: `/api/products/${product.id}/picture?v=${job.id}` },
    });
    for (const hidden of [PICTURE_BUCKET, ".webp", "/storage/v1", "cdn.shop.example", job.picture]) expect(text).not.toContain(hidden);

    const redirect = await get(listed.picture!.src);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("cache-control")).toBe("private, max-age=3000");
    const location = new URL(redirect.headers.get("location")!);
    expect(location.origin).toBe(new URL(apiUrl).origin);
    expect(location.pathname).toBe(`/storage/v1/object/sign/${PICTURE_BUCKET}/${job.picture}`);
    const bytes = await fetch(location);
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await bytes.arrayBuffer()).equals(webp)).toBe(true);

    const anyVersion = await get(`/api/products/${product.id}/picture?v=${randomUUID()}`);
    expect(new URL(anyVersion.headers.get("location")!).pathname).toBe(location.pathname);
    expect((await fetch(new URL(`/storage/v1/object/public/${PICTURE_BUCKET}/${job.picture}`, apiUrl))).status).toBe(400);
  });

  it("사본이 없거나 상품이 없으면 404로 답하고 사진 주소가 UUID가 아니면 400이다", async () => {
    const product = await saved();
    await settledWith(product, { outcome: "failed", code: "blocked_by_site" });

    const missing = await get(`/api/products/${product.id}/picture`);
    expect(missing.status).toBe(404);
    expect(errorResponseSchema.parse(await missing.json()).error).toBe("picture_missing");
    const unknown = await get(`/api/products/${randomUUID()}/picture`);
    expect(unknown.status).toBe(404);
    expect(errorResponseSchema.parse(await unknown.json()).error).toBe("product_missing");
    expect((await get("/api/products/not-a-uuid/picture")).status).toBe(400);
  });

  it("로그인하지 않았거나 허용하지 않은 계정에는 사진을 보내지 않는다", async () => {
    const product = await saved();
    await settledWith(product, { outcome: "copied" });
    const path = `/api/products/${product.id}/picture`;

    const signedOut = await get(path, {});
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("location")).toBeNull();
    const stranger = await get(path, { cookie: cookieHeader(await signInCookies(fixture.stranger)) });
    expect(stranger.status).toBe(403);
    expect(stranger.headers.get("location")).toBeNull();
  });

  it("사진을 가져오지 못한 상품은 다시 가져오기가 202이고 다시 읽어도 링크·이름·가격은 남는다", async () => {
    const product = await saved(blockedLink);
    await settledWith(product, { outcome: "failed", code: "upload_failed" });

    const response = await fetch(new URL(`/api/products/${product.id}/metadata`, appUrl), {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    });

    expect(response.status).toBe(202);
    const retried = metadataRetryResponseSchema.parse(await response.json()).product;
    expect(retried).toMatchObject({ metadata: { phase: "queued", generation: 2 }, title: "무선 헤드폰", picture: null });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await fixture.admin.query<{ metadata_phase: string; metadata_error_code: string | null; title: string; source_url: string; price: string }>(
        `select metadata_phase, metadata_error_code, title, source_url, last_success_amount_minor as price
         from moti.products where id = $1`, [product.id],
      );
      if (rows[0].metadata_phase === "failed") {
        expect(rows[0]).toEqual({
          metadata_phase: "failed", metadata_error_code: "blocked_address", title: "무선 헤드폰", source_url: blockedLink, price: "289000",
        });
        break;
      }
      if (Date.now() > deadline) throw new Error(`10초 안에 다시 수집하지 않았습니다: ${JSON.stringify(rows[0])}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});
