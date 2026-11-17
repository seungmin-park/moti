import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import {
  MAX_PICTURE_PASTE_BYTES,
  errorResponseSchema,
  libraryReadResponseSchema,
  productChangeResponseSchema,
} from "../../src/features/library/presentation/library-dto";
import type { CollectionJob } from "../../src/features/metadata/application/collection";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { cookieHeader, signInCookies } from "../support/session";

const { appUrl } = readDatabaseConfig();
const origin = new URL(appUrl).origin;

let fixture: DatabaseFixture;
let cookie: string;
let png: Buffer;
let webp: Buffer;
beforeAll(async () => {
  // A 2000×1500 picture with a gradient, so it is not trivially small, and EXIF that must not survive.
  png = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#8a7f72" } })
    .composite([{ input: Buffer.from('<svg width="2000" height="1500"><rect x="100" y="100" width="900" height="700" fill="#334455"/></svg>') }])
    .withExif({ IFD0: { Copyright: "secret-owner" } })
    .png()
    .toBuffer();
  webp = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#445566" } }).webp().toBuffer();
});
beforeEach(async () => {
  fixture = await createDatabaseFixture({ ownerGoogleSubject: HTTP_OWNER_SUBJECT });
  cookie = cookieHeader(await signInCookies(fixture.owner));
});
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

async function saved(): Promise<Product> {
  return (await createSupabaseLibraryStore(fixture.owner.client)
    .saveLink(toLinkSaveCommand({ url: `https://shop.example/${randomUUID()}`, option: "", collectionIds: [] }))).product;
}

// What a collection run leaves behind: a copy uploaded under the claim's name and settled.
async function collected(product: Product): Promise<CollectionJob> {
  const jobs = createSupabaseCollectionStore(fixture.owner.client);
  const claim = await jobs.claim({ productId: product.id, generation: product.metadata.generation });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  const upload = await fixture.owner.client.storage.from(PICTURE_BUCKET).upload(claim.job.picture, webp, { contentType: "image/webp" });
  if (upload.error) throw new Error(upload.error.message);
  await jobs.complete(claim.job, { title: "무선 헤드폰", price: null, imageSourceUrl: "https://cdn.shop.example/a.jpg" }, { outcome: "copied" });
  return claim.job;
}

