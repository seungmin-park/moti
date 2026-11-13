import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { errorResponseSchema, libraryReadResponseSchema } from "../../src/features/library/presentation/library-dto";
import {
  scheduledRunErrorResponseSchema,
  scheduledRunResponseSchema,
  workerReadResponseSchema,
} from "../../src/features/worker/presentation/worker-dto";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { cookieHeader, signInCookies } from "../support/session";

const { appUrl } = readDatabaseConfig();
const origin = new URL(appUrl).origin;
// A loopback link the app's fetch policy refuses: the worker settles it as blocked without leaving the machine.
const blockedLink = "http://127.0.0.1:9/scheduled";

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

async function issue(name = "moti_worker_key_issue"): Promise<{ key: { id: string }; secret: string }> {
  const { data, error } = await fixture.owner.client.rpc(name, { p_replaces: null });
  if (error) throw new Error(`키를 만들지 못했습니다: ${error.code}`);
  return data;
}

// GitHub's request: a bearer key and nothing else. No cookie, no Origin, no body.
const scheduled = (headers: Record<string, string>) =>
  fetch(new URL("/api/scheduled-runs", appUrl), { method: "POST", headers });

async function stored() {
  const products = await fixture.admin.query(
    `select p.title, p.note, p.revision, p.metadata_phase, p.metadata_error_code from moti.products p where p.owner_id = $1 order by p.id`,
    [fixture.owner.id],
  );
  const runs = await fixture.admin.query(
    "select stop_reason, collected, collect_failed, failures from moti.worker_runs where owner_id = $1 order by started_at",
    [fixture.owner.id],
  );
  const keys = await fixture.admin.query("select id, revoked_at, last_used_at from moti.worker_keys where owner_id = $1 order by id", [fixture.owner.id]);
  return { products: products.rows, runs: runs.rows, keys: keys.rows };
}

async function expectRejected(response: Response) {
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe("Bearer");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(scheduledRunErrorResponseSchema.parse(await response.json()).error).toBe("worker_key_rejected");
}

