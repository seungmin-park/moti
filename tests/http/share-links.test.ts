import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { errorResponseSchema, libraryReadResponseSchema, metadataWakeResponseSchema } from "../../src/features/library/presentation/library-dto";
import {
  shareLinkAddResponseSchema,
  shareLinkErrorResponseSchema,
} from "../../src/features/share/presentation/share-dto";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { cookieHeader, signInCookies, withExpiredAccessToken } from "../support/session";

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

async function issue(replaces: string | null = null): Promise<{ key: { id: string }; secret: string }> {
  const { data, error } = await fixture.owner.client.rpc("moti_share_key_issue", { p_replaces: replaces });
  if (error) throw new Error(`키를 만들지 못했습니다: ${error.code}`);
  return data;
}

// The Shortcut's request: a bearer key, JSON with one url, no cookie and no Origin.
function shortcut(key: string, body: unknown = { url: "https://shop.example/lamp?utm_source=share" }, headers: Record<string, string> = {}) {
  return fetch(new URL("/api/share/links", appUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function library() {
  const response = await fetch(new URL("/api/library", appUrl), { headers: { cookie } });
  expect(response.status).toBe(200);
  return libraryReadResponseSchema.parse(await response.json());
}

async function stored() {
  const { rows } = await fixture.admin.query(
    `select p.id, p.source_url, p.note, p.revision, p.purchase_status,
       (select count(*)::int from moti.metadata_jobs j where j.product_id = p.id) as jobs
     from moti.products p where p.owner_id = $1 order by p.id`,
    [fixture.owner.id],
  );
  const collections = await fixture.admin.query("select id, name, revision from moti.collections where owner_id = $1 order by id", [fixture.owner.id]);
  const keys = await fixture.admin.query("select id, revoked_at, last_used_at from moti.share_keys where owner_id = $1 order by id", [fixture.owner.id]);
  return { products: rows, collections: collections.rows, keys: keys.rows };
}

function expectNoSession(response: Response) {
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

describe("실제 HTTP 단축어 경로", () => {
  it("소유자가 만든 키로 단축어처럼 담으면 201이고 보관함에는 수집을 기다리는 상품으로 보이며, 다시 담으면 200이다", async () => {
    const { secret } = await issue();

    const added = await shortcut(secret);

    expect(added.status).toBe(201);
    expectNoSession(added);
    expect(shareLinkAddResponseSchema.parse(await added.json())).toEqual({
      result: "added",
      message: "위시에 담았어요. 상품 정보는 moti를 열면 가져와요.",
    });
    const { products } = await library();
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      sourceUrl: "https://shop.example/lamp?utm_source=share",
      identityUrl: "https://shop.example/lamp",
      title: "새로 담은 상품",
      metadata: { phase: "queued", generation: 1, attempts: 0, stalled: false },
    });

    const repeated = await shortcut(secret, { url: "https://shop.example/lamp" });
    expect(repeated.status).toBe(200);
    expect(shareLinkAddResponseSchema.parse(await repeated.json())).toEqual({ result: "duplicate", message: "이미 담아둔 상품이에요." });
    expect((await library()).products).toHaveLength(1);
  });

  it("폐기한 키, 모르는 키와 형식이 틀린 키는 바이트까지 같은 401이고 아무것도 담지 않는다", async () => {
    const issued = await issue();
    await fixture.owner.client.rpc("moti_share_key_revoke", { p_key_id: issued.key.id });

    const responses = await Promise.all([
      shortcut(issued.secret),
      shortcut(`moti_sk_${randomBytes(32).toString("base64url")}`),
      shortcut("nope"),
      fetch(new URL("/api/share/links", appUrl), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    ]);

    const bodies = await Promise.all(responses.map((response) => response.text()));
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expectNoSession(response);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(shareLinkErrorResponseSchema.parse(JSON.parse(bodies[0])).error).toBe("share_key_rejected");
    expect((await stored()).products).toEqual([]);
  });

  it("키는 세션이 아니다: 같은 출처 Origin과 키만으로 소유자 경로를 부르면 모두 401 signed_out이고 DB는 그대로다", async () => {
    const { key, secret } = await issue();
    const owner = createSupabaseLibraryStore(fixture.owner.client);
    const collection = await owner.createCollection({ name: "책상" });
    const { product } = await owner.saveLink(toLinkSaveCommand({ url: "https://shop.example/desk", option: "", collectionIds: [] }));
    const before = await stored();
    const routes: [string, string, unknown][] = [
      ["GET", "/api/library", undefined],
      ["GET", "/api/library/backup", undefined],
      ["POST", "/api/library/restore", { format: "moti.library-backup", version: 1, exportedAt: "2026-11-13T00:00:00.000Z", collections: [], products: [] }],
      ["POST", "/api/links", { url: "https://shop.example/chair", option: "", collectionIds: [] }],
      ["PATCH", `/api/products/${product.id}`, { revision: 1, change: { type: "purchase" } }],
      ["POST", `/api/products/${product.id}/metadata`, { generation: 1 }],
      ["POST", "/api/collections", { name: "거실" }],
      ["PATCH", `/api/collections/${collection.id}`, { revision: 1, name: "서재" }],
      ["GET", "/api/share-keys", undefined],
      ["POST", "/api/share-keys", { replaces: null }],
      ["DELETE", `/api/share-keys/${key.id}`, undefined],
      ["POST", "/api/library/metadata", {}],
    ];

    for (const [method, path, body] of routes) {
      const response = await fetch(new URL(path, appUrl), {
        method,
        headers: { authorization: `Bearer ${secret}`, origin, ...(body !== undefined && { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(errorResponseSchema.parse(await response.json()).error, `${method} ${path}`).toBe("signed_out");
    }
    expect(await stored()).toEqual(before);
  });

  it("쿠키는 이 경로의 인증이 아니다: 소유자 쿠키만으로는 401이고, 만료된 세션 쿠키와 키를 함께 보내면 키로 담고 쿠키를 건드리지 않는다", async () => {
    const { secret } = await issue();

    const cookieOnly = await fetch(new URL("/api/share/links", appUrl), {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://shop.example/lamp" }),
    });
    expect(cookieOnly.status).toBe(401);
    expect(shareLinkErrorResponseSchema.parse(await cookieOnly.json()).error).toBe("share_key_rejected");
    expect((await stored()).products).toEqual([]);

    const expired = cookieHeader(withExpiredAccessToken(await signInCookies(fixture.owner)));
    const both = await shortcut(secret, { url: "https://shop.example/lamp" }, { cookie: expired, origin });
    expect(both.status).toBe(201);
    expectNoSession(both);
    expect((await stored()).products).toHaveLength(1);
  });

  it("다른 사이트의 사전 요청과 요청에는 CORS 허용 헤더를 주지 않는다", async () => {
    const { secret } = await issue();
    const preflight = await fetch(new URL("/api/share/links", appUrl), {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
    expect(preflight.headers.get("allow")).toContain("POST");

    const crossSite = await shortcut(secret, { url: "https://shop.example/lamp" }, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(201);
    expect(crossSite.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("소유자 화면이 깨우면 키로 담은 상품의 수집이 응답 뒤에 시작되고, 다시 깨우면 깨울 것이 없다", async () => {
    const { secret } = await issue();
    // A loopback address the production fetch policy refuses: the run settles as failed without leaving this machine.
    const blockedLink = "http://127.0.0.1:9/p";
    expect((await shortcut(secret, { url: blockedLink })).status).toBe(201);
    const [product] = (await library()).products;
    expect(product.metadata).toEqual({ phase: "queued", generation: 1, attempts: 0, stalled: false });

    const wake = () => fetch(new URL("/api/library/metadata", appUrl), {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    });
    const response = await wake();

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(metadataWakeResponseSchema.parse(await response.json()).products.map(({ id }) => id)).toEqual([product.id]);
    await expect.poll(async () => (await fixture.admin.query<{ phase: string; code: string | null }>(
      "select metadata_phase as phase, metadata_error_code as code from moti.products where id = $1", [product.id],
    )).rows[0], { timeout: 10_000 }).toEqual({ phase: "failed", code: "blocked_address" });
    expect(metadataWakeResponseSchema.parse(await (await wake()).json())).toEqual({ products: [] });
  });
});
