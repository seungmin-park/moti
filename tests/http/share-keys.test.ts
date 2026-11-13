import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorResponseSchema } from "../../src/features/library/presentation/library-dto";
import {
  shareKeyIssueResponseSchema,
  shareKeyReadResponseSchema,
  shareKeyRevokeResponseSchema,
  shareLinkErrorResponseSchema,
} from "../../src/features/share/presentation/share-dto";
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

const read = () => fetch(new URL("/api/share-keys", appUrl), { headers: { cookie } });
const issue = (replaces: string | null, from = origin) => fetch(new URL("/api/share-keys", appUrl), {
  method: "POST",
  headers: { cookie, origin: from, "content-type": "application/json" },
  body: JSON.stringify({ replaces }),
});
const revoke = (keyId: string, from = origin) =>
  fetch(new URL(`/api/share-keys/${keyId}`, appUrl), { method: "DELETE", headers: { cookie, origin: from } });
const shortcut = (secret: string, url: string) => fetch(new URL("/api/share/links", appUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
  body: JSON.stringify({ url }),
});

describe("실제 HTTP 저장 키 관리", () => {
  it("소유자는 키를 만들고, 단축어가 담으면 마지막으로 담은 시각을 보고, 새 키로 바꾸고 폐기한다", async () => {
    expect(shareKeyReadResponseSchema.parse(await (await read()).json())).toEqual({ key: null });

    const created = await issue(null);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const first = shareKeyIssueResponseSchema.parse(await created.json());
    expect(first.key).toMatchObject({ hint: first.secret.slice(-4), lastUsedAt: null, revokedAt: null });
    const shown = await (await read()).text();
    expect(shown).not.toContain(first.secret);
    expect(shareKeyReadResponseSchema.parse(JSON.parse(shown))).toEqual({ key: first.key });

    expect((await shortcut(first.secret, "https://shop.example/lamp")).status).toBe(201);
    const used = shareKeyReadResponseSchema.parse(await (await read()).json()).key;
    expect(used).toMatchObject({ id: first.key.id, lastUsedAt: expect.any(String) });

    const stale = await issue(null);
    expect(stale.status).toBe(409);
    expect(errorResponseSchema.parse(await stale.json()).error).toBe("revision_conflict");

    const rotated = await issue(first.key.id);
    expect(rotated.status).toBe(201);
    const second = shareKeyIssueResponseSchema.parse(await rotated.json());
    expect(second.secret).not.toBe(first.secret);
    const oldKey = await shortcut(first.secret, "https://shop.example/desk");
    expect(oldKey.status).toBe(401);
    expect(shareLinkErrorResponseSchema.parse(await oldKey.json()).error).toBe("share_key_rejected");
    expect((await shortcut(second.secret, "https://shop.example/desk")).status).toBe(201);

    const revoked = await revoke(second.key.id);
    expect(revoked.status).toBe(200);
    const after = shareKeyRevokeResponseSchema.parse(await revoked.json()).key;
    expect(after).toMatchObject({ id: second.key.id, revokedAt: expect.any(String) });
    expect(shareKeyReadResponseSchema.parse(await (await read()).json())).toEqual({ key: after });
    expect((await shortcut(second.secret, "https://shop.example/chair")).status).toBe(401);
    const again = await revoke(second.key.id);
    expect(shareKeyRevokeResponseSchema.parse(await again.json())).toEqual({ key: after });
  });

  it("다른 출처의 만들기·폐기는 403이고, 없는 키는 404, UUID가 아닌 키는 400이며 키는 그대로다", async () => {
    const { key } = shareKeyIssueResponseSchema.parse(await (await issue(null)).json());

    for (const response of [await issue(key.id, "https://evil.example"), await revoke(key.id, "https://evil.example")]) {
      expect(response.status).toBe(403);
      expect(errorResponseSchema.parse(await response.json()).error).toBe("cross_origin");
    }
    const missing = await revoke(randomUUID());
    expect(missing.status).toBe(404);
    expect(errorResponseSchema.parse(await missing.json()).error).toBe("share_key_missing");
    const malformed = await revoke("not-a-uuid");
    expect(malformed.status).toBe(400);
    expect(errorResponseSchema.parse(await malformed.json()).error).toBe("invalid_input");

    expect(shareKeyReadResponseSchema.parse(await (await read()).json())).toEqual({ key });
  });
});
