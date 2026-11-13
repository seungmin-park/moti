import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectionCreateResponseSchema,
  collectionRenameResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveResponseSchema,
  productChangeResponseSchema,
  type ProductResponse,
} from "../../src/features/library/presentation/library-dto";
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

function send(method: "POST" | "PATCH", path: string, body: unknown, headers: Record<string, string> = { origin }) {
  return fetch(new URL(path, appUrl), {
    method,
    redirect: "manual",
    headers: { cookie, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function read(session = cookie) {
  const response = await fetch(new URL("/api/library", appUrl), { headers: { cookie: session } });
  expect(response.status).toBe(200);
  return libraryReadResponseSchema.parse(await response.json());
}

// Collection runs after each save and may settle at any moment, so only what the owner writes is compared.
function owned({ title, note, revision, collectionIds, purchase }: ProductResponse) {
  return { title, note, revision, collectionIds, purchase };
}

async function savedProduct(collectionIds: string[] = []) {
  const response = await send("POST", "/api/links", { url: "http://127.0.0.1:9/organize", option: "", collectionIds });
  expect(response.status).toBe(201);
  return linkSaveResponseSchema.parse(await response.json()).product;
}

async function changed(product: ProductResponse, revision: number, change: unknown) {
  const response = await send("PATCH", `/api/products/${product.id}`, { revision, change });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  return productChangeResponseSchema.parse(await response.json()).product;
}

describe("실제 HTTP 상품 정리", () => {
  it("소유자는 실제 요청으로 이름·메모·컬렉션을 고치고 구매·기록·되돌리기를 하며 새 세션에서도 같은 값을 읽는다", async () => {
    const created = await send("POST", "/api/collections", { name: "책상" });
    const desk = collectionCreateResponseSchema.parse(await created.json());
    const product = await savedProduct();

    const edited = await changed(product, 1, { type: "details", title: " 책상 조명 ", note: "선물용", collectionIds: [desk.id] });
    expect(owned(edited)).toEqual({ title: "책상 조명", note: "선물용", revision: 2, collectionIds: [desk.id], purchase: { status: "wish" } });

    await changed(product, 2, { type: "purchase" });
    const recorded = await changed(product, 3, { type: "purchase.record", date: "2026-11-01", price: { amountMinor: 0, currency: "KRW" } });
    const nextSession = cookieHeader(await signInCookies(fixture.owner));
    expect((await read(nextSession)).products.map(owned)).toEqual([owned(recorded)]);
    expect(recorded.purchase).toEqual({ status: "purchased", date: "2026-11-01", price: { amountMinor: 0, currency: "KRW" } });

    const wish = await changed(product, 4, { type: "wish" });
    expect(owned(wish)).toEqual({ title: "책상 조명", note: "선물용", revision: 5, collectionIds: [desk.id], purchase: { status: "wish" } });
    expect((await read()).products.map(owned)).toEqual([owned(wish)]);
  });

  it("다른 곳에서 먼저 바뀐 상품을 오래된 revision으로 고치면 계약에 맞는 409 revision_conflict이고 저장은 그대로다", async () => {
    const product = await savedProduct();
    const first = await changed(product, 1, { type: "details", title: null, note: "먼저", collectionIds: [] });

    const late = await send("PATCH", `/api/products/${product.id}`, { revision: 1, change: { type: "details", title: null, note: "늦게", collectionIds: [] } });

    expect(late.status).toBe(409);
    expect(late.headers.get("cache-control")).toContain("no-store");
    expect(errorResponseSchema.parse(await late.json()).error).toBe("revision_conflict");
    expect((await read()).products.map(owned)).toEqual([owned(first)]);
  });

  it("업무 규칙에 맞지 않는 구매일은 필드와 함께 400이고 저장하지 않는다", async () => {
    const product = await savedProduct();
    const purchased = await changed(product, 1, { type: "purchase" });

    const response = await send("PATCH", `/api/products/${product.id}`, { revision: 2, change: { type: "purchase.record", date: "2999-01-01", price: null } });

    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(await response.json())).toMatchObject({ error: "invalid_input", field: "date" });
    expect((await read()).products.map(owned)).toEqual([owned(purchased)]);
  });

  it("다른 출처의 PATCH는 소유자 세션이어도 403이고 상품과 컬렉션을 바꾸지 않는다", async () => {
    const created = await send("POST", "/api/collections", { name: "책상" });
    const desk = collectionCreateResponseSchema.parse(await created.json());
    const product = await savedProduct();
    const evil = { origin: "https://evil.example" };

    const productResponse = await send("PATCH", `/api/products/${product.id}`, { revision: 1, change: { type: "purchase" } }, evil);
    const collectionResponse = await send("PATCH", `/api/collections/${desk.id}`, { revision: 1, name: "가져가기" }, evil);

    for (const response of [productResponse, collectionResponse]) {
      expect(response.status).toBe(403);
      expect(errorResponseSchema.parse(await response.json()).error).toBe("cross_origin");
    }
    const library = await read();
    expect(library.collections).toEqual([desk]);
    expect(library.products.map(owned)).toEqual([owned(product)]);
  });
});

describe("실제 HTTP 컬렉션 이름 바꾸기", () => {
  it("이름을 바꾸면 200이고 새 세션에서도 소속 상품과 함께 새 이름을 읽으며, 다른 컬렉션과 대소문자만 다른 이름은 409다", async () => {
    const desk = collectionCreateResponseSchema.parse(await (await send("POST", "/api/collections", { name: "Desk" })).json());
    await send("POST", "/api/collections", { name: "Room" });
    const product = await savedProduct([desk.id]);

    const renamed = await send("PATCH", `/api/collections/${desk.id}`, { revision: 1, name: " Studio " });
    expect(renamed.status).toBe(200);
    expect(collectionRenameResponseSchema.parse(await renamed.json())).toMatchObject({ id: desk.id, name: "Studio", revision: 2 });

    const duplicate = await send("PATCH", `/api/collections/${desk.id}`, { revision: 2, name: "ROOM" });
    expect(duplicate.status).toBe(409);
    expect(errorResponseSchema.parse(await duplicate.json()).error).toBe("collection_duplicate");

    const library = await read(cookieHeader(await signInCookies(fixture.owner)));
    expect(library.collections.map(({ name }) => name)).toEqual(["Studio", "Room"]);
    expect(library.products.find((item) => item.id === product.id)?.collectionIds).toEqual([desk.id]);
  });
});
