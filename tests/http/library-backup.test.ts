import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLibraryBackup } from "../../src/features/library/presentation/library-backup";
import { collectionCreateResponseSchema, errorResponseSchema } from "../../src/features/library/presentation/library-dto";
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

function post(path: string, body: unknown) {
  return fetch(new URL(path, appUrl), {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const download = (session = cookie) => fetch(new URL("/api/library/backup", appUrl), { headers: { cookie: session } });

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