const put = (productId: string, body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(new URL(`/api/products/${productId}/picture`, appUrl), {
    method: "PUT",
    redirect: "manual",
    headers: { cookie, origin, "content-type": "image/png", ...headers },
    body,
  });
const remove = (productId: string, headers: Record<string, string> = { cookie, origin }) =>
  fetch(new URL(`/api/products/${productId}/picture`, appUrl), { method: "DELETE", redirect: "manual", headers });
const get = (path: string) => fetch(new URL(path, appUrl), { redirect: "manual", headers: { cookie } });

async function stored(): Promise<string[]> {
  const { rows } = await fixture.admin.query<{ name: string }>(
    "select name from storage.objects where bucket_id = $1 and starts_with(name, $2) order by name",
    [PICTURE_BUCKET, `${fixture.owner.id}/`],
  );
  return rows.map((row) => row.name);
}

async function refused(response: Response) {
  return { status: response.status, body: errorResponseSchema.parse(await response.json()) };
}

describe("실제 HTTP 사진 붙여넣기", () => {
  it("붙여 넣은 PNG를 같은 과정으로 WebP 사본으로 만들고 상품이 그 사본을 같은 출처 주소로 보인다", async () => {
    const product = await saved();

    const response = await put(product.id, new Uint8Array(png));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const pasted = productChangeResponseSchema.parse(JSON.parse(text)).product;
    expect(pasted.revision).toBe(product.revision + 1);
    expect(pasted.picture).toEqual({ src: expect.stringMatching(new RegExp(`^/api/products/${product.id}/picture\\?v=`)), pasted: true });
    const names = await stored();
    expect(names).toHaveLength(1);
    for (const hidden of [PICTURE_BUCKET, ".webp", "/storage/v1", names[0]]) expect(text).not.toContain(hidden);

    const redirect = await get(pasted.picture!.src);
    expect(redirect.status).toBe(302);
    const bytes = Buffer.from(await (await fetch(redirect.headers.get("location")!)).arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 1200, height: 900 });
    expect(metadata.exif).toBeUndefined();

    const library = libraryReadResponseSchema.parse(await (await get("/api/library")).json());
    expect(library.products.find((item) => item.id === product.id)!.picture).toEqual(pasted.picture);
  });

  it("수집이 새 사본을 가져와도 붙여 넣은 사진이 보이고, 지우면 가져온 사본으로 돌아가며 지운 사본은 Storage에서 바로 사라진다", async () => {
    const product = await saved();
    const job = await collected(product);
    const pasted = productChangeResponseSchema.parse(await (await put(product.id, new Uint8Array(png))).json()).product;
    expect(await stored()).toHaveLength(2);
    // A later collection settles a newer copy; the pasted picture still leads.
    await fixture.admin.query(
      "update moti.products set metadata_image = 'failed', metadata_image_error_code = 'timeout' where id = $1", [product.id],
    );
    const retried = await createSupabaseCollectionStore(fixture.owner.client).retry({ productId: product.id, expectedGeneration: 1 });
    const newer = await collected(retried.product);
    const library = libraryReadResponseSchema.parse(await (await get("/api/library")).json());
    expect(library.products.find((item) => item.id === product.id)!.picture).toEqual(pasted.picture);

    const cleared = await remove(product.id);
    expect(cleared.status).toBe(200);
    expect(productChangeResponseSchema.parse(await cleared.json()).product.picture).toEqual({
      src: `/api/products/${product.id}/picture?v=${newer.id}`, pasted: false,
    });
    // The pasted copy goes at once; the first collected copy is the one the newer collection replaced.
    expect(await stored()).toEqual([job.picture, newer.picture].toSorted());
  });

  it("다시 붙여 넣으면 이전에 붙여 넣은 사본은 Storage에서 바로 사라진다", async () => {
    const product = await saved();
    await put(product.id, new Uint8Array(png));
    const first = await stored();

    const second = await put(product.id, new Uint8Array(webp), { "content-type": "image/webp" });

    expect(second.status).toBe(200);
    const now = await stored();
    expect(now).toHaveLength(1);
    expect(now).not.toEqual(first);
  });

  it.each([
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), "image/svg+xml",
      "JPEG·PNG·WebP·GIF·AVIF 사진만 붙여 넣을 수 있어요."],
    ["HEIC", Buffer.from("000000186674797068656963000000006d69663168656963", "hex"), "image/heic",
      "JPEG·PNG·WebP·GIF·AVIF 사진만 붙여 넣을 수 있어요."],
    ["잘린 JPEG", Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb", "hex"), "image/jpeg",
      "사진을 읽지 못했어요. 다른 사진을 복사해 주세요."],
  ])("%s는 400 invalid_input과 picture 칸의 안내이고 아무것도 올리지 않는다", async (_name, bytes, type, message) => {
    const product = await saved();

    expect(await refused(await put(product.id, new Uint8Array(bytes), { "content-type": type }))).toEqual({
      status: 400, body: { error: "invalid_input", message, field: "picture" },
    });
    expect(await stored()).toEqual([]);
  });

  it("25 MP를 넘는 사진은 413이고, 4 MiB를 넘는 본문은 읽지 않고 413이다", async () => {
    const product = await saved();
    const huge = await sharp({ create: { width: 6000, height: 5000, channels: 3, background: "#ffffff" } }).png().toBuffer();
    expect(huge.byteLength).toBeLessThan(MAX_PICTURE_PASTE_BYTES);

    expect(await refused(await put(product.id, new Uint8Array(huge)))).toEqual({
      status: 413, body: { error: "payload_too_large", message: "사진이 너무 커요. 더 작은 사진을 복사해 주세요.", field: "picture" },
    });
    expect(await refused(await put(product.id, new Uint8Array(MAX_PICTURE_PASTE_BYTES + 1)))).toEqual({
      status: 413, body: { error: "payload_too_large", message: "사진이 너무 커요. 4MB보다 작은 사진을 붙여 넣어 주세요.", field: "picture" },
    });
    expect(await stored()).toEqual([]);
  });

  it("이미지가 아닌 형식은 415, 상품 ID가 UUID가 아니면 400, 없는 상품은 404다", async () => {
    const product = await saved();

    expect((await refused(await put(product.id, "hello", { "content-type": "text/plain" }))).status).toBe(415);
    expect((await put("not-a-uuid", new Uint8Array(png))).status).toBe(400);
    expect(await refused(await put(randomUUID(), new Uint8Array(png)))).toMatchObject({ status: 404, body: { error: "product_missing" } });
    expect((await refused(await remove(randomUUID()))).body.error).toBe("product_missing");
    expect(await stored()).toEqual([]);
  });

  it("로그인하지 않았거나 다른 계정이거나 다른 출처이면 올리지도 지우지도 않는다", async () => {
    const product = await saved();
    await put(product.id, new Uint8Array(webp), { "content-type": "image/webp" });
    const before = await stored();
    const strangerCookie = cookieHeader(await signInCookies(fixture.stranger));

    expect((await put(product.id, new Uint8Array(png), { cookie: "" })).status).toBe(401);
    expect((await put(product.id, new Uint8Array(png), { cookie: strangerCookie })).status).toBe(403);
    expect((await refused(await put(product.id, new Uint8Array(png), { origin: "https://evil.example" }))).body.error).toBe("cross_origin");
    expect((await remove(product.id, { origin })).status).toBe(401);
    expect((await remove(product.id, { cookie, origin: "https://evil.example" })).status).toBe(403);

    expect(await stored()).toEqual(before);
    const library = libraryReadResponseSchema.parse(await (await get("/api/library")).json());
    expect(library.products.find((item) => item.id === product.id)!.picture?.pasted).toBe(true);
  });
});
