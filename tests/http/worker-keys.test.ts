import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorResponseSchema } from "../../src/features/library/presentation/library-dto";
import {
  workerKeyIssueResponseSchema,
  workerKeyRevokeResponseSchema,
  workerReadResponseSchema,
} from "../../src/features/worker/presentation/worker-dto";
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

const read = () => fetch(new URL("/api/worker-keys", appUrl), { headers: { cookie } });
const issue = (replaces: string | null, from = origin) => fetch(new URL("/api/worker-keys", appUrl), {
  method: "POST",
  headers: { cookie, origin: from, "content-type": "application/json" },
  body: JSON.stringify({ replaces }),
});
const revoke = (keyId: string, from = origin) =>
  fetch(new URL(`/api/worker-keys/${keyId}`, appUrl), { method: "DELETE", headers: { cookie, origin: from } });

describe("실제 HTTP 작업 키 관리", () => {
  it("소유자는 작업 키를 만들어 한 번 보고, 새 키로 바꾸고 폐기한다. 읽기는 키의 끝 네 글자와 실행 기록만 보인다", async () => {
    expect(workerReadResponseSchema.parse(await (await read()).json())).toEqual({ key: null, runs: [] });

    const created = await issue(null);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const first = workerKeyIssueResponseSchema.parse(await created.json());
    expect(first.secret).toMatch(/^moti_wk_[A-Za-z0-9_-]{43}$/);
    const shown = await (await read()).text();
    expect(shown).not.toContain(first.secret);
    expect(workerReadResponseSchema.parse(JSON.parse(shown))).toEqual({ key: first.key, runs: [] });

    const stale = await issue(null);
    expect(stale.status).toBe(409);
    expect(errorResponseSchema.parse(await stale.json()).error).toBe("revision_conflict");

    const second = workerKeyIssueResponseSchema.parse(await (await issue(first.key.id)).json());
    const revoked = await revoke(second.key.id);
    expect(revoked.status).toBe(200);
    const after = workerKeyRevokeResponseSchema.parse(await revoked.json()).key;
    expect(after).toMatchObject({ id: second.key.id, revokedAt: expect.any(String) });
    expect(workerReadResponseSchema.parse(await (await read()).json())).toEqual({ key: after, runs: [] });
  });

  it("다른 출처의 만들기·폐기는 403이고, 없는 키는 404 worker_key_missing, UUID가 아닌 키는 400이며 키는 그대로다", async () => {
    const { key } = workerKeyIssueResponseSchema.parse(await (await issue(null)).json());

    for (const response of [await issue(key.id, "https://evil.example"), await revoke(key.id, "https://evil.example")]) {
      expect(response.status).toBe(403);
      expect(errorResponseSchema.parse(await response.json()).error).toBe("cross_origin");
    }
    const missing = await revoke(randomUUID());
    expect(missing.status).toBe(404);
    expect(errorResponseSchema.parse(await missing.json()).error).toBe("worker_key_missing");
    expect((await revoke("not-a-uuid")).status).toBe(400);

    expect(workerReadResponseSchema.parse(await (await read()).json()).key).toEqual(key);
  });
});
