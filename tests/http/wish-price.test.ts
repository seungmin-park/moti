import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveResponseSchema,
  productChangeResponseSchema,
  type ProductResponse,
} from "../../src/features/library/presentation/library-dto";
import { readLibraryBackup } from "../../src/features/library/presentation/library-backup";
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
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(session = cookie) {
  const response = await fetch(new URL("/api/library", appUrl), { headers: { cookie: session } });
  expect(response.status).toBe(200);
  return libraryReadResponseSchema.parse(await response.json());
}

async function savedProduct() {
  // A loopback link: collection refuses it, so only the owner's values change.
  const response = await send("POST", "/api/links", { url: "http://127.0.0.1:9/switches", option: "", collectionIds: [] });
  expect(response.status).toBe(201);
  return linkSaveResponseSchema.parse(await response.json()).product;
}

const patchPrice = (product: ProductResponse, revision: number, price: unknown, headers?: Record<string, string>) =>
  send("PATCH", `/api/products/${product.id}`, { revision, change: { type: "wish.price", price } }, headers);

describe("실제 HTTP 내가 살 가격", () => {
  it("소유자는 실제 요청으로 내가 살 가격을 저장·지우고, 새 세션에서도 같은 값을 읽으며 자동 확인 가격과 따로 받는다", async () => {
    const product = await savedProduct();

    const saved = await patchPrice(product, 1, { amountMinor: 3000, currency: "KRW" });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toContain("no-store");
    const priced = productChangeResponseSchema.parse(await saved.json()).product;
    expect(priced).toMatchObject({ revision: 2, wishPrice: { amountMinor: 3000, currency: "KRW" }, lastSuccessfulPrice: null });

    const nextSession = cookieHeader(await signInCookies(fixture.owner));
    expect((await read(nextSession)).products[0]).toMatchObject({ id: product.id, revision: 2, wishPrice: { amountMinor: 3000, currency: "KRW" } });

    const cleared = productChangeResponseSchema.parse(await (await patchPrice(product, 2, null)).json()).product;
    expect(cleared).toMatchObject({ revision: 3, wishPrice: null });
    expect((await read()).products[0].wishPrice).toBeNull();
  });

  it("규칙에 맞지 않는 가격은 400 invalid_input(field wishPrice)이고, 오래된 revision은 409, 다른 출처는 403이며 저장은 그대로다", async () => {
    const product = await savedProduct();
    await patchPrice(product, 1, { amountMinor: 3000, currency: "KRW" });

    for (const price of [{ amountMinor: -1, currency: "KRW" }, { amountMinor: 1.5, currency: "KRW" }, { amountMinor: 1000, currency: "USD" }]) {
      const refused = await patchPrice(product, 2, price);
      expect(refused.status).toBe(400);
      expect(errorResponseSchema.parse(await refused.json())).toMatchObject({ error: "invalid_input", field: "wishPrice" });
    }
    const late = await patchPrice(product, 1, { amountMinor: 5000, currency: "KRW" });
    expect(late.status).toBe(409);
    expect(errorResponseSchema.parse(await late.json()).error).toBe("revision_conflict");
    const foreign = await patchPrice(product, 2, null, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);

    expect((await read()).products[0]).toMatchObject({ revision: 2, wishPrice: { amountMinor: 3000, currency: "KRW" } });
  });

  it("백업 파일에 내가 살 가격이 담기고, 가격이 없는 이전 버전 1 파일로 복원하면 가격이 없어진다", async () => {
    const product = await savedProduct();
    await patchPrice(product, 1, { amountMinor: 3000, currency: "KRW" });

    const exported = await fetch(new URL("/api/library/backup", appUrl), { headers: { cookie } });
    expect(exported.status).toBe(200);
    const text = await exported.text();
    const reading = readLibraryBackup(JSON.parse(text));
    if (!reading.ok) throw new Error(`백업을 읽지 못했습니다: ${reading.problem}`);
    expect(reading.document.products[0].wishPrice).toEqual({ amountMinor: 3000, currency: "KRW" });

    const { wishPrice, ...before } = reading.document.products[0];
    void wishPrice;
    const older = JSON.stringify({ ...reading.document, products: [before] });
    const restored = await send("POST", "/api/library/restore", older);
    expect(restored.status).toBe(200);
    expect(libraryReadResponseSchema.parse(await restored.json()).products[0]).toMatchObject({ id: product.id, wishPrice: null });

    const again = await send("POST", "/api/library/restore", text);
    expect(again.status).toBe(200);
    expect(libraryReadResponseSchema.parse(await again.json()).products[0]).toMatchObject({ id: product.id, wishPrice: { amountMinor: 3000, currency: "KRW" } });
  });
});