describe("실제 HTTP 예약 실행", () => {
  it("작업 키 없이, 공유 키로, 소유자 쿠키만으로, 모르는 키로 부르면 같은 401이고 아무것도 실행하지 않는다", async () => {
    await createSupabaseLibraryStore(fixture.owner.client).saveLink(toLinkSaveCommand({ url: blockedLink, option: "", collectionIds: [] }));
    const share = await issue("moti_share_key_issue");
    const before = await stored();

    await expectRejected(await scheduled({}));
    await expectRejected(await scheduled({ authorization: `Bearer ${share.secret}` }));
    await expectRejected(await scheduled({ cookie, origin }));
    await expectRejected(await scheduled({ authorization: `Bearer moti_wk_${randomBytes(32).toString("base64url")}` }));

    expect(await stored()).toEqual(before);
  });

  it("작업 키로 부르면 대기 중인 상품을 수집하고 셈을 돌려준다. 앱의 주소 정책이 막은 링크는 blocked_address로 남는다", async () => {
    const { secret } = await issue();
    await createSupabaseLibraryStore(fixture.owner.client).saveLink(toLinkSaveCommand({ url: blockedLink, option: "", collectionIds: [] }));

    const response = await scheduled({ authorization: `Bearer ${secret}` });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(scheduledRunResponseSchema.parse(await response.json())).toEqual({
      stop: "done",
      collections: { collected: 0, failed: 1 },
      prices: { confirmed: 0, kept: 0 },
      failures: { blocked_address: 1 },
    });
    const after = await stored();
    expect(after.products).toEqual([{ title: "새로 담은 상품", note: "", revision: 1, metadata_phase: "failed", metadata_error_code: "blocked_address" }]);
    expect(after.runs).toEqual([{ stop_reason: "done", collected: 0, collect_failed: 1, failures: { blocked_address: 1 } }]);
    const shown = workerReadResponseSchema.parse(await (await fetch(new URL("/api/worker-keys", appUrl), { headers: { cookie } })).json());
    expect(shown.runs).toEqual([expect.objectContaining({ state: "done", collections: { collected: 0, failed: 1 } })]);
    expect(shown.key?.lastUsedAt).not.toBeNull();
  });

  it("작업 키로 부르면 수집이 끝난 위시 상품의 가격을 확인한다. 앱의 주소 정책이 막은 링크는 이전 가격을 지키고 같은 서울 날짜에는 다시 확인하지 않는다", async () => {
    const { secret } = await issue();
    const { product } = await createSupabaseLibraryStore(fixture.owner.client)
      .saveLink(toLinkSaveCommand({ url: blockedLink, option: "", collectionIds: [] }));
    await fixture.admin.query(
      `with job as (
         update moti.metadata_jobs set status = 'succeeded', attempts = 1, finished_at = now() - interval '2 days' where product_id = $1
         returning product_id
       )
       update moti.products set metadata_phase = 'ready', metadata_attempts = 1, metadata_completed_at = now() - interval '2 days',
         metadata_image = 'absent', last_success_amount_minor = 9000, last_success_currency = 'KRW', last_success_at = now() - interval '2 days'
       where id in (select product_id from job)`,
      [product.id],
    );

    const response = await scheduled({ authorization: `Bearer ${secret}` });

    expect(response.status).toBe(200);
    expect(scheduledRunResponseSchema.parse(await response.json())).toEqual({
      stop: "done",
      collections: { collected: 0, failed: 0 },
      prices: { confirmed: 0, kept: 1 },
      failures: { blocked_address: 1 },
    });
    const library = libraryReadResponseSchema.parse(await (await fetch(new URL("/api/library", appUrl), { headers: { cookie } })).json());
    expect(library.products).toEqual([expect.objectContaining({
      title: "새로 담은 상품",
      lastSuccessfulPrice: { amountMinor: 9000, currency: "KRW", checkedAt: expect.any(String) },
      priceCheck: { checkedAt: expect.any(String), code: "blocked_address" },
    })]);
    const [shown] = library.products;
    expect(Date.parse(shown.priceCheck!.checkedAt)).toBeGreaterThan(Date.parse(shown.lastSuccessfulPrice!.checkedAt));

    const again = await scheduled({ authorization: `Bearer ${secret}` });
    expect(scheduledRunResponseSchema.parse(await again.json())).toMatchObject({ stop: "done", prices: { confirmed: 0, kept: 0 } });
    const runs = workerReadResponseSchema.parse(await (await fetch(new URL("/api/worker-keys", appUrl), { headers: { cookie } })).json()).runs;
    expect(runs.map(({ prices, failures }) => ({ prices, failures }))).toEqual([
      { prices: { confirmed: 0, kept: 0 }, failures: {} },
      { prices: { confirmed: 0, kept: 1 }, failures: { blocked_address: 1 } },
    ]);
  });

  it("다른 실행이 임대를 쥐고 있으면 409 run_busy이고, 24시간에 여덟 번을 넘기면 429 run_limit이다", async () => {
    const { key, secret } = await issue();
    const held = await fixture.anonymous.rpc("moti_worker_begin", { p_key: secret });
    expect(held.error).toBeNull();
    const busy = await scheduled({ authorization: `Bearer ${secret}` });
    expect(busy.status).toBe(409);
    expect(scheduledRunErrorResponseSchema.parse(await busy.json()).error).toBe("run_busy");

    await fixture.admin.query("delete from moti.worker_runs where owner_id = $1", [fixture.owner.id]);
    for (let index = 1; index <= 8; index += 1) {
      await fixture.admin.query(
        `insert into moti.worker_runs (owner_id, key_id, started_at, finished_at, stop_reason)
         values ($1, $2, now() - $3::interval, now() - $3::interval + interval '10 seconds', 'done')`,
        [fixture.owner.id, key.id, `${index} hours`],
      );
    }
    const limited = await scheduled({ authorization: `Bearer ${secret}` });
    expect(limited.status).toBe(429);
    expect(scheduledRunErrorResponseSchema.parse(await limited.json()).error).toBe("run_limit");
  });

  it("작업 키로 소유자 경로를 부르면 쿠키가 없어 모두 401 signed_out이고 DB는 그대로다", async () => {
    const { secret } = await issue();
    const { product } = await createSupabaseLibraryStore(fixture.owner.client)
      .saveLink(toLinkSaveCommand({ url: "https://shop.example/lamp", option: "", collectionIds: [] }));
    const before = await stored();
    const bearer = { authorization: `Bearer ${secret}`, origin, "content-type": "application/json" };
    const requests: [string, RequestInit][] = [
      ["/api/library", { headers: bearer }],
      ["/api/share-keys", { headers: bearer }],
      ["/api/worker-keys", { headers: bearer }],
      ["/api/worker-keys", { method: "POST", headers: bearer, body: JSON.stringify({ replaces: null }) }],
      [`/api/products/${product.id}`, {
        method: "PATCH", headers: bearer, body: JSON.stringify({ revision: 1, change: { type: "purchase" } }),
      }],
      ["/api/library/metadata", { method: "POST", headers: bearer, body: "{}" }],
    ];
    for (const [path, init] of requests) {
      const response = await fetch(new URL(path, appUrl), init);
      expect(response.status, path).toBe(401);
      expect(errorResponseSchema.parse(await response.json()).error, path).toBe("signed_out");
    }
    expect(await stored()).toEqual(before);
  });
});
