import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  errorResponseSchema,
  linkSaveResponseSchema,
  metadataRetryResponseSchema,
} from "../../src/features/library/presentation/library-dto";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { cookieHeader, signInCookies } from "../support/session";

const { appUrl } = readDatabaseConfig();
const origin = new URL(appUrl).origin;
// A loopback address on a port the production policy never opens: the app must refuse it without connecting.
const blockedLink = "http://127.0.0.1:9/p";

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

function post(path: string, body: unknown, headers: Record<string, string> = { origin }) {
  return fetch(new URL(path, appUrl), {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

type StoredProduct = { source_url: string; metadata_phase: string; metadata_generation: number; metadata_error_code: string | null; title: string };

async function stored(productId: string): Promise<StoredProduct> {
  const { rows } = await fixture.admin.query<StoredProduct>(
    "select source_url, metadata_phase, metadata_generation, metadata_error_code, title from moti.products where id = $1",
    [productId],
  );
  return rows[0];
}

async function settled(productId: string, generation: number): Promise<StoredProduct> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const product = await stored(productId);
    if (product.metadata_generation === generation && ["ready", "failed"].includes(product.metadata_phase)) return product;
    if (Date.now() > deadline) throw new Error(`10초 안에 수집이 끝나지 않았습니다: ${JSON.stringify(product)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("실제 HTTP 정보 수집", () => {
  it("저장은 바로 대기 상태로 응답하고, 응답 뒤 수집이 막힌 주소를 기록해도 링크는 남는다", async () => {
    const response = await post("/api/links", { url: blockedLink, option: "", collectionIds: [] });
    expect(response.status).toBe(201);
    const saved = linkSaveResponseSchema.parse(await response.json());
    expect(saved.product.metadata).toEqual({ phase: "queued", generation: 1, attempts: 0, stalled: false });

    expect(await settled(saved.product.id, 1)).toEqual({
      source_url: blockedLink,
      metadata_phase: "failed",
      metadata_generation: 1,
      metadata_error_code: "blocked_address",
      title: "새로 담은 상품",
    });
  });

  it("실패한 상품을 다시 가져오면 202와 다음 세대로 응답하고 다시 수집해 같은 이유로 실패한다", async () => {
    const saved = linkSaveResponseSchema.parse(await (await post("/api/links", { url: blockedLink, option: "", collectionIds: [] })).json());
    await settled(saved.product.id, 1);

    const response = await post(`/api/products/${saved.product.id}/metadata`, { generation: 1 });

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const retried = metadataRetryResponseSchema.parse(await response.json());
    expect(retried.product).toMatchObject({ id: saved.product.id, sourceUrl: blockedLink, metadata: { phase: "queued", generation: 2 } });
    expect(await settled(saved.product.id, 2)).toMatchObject({ metadata_phase: "failed", metadata_error_code: "blocked_address" });

    const stale = await post(`/api/products/${saved.product.id}/metadata`, { generation: 1 });
    expect(stale.status).toBe(409);
    expect(errorResponseSchema.parse(await stale.json()).error).toBe("metadata_not_retryable");
  });

  it("막 담겨 대기 중인 상품을 다시 가져오면 409이고 작업을 늘리지 않는다", async () => {
    // Inserted directly so that no collection was scheduled and the job stays queued for this test.
    const { rows } = await fixture.admin.query<{ id: string }>(
      `with product as (
         insert into moti.products (owner_id, source_url, identity_url, shop)
         values ($1, 'https://shop.example/queued', 'https://shop.example/queued', 'shop.example') returning id, owner_id
       )
       insert into moti.metadata_jobs (owner_id, product_id, generation) select owner_id, id, 1 from product returning product_id as id`,
      [fixture.owner.id],
    );
    const response = await post(`/api/products/${rows[0].id}/metadata`, { generation: 1 });
    expect(response.status).toBe(409);
    expect(errorResponseSchema.parse(await response.json()).error).toBe("metadata_not_retryable");
    const jobs = await fixture.admin.query("select generation, status from moti.metadata_jobs where product_id = $1", [rows[0].id]);
    expect(jobs.rows).toEqual([{ generation: 1, status: "queued" }]);
  });

  it("없는 상품, 잘못된 경로·본문과 다른 출처의 다시 가져오기는 계약대로 거절한다", async () => {
    const missing = await post(`/api/products/${randomUUID()}/metadata`, { generation: 1 });
    expect(missing.status).toBe(404);
    expect(errorResponseSchema.parse(await missing.json()).error).toBe("product_missing");

    const badPath = await post("/api/products/not-a-uuid/metadata", { generation: 1 });
    expect(badPath.status).toBe(400);
    expect(errorResponseSchema.parse(await badPath.json()).error).toBe("invalid_input");

    const badBody = await post(`/api/products/${randomUUID()}/metadata`, { generation: 0 });
    expect(badBody.status).toBe(400);

    const crossOrigin = await post(`/api/products/${randomUUID()}/metadata`, { generation: 1 }, { origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(403);
    expect(errorResponseSchema.parse(await crossOrigin.json()).error).toBe("cross_origin");
  });
});
