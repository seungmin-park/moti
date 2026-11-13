import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import { PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import {
  MAX_BACKUP_BYTES,
  readLibraryBackup,
  toLibraryBackupDocument,
  type LibraryBackupDocument,
} from "../../src/features/library/presentation/library-backup";
import {
  collectionCreateResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveResponseSchema,
  type LibraryReadResponse,
} from "../../src/features/library/presentation/library-dto";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { cookieHeader, signInCookies } from "../support/session";

const { appUrl } = readDatabaseConfig();
const origin = new URL(appUrl).origin;

let fixture: DatabaseFixture;
let cookie: string;
beforeEach(async () => {
  fixture = await createDatabaseFixture({ ownerGoogleSubject: HTTP_OWNER_SUBJECT });
  cookie = cookieHeader(await signInCookies(fixture.owner));
});
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

function send(method: "POST" | "PATCH", path: string, body: unknown) {
  return fetch(new URL(path, appUrl), {
    method,
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const post = (path: string, body: unknown) => send("POST", path, body);

function restore(body: BodyInit, headers: Record<string, string> = {}) {
  return fetch(new URL("/api/library/restore", appUrl), {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

async function read(): Promise<LibraryReadResponse> {
  const response = await fetch(new URL("/api/library", appUrl), { headers: { cookie } });
  expect(response.status).toBe(200);
  return libraryReadResponseSchema.parse(await response.json());
}

// Collection runs after each save and may settle at any moment, so only what the owner sees or sets is compared.
function owned(library: LibraryReadResponse) {
  const names = new Map(library.collections.map(({ id, name }) => [id, name]));
  return {
    collections: library.collections.map(({ name, createdAt }) => ({ name, createdAt })),
    products: library.products.map(({ sourceUrl, option, title, note, collectionIds, addedAt, purchase }) => ({
      sourceUrl, option, title, note, collections: collectionIds.map((id) => names.get(id)).toSorted(), addedAt, purchase,
    })),
  };
}

const download = (session = cookie) => fetch(new URL("/api/library/backup", appUrl), { headers: { cookie: session } });

async function backupText(): Promise<string> {
  const response = await download();
  expect(response.status).toBe(200);
  return response.text();
}

const withoutTime = (text: string) => ({ ...(JSON.parse(text) as LibraryBackupDocument), exportedAt: undefined });

describe("실제 HTTP 백업 내려받기", () => {
  it("소유자는 서울 시각 이름의 첨부 파일로 저장한 링크와 컬렉션을 담은 백업을 받는다", async () => {
    const desk = collectionCreateResponseSchema.parse(await (await post("/api/collections", { name: "책상" })).json());
    expect((await post("/api/links", { url: "http://127.0.0.1:9/backup?utm_source=x", option: "M", collectionIds: [desk.id] })).status).toBe(201);

    const response = await download();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="moti-backup-\d{8}-\d{4}\.json"$/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const reading = readLibraryBackup(JSON.parse(await response.text()));
    if (!reading.ok) throw new Error(`백업을 읽지 못했습니다: ${reading.problem} ${reading.path}`);
    expect(reading.document.collections).toEqual([{ name: "책상", createdAt: desk.createdAt }]);
    expect(reading.document.products).toEqual([expect.objectContaining({
      sourceUrl: "http://127.0.0.1:9/backup?utm_source=x", option: "M", ownerTitle: null, note: "", collections: ["책상"],
      purchase: { status: "wish" },
    })]);
  });

  it("세션이 없으면 첨부 파일 대신 401 JSON 오류다", async () => {
    const response = await download("");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(errorResponseSchema.parse(await response.json()).error).toBe("signed_out");
  });
});

describe("실제 HTTP 복원", () => {
  async function arranged() {
    const desk = collectionCreateResponseSchema.parse(await (await post("/api/collections", { name: "책상" })).json());
    const saved = await post("/api/links", { url: "http://127.0.0.1:9/restore?utm_source=x", option: "", collectionIds: [desk.id] });
    const product = linkSaveResponseSchema.parse(await saved.json()).product;
    expect((await send("PATCH", `/api/products/${product.id}`, {
      revision: 1, change: { type: "details", title: "책상 조명", note: "처음 메모", collectionIds: [desk.id] },
    })).status).toBe(200);
    return { desk, product };
  }

  it("소유자는 내려받은 파일로 바뀐 보관함을 되돌리고 같은 파일을 다시 내려받는다", async () => {
    const { product } = await arranged();
    const before = owned(await read());
    const text = await backupText();
    await send("PATCH", `/api/products/${product.id}`, { revision: 2, change: { type: "details", title: null, note: "바꾼 메모", collectionIds: [] } });
    expect((await post("/api/links", { url: "http://127.0.0.1:9/later", option: "", collectionIds: [] })).status).toBe(201);
    expect((await post("/api/collections", { name: "임시" })).status).toBe(201);

    const response = await restore(text);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const restored = libraryReadResponseSchema.parse(await response.json());
    expect(owned(restored)).toEqual(before);
    expect(restored.products.map(({ id, revision }) => ({ id, revision }))).toEqual([{ id: product.id, revision: 4 }]);
    expect(owned(await read())).toEqual(before);
    expect(withoutTime(await backupText())).toEqual(withoutTime(text));
  });

  it.each([
    ["선언한 길이", () => " ".repeat(MAX_BACKUP_BYTES + 1)],
    ["길이 없이 흘려보낸 본문", () => new Blob([" ".repeat(MAX_BACKUP_BYTES + 1)]).stream()],
  ])("4MiB를 넘는 %s은 413이고 보관함을 바꾸지 않는다", async (_, body) => {
    await arranged();
    const before = owned(await read());

    const response = await restore(body());

    expect(response.status).toBe(413);
    expect(errorResponseSchema.parse(await response.json()).error).toBe("payload_too_large");
    expect(owned(await read())).toEqual(before);
  });

  it("다른 출처·JSON이 아닌 형식·바뀐 파일·세션 없음은 거절하고 보관함을 바꾸지 않는다", async () => {
    await arranged();
    const before = owned(await read());
    const text = await backupText();
    const tampered = JSON.parse(text) as LibraryBackupDocument;
    tampered.products.push({ ...tampered.products[0], sourceUrl: "http://127.0.0.1:9/restore?utm_source=y" });

    const crossOrigin = await restore(text, { origin: "https://evil.example" });
    const plain = await restore(text, { "content-type": "text/plain" });
    const changed = await restore(JSON.stringify(tampered));
    const signedOut = await fetch(new URL("/api/library/restore", appUrl), {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: text,
    });

    expect([crossOrigin.status, plain.status, changed.status, signedOut.status]).toEqual([403, 415, 400, 401]);
    expect(errorResponseSchema.parse(await changed.json())).toMatchObject({ error: "invalid_input", field: "products.1.sourceUrl" });
    expect(owned(await read())).toEqual(before);
  });

  it("복원한 뒤 응답 밖에서 파일에 없는 상품의 사진 사본을 버린다", async () => {
    const store = createSupabaseLibraryStore(fixture.owner.client);
    const jobs = createSupabaseCollectionStore(fixture.owner.client);
    const { product } = await store.saveLink(toLinkSaveCommand({ url: "https://shop.example/pictured", option: "", collectionIds: [] }));
    const claim = await jobs.claim({ productId: product.id, generation: 1 });
    if (claim.kind !== "claimed") throw new Error("작업을 맡지 못했습니다.");
    const webp = Buffer.from("524946461a000000574542505650384c0d0000002f0000001007101111888808", "hex");
    expect((await fixture.owner.client.storage.from(PICTURE_BUCKET).upload(claim.job.picture, webp, { contentType: "image/webp" })).error).toBeNull();
    await jobs.complete(claim.job, { title: "사진 있는 상품", price: null, imageSourceUrl: "https://cdn.shop.example/a.jpg" }, { outcome: "copied" });
    const objects = async () => (await fixture.admin.query(
      "select name from storage.objects where bucket_id = $1 and name = $2", [PICTURE_BUCKET, claim.job.picture],
    )).rows.length;
    expect(await objects()).toBe(1);

    const response = await restore(JSON.stringify(toLibraryBackupDocument({ collections: [], products: [] }, new Date())));

    expect(response.status).toBe(200);
    expect(libraryReadResponseSchema.parse(await response.json())).toEqual({ products: [], collections: [] });
    const deadline = Date.now() + 10_000;
    while (await objects() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await objects()).toBe(0);
  });
});
