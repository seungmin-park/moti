import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectionCreateResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveResponseSchema,
  productChangeResponseSchema,
  productDeleteResponseSchema,
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

function send(method: "POST" | "PATCH" | "DELETE", path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(new URL(path, appUrl), {
    method,
    redirect: "manual",
    headers: { cookie, origin, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(session = cookie) {
  const response = await fetch(new URL("/api/library", appUrl), { headers: { cookie: session } });
  expect(response.status).toBe(200);
  return libraryReadResponseSchema.parse(await response.json());
}

async function savedProduct(path: string, collectionIds: string[] = []) {
  const response = await send("POST", "/api/links", { url: `http://127.0.0.1:9/${path}`, option: "", collectionIds });
  expect(response.status).toBe(201);
  return linkSaveResponseSchema.parse(await response.json()).product;
}

describe("실제 HTTP 상품 삭제", () => {
  it("소유자가 화면이 본 revision으로 DELETE하면 200과 id를 받고 새 세션의 보관함에서도 상품과 소속이 사라진다", async () => {
    const desk = collectionCreateResponseSchema.parse(await (await send("POST", "/api/collections", { name: "책상" })).json());
    const product = await savedProduct("delete", [desk.id]);
    const kept = await savedProduct("keep", [desk.id]);

    const response = await send("DELETE", `/api/products/${product.id}`, { revision: 1 });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(productDeleteResponseSchema.parse(await response.json())).toEqual({ id: product.id });
    const library = await read(cookieHeader(await signInCookies(fixture.owner)));
    expect(library.products.map(({ id }) => id)).toEqual([kept.id]);
    expect(library.collections).toEqual([desk]);
  });

  it("다른 곳에서 먼저 바뀐 상품을 오래된 revision으로 지우면 409 revision_conflict이고, 지운 상품을 다시 지우면 404 product_missing이다", async () => {
    const product = await savedProduct("conflict");
    const purchased = await send("PATCH", `/api/products/${product.id}`, { revision: 1, change: { type: "purchase" } });
    const latest = productChangeResponseSchema.parse(await purchased.json()).product;

    const late = await send("DELETE", `/api/products/${product.id}`, { revision: 1 });
    expect(late.status).toBe(409);
    expect(late.headers.get("cache-control")).toContain("no-store");
    expect(errorResponseSchema.parse(await late.json()).error).toBe("revision_conflict");
    expect((await read()).products.map(({ id }) => id)).toEqual([product.id]);

    expect((await send("DELETE", `/api/products/${product.id}`, { revision: latest.revision })).status).toBe(200);
    const again = await send("DELETE", `/api/products/${product.id}`, { revision: latest.revision });
    expect(again.status).toBe(404);
    expect(errorResponseSchema.parse(await again.json()).error).toBe("product_missing");
  });

  it("지운 뒤 같은 링크를 다시 담으면 201로 새 상품이 된다", async () => {
    const first = await savedProduct("again");
    expect((await send("DELETE", `/api/products/${first.id}`, { revision: 1 })).status).toBe(200);
    const again = await savedProduct("again");
    expect(again.id).not.toBe(first.id);
    expect(again.revision).toBe(1);
  });

  it.each([
    ["revision 없는 본문", {}, "application/json", 400, "invalid_input"],
    ["0 revision", { revision: 0 }, "application/json", 400, "invalid_input"],
    ["JSON이 아닌 본문", "revision=1", "text/plain", 415, "unsupported_media_type"],
  ])("Given %s When DELETE하면 Then 계약에 맞는 오류이고 상품을 지우지 않는다", async (_, body, type, status, code) => {
    const product = await savedProduct("invalid");
    const response = await send("DELETE", `/api/products/${product.id}`, body, { "content-type": type });
    expect(response.status).toBe(status);
    expect(errorResponseSchema.parse(await response.json()).error).toBe(code);
    expect((await read()).products.map(({ id }) => id)).toEqual([product.id]);
  });

  it("다른 출처의 DELETE는 소유자 세션이어도 403이고, 세션 없는 DELETE는 401이며 상품은 남는다", async () => {
    const product = await savedProduct("cross");

    const cross = await send("DELETE", `/api/products/${product.id}`, { revision: 1 }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    expect(errorResponseSchema.parse(await cross.json()).error).toBe("cross_origin");
    const anonymous = await send("DELETE", `/api/products/${product.id}`, { revision: 1 }, { cookie: "" });
    expect(anonymous.status).toBe(401);
    expect(errorResponseSchema.parse(await anonymous.json()).error).toBe("signed_out");

    expect((await read()).products.map(({ id }) => id)).toEqual([product.id]);
  });
});
