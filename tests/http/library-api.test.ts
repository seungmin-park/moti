import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectionCreateResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveResponseSchema,
} from "../../src/features/library/presentation/library-dto";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { cookieHeader, signInCookies } from "../support/session";

const { appUrl } = readDatabaseConfig();
const origin = new URL(appUrl).origin;

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture({ ownerGoogleSubject: HTTP_OWNER_SUBJECT }); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const { cookie, ...rest } = init;
  return fetch(new URL(path, appUrl), {
    redirect: "manual",
    ...rest,
    headers: { ...(cookie && { cookie }), ...rest.headers },
  });
}

function postJson(path: string, body: unknown, cookie: string, headers: Record<string, string> = { origin }) {
  return request(path, {
    method: "POST",
    cookie,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function storedProducts() {
  const { rows } = await fixture.admin.query<{ count: number }>(
    "select count(*)::int as count from moti.products where owner_id = any($1::uuid[])",
    [[fixture.owner.id, fixture.stranger.id]],
  );
  return rows[0].count;
}

describe("실제 HTTP 보관함 API", () => {
  it("세션 없는 조회는 계약에 맞는 401이다", async () => {
    const response = await request("/api/library");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(errorResponseSchema.parse(await response.json()).error).toBe("signed_out");
  });

  it("허용한 Google 계정은 저장한 컬렉션과 링크를 다시 로그인한 새 세션에서도 읽는다", async () => {
    const cookie = cookieHeader(await signInCookies(fixture.owner));

    const created = await postJson("/api/collections", { name: " 책상 " }, cookie);
    expect(created.status).toBe(201);
    const collection = collectionCreateResponseSchema.parse(await created.json());
    expect(collection.name).toBe("책상");

    const link = { url: "https://example.com/item?utm_source=a", option: "블랙", collectionIds: [collection.id] };
    const added = await postJson("/api/links", link, cookie);
    expect(added.status).toBe(201);
    const saved = linkSaveResponseSchema.parse(await added.json());
    expect(saved).toMatchObject({ kind: "added", product: { identityUrl: "https://example.com/item", collectionIds: [collection.id] } });

    const duplicate = await postJson("/api/links", { ...link, url: "https://example.com/item?utm_source=b" }, cookie);
    expect(duplicate.status).toBe(200);
    expect(linkSaveResponseSchema.parse(await duplicate.json())).toEqual({ kind: "duplicate", product: saved.product });

    const nextSession = cookieHeader(await signInCookies(fixture.owner));
    const read = await request("/api/library", { cookie: nextSession });
    expect(read.status).toBe(200);
    expect(libraryReadResponseSchema.parse(await read.json())).toEqual({ products: [saved.product], collections: [collection] });
  });

  it("다른 Google 계정의 세션은 403이고 쿠키와 서버 세션을 폐기해 이후 쓰기도 저장하지 않는다", async () => {
    const jar = await signInCookies(fixture.stranger);
    const cookie = cookieHeader(jar);

    const read = await request("/api/library", { cookie });
    expect(read.status).toBe(403);
    expect(errorResponseSchema.parse(await read.json()).error).toBe("forbidden");
    const cleared = read.headers.getSetCookie().filter((value) => [...jar.keys()].some((name) => value.startsWith(`${name}=`)));
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared.every((value) => /max-age=0/i.test(value))).toBe(true);

    const write = await postJson("/api/links", { url: "https://example.com/forbidden", option: "", collectionIds: [] }, cookie);
    expect(write.status).toBe(401);
    expect(errorResponseSchema.parse(await write.json()).error).toBe("signed_out");
    expect(await storedProducts()).toBe(0);
  });

  it("다른 출처의 쓰기 요청은 소유자 세션이어도 403이고 저장하지 않는다", async () => {
    const cookie = cookieHeader(await signInCookies(fixture.owner));
    const response = await postJson("/api/links", { url: "https://example.com/csrf", option: "", collectionIds: [] }, cookie, {
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    expect(errorResponseSchema.parse(await response.json()).error).toBe("cross_origin");
    expect(await storedProducts()).toBe(0);
  });

  it("업무 규칙에 맞지 않는 링크는 필드와 함께 400이고 저장하지 않는다", async () => {
    const cookie = cookieHeader(await signInCookies(fixture.owner));
    const response = await postJson("/api/links", { url: "javascript:alert(1)", option: "", collectionIds: [] }, cookie);
    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(await response.json())).toMatchObject({ error: "invalid_input", field: "url" });
    expect(await storedProducts()).toBe(0);
  });

  it("없는 컬렉션을 지정하면 422이고 저장하지 않는다", async () => {
    const cookie = cookieHeader(await signInCookies(fixture.owner));
    const response = await postJson("/api/links", {
      url: "https://example.com/item", option: "", collectionIds: ["00000000-0000-4000-8000-000000000000"],
    }, cookie);
    expect(response.status).toBe(422);
    expect(errorResponseSchema.parse(await response.json()).error).toBe("collection_missing");
    expect(await storedProducts()).toBe(0);
  });
});

describe("실제 HTTP 로그인 경로", () => {
  it("로그인 시작은 로컬 Auth의 Google 인증 주소로 303 이동하고 PKCE 검증값을 쿠키에 남긴다", async () => {
    const response = await request("/auth/login");
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${readDatabaseConfig().apiUrl}/auth/v1/authorize`);
    expect(location.searchParams.get("provider")).toBe("google");
    expect(location.searchParams.get("redirect_to")).toBe(`${origin}/auth/callback`);
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(response.headers.getSetCookie().some((value) => value.includes("code-verifier"))).toBe(true);
  });

  it("위조한 code의 콜백은 세션을 만들지 않고 실패 안내로 이동한다", async () => {
    const response = await request("/auth/callback?code=forged-code");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/login?error=callback`);
    expect(response.headers.getSetCookie().some((value) => /auth-token=[^;]+/.test(value) && !/max-age=0/i.test(value))).toBe(false);
  });

  it("같은 출처의 로그아웃은 인증 쿠키를 지운다", async () => {
    const jar = await signInCookies(fixture.owner);
    const response = await request("/auth/logout", { method: "POST", cookie: cookieHeader(jar), headers: { origin } });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/login`);
    const cleared = response.headers.getSetCookie().filter((value) => [...jar.keys()].some((name) => value.startsWith(`${name}=`)));
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared.every((value) => /max-age=0/i.test(value))).toBe(true);
  });
});
