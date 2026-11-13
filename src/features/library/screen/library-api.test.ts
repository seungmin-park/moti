import { describe, expect, it, vi } from "vitest";
import type { CollectionResponse, ErrorCode, ProductResponse } from "../presentation/library-dto";
import { MAX_BACKUP_BYTES, toLibraryBackupDocument } from "../presentation/library-backup";
import { createLibraryApi, toApiFailure, type ApiFailure, type Endpoint } from "./library-api";

const collection: CollectionResponse = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "책상",
  revision: 1,
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
};
const product: ProductResponse = {
  id: "22222222-2222-4222-8222-222222222222",
  sourceUrl: "https://example.com/item",
  identityUrl: "https://example.com/item",
  option: "",
  shop: "example.com",
  title: "새로 담은 상품",
  note: "",
  revision: 1,
  collectionIds: [collection.id],
  addedAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  purchase: { status: "wish" },
  metadata: { phase: "queued", generation: 1, attempts: 0, stalled: false },
  lastSuccessfulPrice: null,
  picture: null,
};
const link = { url: "https://example.com/item", option: "", collectionIds: [collection.id] };

const connection = "연결을 확인하고 다시 시도해 주세요.";
const readFailed = "보관함을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.";
const retryLater = "잠시 뒤 다시 시도해 주세요.";
const reload = "화면을 새로고침한 뒤 다시 시도해 주세요.";
const changedElsewhere = "다른 곳에서 먼저 바뀌었어요. 최신 내용을 불러왔어요. 확인 후 다시 저장해 주세요.";

const status: Record<ErrorCode, number> = {
  signed_out: 401,
  forbidden: 403,
  unconfigured: 503,
  cross_origin: 403,
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_input: 400,
  collection_missing: 422,
  collection_duplicate: 409,
  identity_conflict: 409,
  product_missing: 404,
  metadata_not_retryable: 409,
  revision_conflict: 409,
  picture_missing: 404,
  share_key_missing: 404,
  storage_unavailable: 503,
};

const signedIn: Record<"signed_out" | "forbidden" | "unconfigured", ApiFailure> = {
  signed_out: { kind: "redirect", to: "/login" },
  forbidden: { kind: "redirect", to: "/login?error=forbidden" },
  unconfigured: { kind: "redirect", to: "/login?error=unconfigured" },
};

const backupFailed: ApiFailure = { kind: "unavailable", message: "백업을 만들지 못했어요. 잠시 뒤 다시 시도해 주세요." };
const restoreUnknown: ApiFailure = { kind: "unavailable", message: "복원을 마쳤는지 확인하지 못했어요." };
const unchanged = (message: string): ApiFailure => ({ kind: "invalid", field: null, message: `${message} 보관함은 바뀌지 않았어요.` });

const readShareFailed: ApiFailure = { kind: "unavailable", message: "저장 키를 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요." };
const keyChanged: ApiFailure = { kind: "stale", message: "다른 곳에서 키가 바뀌었어요. 최신 상태를 불러왔어요." };
const issueUnknown: ApiFailure = { kind: "unavailable", message: "새 키를 받지 못했어요. 최신 상태를 불러왔어요." };
const revokeUnknown: ApiFailure = { kind: "unavailable", message: "키를 폐기했는지 확인하지 못했어요. 최신 상태를 불러왔어요." };
const reloadFailure: ApiFailure = { kind: "unavailable", message: reload };
const everyCode = (failure: ApiFailure) => ({
  storage_unavailable: failure,
  cross_origin: failure,
  unsupported_media_type: failure,
  payload_too_large: failure,
  invalid_input: failure,
  collection_missing: failure,
  collection_duplicate: failure,
  identity_conflict: failure,
  product_missing: failure,
  metadata_not_retryable: failure,
  revision_conflict: failure,
  picture_missing: failure,
  share_key_missing: failure,
});

const expected: Record<Endpoint, Record<ErrorCode, ApiFailure>> = {
  "share.read": { ...signedIn, ...everyCode(readShareFailed) },
  "share.issue": { ...signedIn, ...everyCode(issueUnknown), cross_origin: reloadFailure, revision_conflict: keyChanged, share_key_missing: keyChanged },
  "share.revoke": { ...signedIn, ...everyCode(revokeUnknown), cross_origin: reloadFailure, revision_conflict: keyChanged, share_key_missing: keyChanged },
  "library.backup": {
    ...signedIn,
    storage_unavailable: backupFailed,
    cross_origin: backupFailed,
    unsupported_media_type: backupFailed,
    payload_too_large: backupFailed,
    invalid_input: backupFailed,
    collection_missing: backupFailed,
    collection_duplicate: backupFailed,
    identity_conflict: backupFailed,
    product_missing: backupFailed,
    metadata_not_retryable: backupFailed,
    revision_conflict: backupFailed,
    picture_missing: backupFailed,
    share_key_missing: backupFailed,
  },
  "library.restore": {
    ...signedIn,
    storage_unavailable: restoreUnknown,
    cross_origin: unchanged("화면을 새로고침한 뒤 다시 시도해 주세요."),
    unsupported_media_type: unchanged("복원 요청을 보내지 못했어요."),
    payload_too_large: unchanged("4MB보다 큰 백업은 한 번에 복원할 수 없어요."),
    invalid_input: unchanged("백업 파일이 손상되었거나 바뀌었어요."),
    collection_missing: restoreUnknown,
    collection_duplicate: restoreUnknown,
    identity_conflict: restoreUnknown,
    product_missing: restoreUnknown,
    metadata_not_retryable: restoreUnknown,
    revision_conflict: restoreUnknown,
    picture_missing: restoreUnknown,
    share_key_missing: restoreUnknown,
  },
  "metadata.wake": {
    ...signedIn,
    storage_unavailable: { kind: "unavailable", message: readFailed },
    cross_origin: { kind: "unavailable", message: readFailed },
    unsupported_media_type: { kind: "unavailable", message: readFailed },
    payload_too_large: { kind: "unavailable", message: readFailed },
    invalid_input: { kind: "unavailable", message: readFailed },
    collection_missing: { kind: "unavailable", message: readFailed },
    collection_duplicate: { kind: "unavailable", message: readFailed },
    identity_conflict: { kind: "unavailable", message: readFailed },
    product_missing: { kind: "unavailable", message: readFailed },
    metadata_not_retryable: { kind: "unavailable", message: readFailed },
    revision_conflict: { kind: "unavailable", message: readFailed },
    picture_missing: { kind: "unavailable", message: readFailed },
    share_key_missing: { kind: "unavailable", message: readFailed },
  },
  "library.read": {
    ...signedIn,
    storage_unavailable: { kind: "unavailable", message: readFailed },
    cross_origin: { kind: "unavailable", message: readFailed },
    unsupported_media_type: { kind: "unavailable", message: readFailed },
    payload_too_large: { kind: "unavailable", message: readFailed },
    invalid_input: { kind: "unavailable", message: readFailed },
    collection_missing: { kind: "unavailable", message: readFailed },
    collection_duplicate: { kind: "unavailable", message: readFailed },
    identity_conflict: { kind: "unavailable", message: readFailed },
    product_missing: { kind: "unavailable", message: readFailed },
    metadata_not_retryable: { kind: "unavailable", message: readFailed },
    revision_conflict: { kind: "unavailable", message: readFailed },
    picture_missing: { kind: "unavailable", message: readFailed },
    share_key_missing: { kind: "unavailable", message: readFailed },
  },
  "link.save": {
    ...signedIn,
    storage_unavailable: { kind: "unavailable", message: retryLater },
    cross_origin: { kind: "unavailable", message: reload },
    unsupported_media_type: { kind: "unavailable", message: retryLater },
    payload_too_large: { kind: "invalid", field: "url", message: "링크가 너무 길어요." },
    invalid_input: { kind: "invalid", field: "url", message: "서버가 거절한 링크예요." },
    collection_missing: { kind: "stale", message: "선택한 컬렉션을 찾을 수 없어요. 목록을 새로 불러왔어요." },
    collection_duplicate: { kind: "unavailable", message: retryLater },
    identity_conflict: { kind: "unavailable", message: "같은 링크를 확인하지 못했어요. 다시 시도해 주세요." },
    product_missing: { kind: "unavailable", message: retryLater },
    metadata_not_retryable: { kind: "unavailable", message: retryLater },
    revision_conflict: { kind: "unavailable", message: retryLater },
    picture_missing: { kind: "unavailable", message: retryLater },
    share_key_missing: { kind: "unavailable", message: retryLater },
  },
  "collection.create": {
    ...signedIn,
    storage_unavailable: { kind: "unavailable", message: retryLater },
    cross_origin: { kind: "unavailable", message: reload },
    unsupported_media_type: { kind: "unavailable", message: retryLater },
    payload_too_large: { kind: "invalid", field: "collection", message: "컬렉션 이름이 너무 길어요." },
    invalid_input: { kind: "invalid", field: "collection", message: "컬렉션 이름은 1~40자로 입력해 주세요." },
    collection_missing: { kind: "unavailable", message: retryLater },
    collection_duplicate: { kind: "stale", message: "같은 이름의 컬렉션이 이미 있어요." },
    identity_conflict: { kind: "unavailable", message: retryLater },
    product_missing: { kind: "unavailable", message: retryLater },
    metadata_not_retryable: { kind: "unavailable", message: retryLater },
    revision_conflict: { kind: "unavailable", message: retryLater },
    picture_missing: { kind: "unavailable", message: retryLater },
    share_key_missing: { kind: "unavailable", message: retryLater },
  },
  "collection.rename": {
    ...signedIn,
    storage_unavailable: { kind: "unavailable", message: retryLater },
    cross_origin: { kind: "unavailable", message: reload },
    unsupported_media_type: { kind: "unavailable", message: retryLater },
    payload_too_large: { kind: "invalid", field: "collection", message: "컬렉션 이름이 너무 길어요." },
    invalid_input: { kind: "invalid", field: "collection", message: "컬렉션 이름은 1~40자로 입력해 주세요." },
    collection_missing: { kind: "stale", message: "컬렉션을 찾을 수 없어요. 목록을 새로 불러왔어요." },
    collection_duplicate: { kind: "stale", message: "같은 이름의 컬렉션이 이미 있어요." },
    identity_conflict: { kind: "unavailable", message: retryLater },
    product_missing: { kind: "unavailable", message: retryLater },
    metadata_not_retryable: { kind: "unavailable", message: retryLater },
    revision_conflict: { kind: "stale", message: changedElsewhere },
    picture_missing: { kind: "unavailable", message: retryLater },
    share_key_missing: { kind: "unavailable", message: retryLater },
  },
  "metadata.retry": {
    ...signedIn,
    storage_unavailable: { kind: "unavailable", message: retryLater },
    cross_origin: { kind: "unavailable", message: reload },
    unsupported_media_type: { kind: "unavailable", message: retryLater },
    payload_too_large: { kind: "unavailable", message: retryLater },
    invalid_input: { kind: "unavailable", message: reload },
    collection_missing: { kind: "unavailable", message: retryLater },
    collection_duplicate: { kind: "unavailable", message: retryLater },
    identity_conflict: { kind: "unavailable", message: retryLater },
    product_missing: { kind: "stale", message: "상품을 찾을 수 없어요. 목록을 새로 불러왔어요." },
    metadata_not_retryable: { kind: "stale", message: "상품 상태가 바뀌었어요. 목록을 새로 불러왔어요." },
    revision_conflict: { kind: "unavailable", message: retryLater },
    picture_missing: { kind: "unavailable", message: retryLater },
    share_key_missing: { kind: "unavailable", message: retryLater },
  },
  "product.change": {
    ...signedIn,
    storage_unavailable: { kind: "unavailable", message: retryLater },
    cross_origin: { kind: "unavailable", message: reload },
    unsupported_media_type: { kind: "unavailable", message: retryLater },
    payload_too_large: { kind: "invalid", field: "note", message: "메모가 너무 길어요." },
    invalid_input: { kind: "invalid", field: "note", message: "메모는 3,000자까지 적을 수 있어요." },
    collection_missing: { kind: "stale", message: "선택한 컬렉션을 찾을 수 없어요. 목록을 새로 불러왔어요." },
    collection_duplicate: { kind: "unavailable", message: retryLater },
    identity_conflict: { kind: "unavailable", message: retryLater },
    product_missing: { kind: "stale", message: "상품을 찾을 수 없어요. 목록을 새로 불러왔어요." },
    metadata_not_retryable: { kind: "unavailable", message: retryLater },
    revision_conflict: { kind: "stale", message: changedElsewhere },
    picture_missing: { kind: "unavailable", message: retryLater },
    share_key_missing: { kind: "unavailable", message: retryLater },
  },
};

function errorBody(endpoint: Endpoint, code: ErrorCode) {
  if (code !== "invalid_input") return { error: code, message: "서버 문구" };
  if (endpoint === "library.restore") return { error: code, message: "백업 파일이 손상되었거나 바뀌었어요.", field: "products.0.sourceUrl" };
  if (endpoint === "product.change") return { error: code, message: "메모는 3,000자까지 적을 수 있어요.", field: "note" };
  return endpoint === "collection.create" || endpoint === "collection.rename"
    ? { error: code, message: "컬렉션 이름은 1~40자로 입력해 주세요.", field: "collection" }
    : { error: code, message: "서버가 거절한 링크예요.", field: "url" };
}

const cases = (Object.keys(expected) as Endpoint[]).flatMap((endpoint) =>
  (Object.keys(expected[endpoint]) as ErrorCode[]).map((code) => [endpoint, code] as const));

function respond(body: unknown, init: ResponseInit) {
  const fetcher = vi.fn<typeof fetch>(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), init));
  return { fetcher, api: createLibraryApi(fetcher) };
}

describe("API 오류 응답의 화면 결과", () => {
  it.each(cases)("Given %s의 %s 응답 When 결과로 바꾸면 Then 정한 화면 결과가 된다", (endpoint, code) => {
    expect(toApiFailure(endpoint, status[code], errorBody(endpoint, code))).toEqual(expected[endpoint][code]);
  });

  it("Given 링크 저장의 알 수 없는 필드 오류 When 결과로 바꾸면 Then 필드 없이 일반 문구를 보여준다", () => {
    const body = { error: "invalid_input", message: "링크 저장 입력을 확인해 주세요." };
    expect(toApiFailure("link.save", 400, body)).toEqual({ kind: "invalid", field: null, message: "입력을 확인해 주세요." });
    expect(toApiFailure("link.save", 400, { ...body, field: "collectionIds" }))
      .toEqual({ kind: "invalid", field: null, message: "입력을 확인해 주세요." });
  });

  it("Given 필드 없는 컬렉션 이름 오류 When 결과로 바꾸면 Then 이름 칸에 일반 문구를 보여준다", () => {
    expect(toApiFailure("collection.create", 400, { error: "invalid_input", message: "입력을 확인해 주세요." }))
      .toEqual({ kind: "invalid", field: "collection", message: "입력을 확인해 주세요." });
  });

  it("Given 필드를 가진 옵션·컬렉션 오류 When 결과로 바꾸면 Then 그 필드에 서버 문구를 붙인다", () => {
    for (const field of ["option", "collection"] as const) {
      expect(toApiFailure("link.save", 400, { error: "invalid_input", message: "옵션을 확인해요.", field }))
        .toEqual({ kind: "invalid", field, message: "옵션을 확인해요." });
    }
  });

  it("Given 상품 정리의 이름·구매일·실구매가 오류 When 결과로 바꾸면 Then 그 칸에 서버 문구를 붙이고, 모르는 필드는 새로고침을 안내한다", () => {
    for (const field of ["title", "note", "collection", "date", "price"] as const) {
      expect(toApiFailure("product.change", 400, { error: "invalid_input", message: "서버 문구", field }))
        .toEqual({ kind: "invalid", field, message: "서버 문구" });
    }
    expect(toApiFailure("product.change", 400, { error: "invalid_input", message: "상태가 맞지 않아요." }))
      .toEqual({ kind: "invalid", field: null, message: reload });
    expect(toApiFailure("link.save", 400, { error: "invalid_input", message: "서버 문구", field: "title" }))
      .toEqual({ kind: "invalid", field: null, message: "입력을 확인해 주세요." });
  });

  it("Given 계약에 없는 오류 본문 When 결과로 바꾸면 Then 401은 로그인으로, 나머지는 연결 안내로 바꾼다", () => {
    expect(toApiFailure("link.save", 401, "<html>login</html>")).toEqual({ kind: "redirect", to: "/login" });
    expect(toApiFailure("library.read", 500, { error: "boom" })).toEqual({ kind: "unavailable", message: connection });
    expect(toApiFailure("collection.create", 502, undefined)).toEqual({ kind: "unavailable", message: connection });
  });
});

describe("보관함 API 클라이언트", () => {
  it("Given 계약에 맞는 200 When 보관함을 읽으면 Then 보관함을 돌려주고 캐시하지 않는 GET을 보낸다", async () => {
    const { fetcher, api } = respond({ products: [product], collections: [collection] }, { status: 200 });
    await expect(api.read()).resolves.toEqual({ ok: true, value: { products: [product], collections: [collection] } });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/library");
    expect(init).toMatchObject({ method: "GET", cache: "no-store" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("Given 새 링크 When 저장하면 Then 정확한 경로·메서드·JSON 본문을 보내고 201 added를 돌려준다", async () => {
    const { fetcher, api } = respond({ kind: "added", product }, { status: 201 });
    await expect(api.saveLink(link)).resolves.toEqual({ ok: true, value: { kind: "added", product } });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/links");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual(link);
  });

  it("Given 이미 담은 링크 When 저장하면 Then 200 duplicate를 돌려준다", async () => {
    const { api } = respond({ kind: "duplicate", product }, { status: 200 });
    await expect(api.saveLink(link)).resolves.toEqual({ ok: true, value: { kind: "duplicate", product } });
  });

  it("Given 상태 코드와 kind가 어긋난 응답 When 저장하면 Then 연결 안내로 실패한다", async () => {
    for (const [kind, code] of [["added", 200], ["duplicate", 201]] as const) {
      const { api } = respond({ kind, product }, { status: code });
      await expect(api.saveLink(link)).resolves.toEqual({ ok: false, failure: { kind: "unavailable", message: connection } });
    }
  });

  it("Given 새 컬렉션 When 만들면 Then /api/collections에 이름을 보내고 201 컬렉션을 돌려준다", async () => {
    const { fetcher, api } = respond(collection, { status: 201 });
    await expect(api.createCollection({ name: "책상" })).resolves.toEqual({ ok: true, value: collection });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/collections");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "책상" });
  });

  it("Given 다시 가져오기 When 요청하면 Then 상품 경로에 세대를 보내고 202 상품을 돌려준다", async () => {
    const { fetcher, api } = respond({ product }, { status: 202 });
    await expect(api.retryMetadata(product.id, { generation: 1 })).resolves.toEqual({ ok: true, value: { product } });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe(`/api/products/${product.id}/metadata`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ generation: 1 });
  });

  it("Given 화면을 연 뒤 깨우기 When 요청하면 Then 빈 JSON을 POST로 보내고 202 상품 목록을 돌려준다", async () => {
    const { fetcher, api } = respond({ products: [product] }, { status: 202 });
    await expect(api.wake()).resolves.toEqual({ ok: true, value: { products: [product] } });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/library/metadata");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({});
  });

  it("Given 저장 키 When 읽으면 Then /api/share-keys를 GET으로 읽고 키를 돌려준다", async () => {
    const key = { id: "55555555-5555-4555-8555-555555555555", hint: "a1B2", createdAt: "2026-11-13T05:00:00.000Z", lastUsedAt: null, revokedAt: null };
    const { fetcher, api } = respond({ key }, { status: 200 });
    await expect(api.readShareKey()).resolves.toEqual({ ok: true, value: { key } });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/share-keys");
    expect(init?.method).toBe("GET");
    expect(init?.cache).toBe("no-store");
  });

  it("Given 새 저장 키 When 만들면 Then 화면이 본 키를 replaces로 POST하고 201 비밀을 돌려준다", async () => {
    const key = { id: "55555555-5555-4555-8555-555555555555", hint: "AZz9", createdAt: "2026-11-13T05:00:00.000Z", lastUsedAt: null, revokedAt: null };
    const secret = `moti_sk_${"AbcdEfghIjklMnopQrstUvwxYz0123456789-_AAZz9"}`;
    const { fetcher, api } = respond({ key, secret }, { status: 201 });
    await expect(api.issueShareKey({ replaces: null })).resolves.toEqual({ ok: true, value: { key, secret } });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/share-keys");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ replaces: null });
  });

  it("Given 저장 키 폐기 When 요청하면 Then 키 경로에 본문 없는 DELETE를 보내고 200 키를 돌려준다", async () => {
    const key = { id: "55555555-5555-4555-8555-555555555555", hint: "a1B2", createdAt: "2026-11-13T05:00:00.000Z", lastUsedAt: null, revokedAt: "2026-11-13T06:00:00.000Z" };
    const { fetcher, api } = respond({ key }, { status: 200 });
    await expect(api.revokeShareKey("../" + key.id)).resolves.toMatchObject({ ok: true });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe(`/api/share-keys/..%2F${key.id}`);
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
  });

  it("Given 다시 가져오기에 202가 아닌 성공 코드 When 요청하면 Then 연결 안내로 실패한다", async () => {
    const { api } = respond({ product }, { status: 200 });
    await expect(api.retryMetadata(product.id, { generation: 1 })).resolves.toEqual({ ok: false, failure: { kind: "unavailable", message: connection } });
  });

  it("Given 상품 정리 When 요청하면 Then 상품 경로에 PATCH로 revision과 변경을 보내고 200 상품을 돌려준다", async () => {
    const { fetcher, api } = respond({ product }, { status: 200 });
    const body = { revision: 2, change: { type: "details" as const, title: null, note: "선물용", collectionIds: [collection.id] } };
    await expect(api.changeProduct(product.id, body)).resolves.toEqual({ ok: true, value: { product } });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe(`/api/products/${product.id}`);
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("Given 컬렉션 이름 바꾸기 When 요청하면 Then 컬렉션 경로에 PATCH로 revision과 이름을 보내고 200 컬렉션을 돌려준다", async () => {
    const renamed = { ...collection, name: "작업 공간", revision: 2 };
    const { fetcher, api } = respond(renamed, { status: 200 });
    await expect(api.renameCollection(collection.id, { revision: 1, name: "작업 공간" })).resolves.toEqual({ ok: true, value: renamed });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe(`/api/collections/${collection.id}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ revision: 1, name: "작업 공간" });
  });

  it("Given 상품 정리에 200이 아닌 성공 코드 When 요청하면 Then 연결 안내로 실패한다", async () => {
    const { api } = respond({ product }, { status: 201 });
    await expect(api.changeProduct(product.id, { revision: 1, change: { type: "purchase" } }))
      .resolves.toEqual({ ok: false, failure: { kind: "unavailable", message: connection } });
  });

  it("Given 경로에 쓸 수 없는 문자가 섞인 id When 다시 가져오면 Then 경로 조각으로 인코딩한다", async () => {
    const { fetcher, api } = respond({ product }, { status: 202 });
    await api.retryMetadata("../library", { generation: 1 });
    expect(fetcher.mock.calls[0][0]).toBe("/api/products/..%2Flibrary/metadata");
  });

  it("Given 계약과 다른 200 본문 When 보관함을 읽으면 Then 연결 안내로 실패한다", async () => {
    const { api } = respond({ products: [{ ...product, id: "not-a-uuid" }], collections: [] }, { status: 200 });
    await expect(api.read()).resolves.toEqual({ ok: false, failure: { kind: "unavailable", message: connection } });
  });

  it("Given 성공 코드지만 JSON이 아닌 본문 When 컬렉션을 만들면 Then 연결 안내로 실패한다", async () => {
    const { api } = respond("<html>ok</html>", { status: 201 });
    await expect(api.createCollection({ name: "책상" })).resolves.toEqual({ ok: false, failure: { kind: "unavailable", message: connection } });
  });

  it("Given 네트워크 실패나 시간 초과 When 요청하면 Then 던지지 않고 연결 안내로 실패한다", async () => {
    const rejected = createLibraryApi(vi.fn<typeof fetch>(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(rejected.read()).resolves.toEqual({ ok: false, failure: { kind: "unavailable", message: connection } });
    const aborted = createLibraryApi(vi.fn<typeof fetch>(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    await expect(aborted.saveLink(link)).resolves.toEqual({ ok: false, failure: { kind: "unavailable", message: connection } });
  });

  it("Given 응답하지 않는 서버 When 제한 시간이 지나면 Then 요청을 끊고 연결 안내로 실패한다", async () => {
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    await expect(createLibraryApi(hanging, 5).read()).resolves.toEqual({ ok: false, failure: { kind: "unavailable", message: connection } });
  });

  it("Given HTML 401 When 요청하면 Then 로그인 화면으로 보낸다", async () => {
    const { api } = respond("<html>sign in</html>", { status: 401, headers: { "content-type": "text/html" } });
    await expect(api.read()).resolves.toEqual({ ok: false, failure: { kind: "redirect", to: "/login" } });
  });

  it("Given 계약에 맞는 오류 응답 When 요청하면 Then 매핑한 실패를 돌려준다", async () => {
    const { api } = respond({ error: "collection_missing", message: "선택한 컬렉션을 찾을 수 없어요." }, { status: 422 });
    await expect(api.saveLink(link)).resolves.toEqual({ ok: false, failure: expected["link.save"].collection_missing });
  });
});

describe("백업 API 클라이언트", () => {
  const backup = toLibraryBackupDocument({
    collections: [{ name: "책상", createdAt: "2026-11-11T00:00:00.000Z" }],
    products: [{
      sourceUrl: "https://example.com/item", identityUrl: "https://example.com/item", option: "", shop: "example.com",
      collectedTitle: "새로 담은 상품", ownerTitle: null, note: "", collectionNames: ["책상"], addedAt: "2026-11-11T00:00:00.000Z",
      purchase: { status: "wish" }, lastSuccessfulPrice: null,
    }],
  }, new Date("2026-11-13T05:12:00.000Z"));

  it("Given 계약에 맞는 백업 When 내려받으면 Then 읽기 함수로 확인한 글자 그대로와 서울 시각 이름·개수를 돌려준다", async () => {
    const text = JSON.stringify(backup);
    const { fetcher, api } = respond(text, { status: 200, headers: { "content-type": "application/json" } });

    await expect(api.exportBackup()).resolves.toEqual({
      ok: true,
      value: { name: "moti-backup-20261113-1412.json", text, counts: { products: 1, collections: 1 }, restorable: true },
    });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/library/backup");
    expect(init).toMatchObject({ method: "GET", cache: "no-store" });
  });

  it("Given 4MiB를 넘는 백업 When 내려받으면 Then 파일은 주되 한 번에 복원할 수 없다고 표시한다", async () => {
    const large = { ...backup, products: [{ ...backup.products[0], note: "가".repeat(3000) }] };
    const text = JSON.stringify(large) + " ".repeat(MAX_BACKUP_BYTES);
    const { api } = respond(text, { status: 200 });
    await expect(api.exportBackup()).resolves.toMatchObject({ ok: true, value: { restorable: false } });
  });

  it.each([
    ["백업이 아닌 200", { products: [] }],
    ["JSON이 아닌 200", "<html></html>"],
  ])("Given %s When 내려받으면 Then 백업을 만들지 못했다고 실패한다", async (_, body) => {
    const { api } = respond(body, { status: 200 });
    await expect(api.exportBackup()).resolves.toEqual({ ok: false, failure: backupFailed });
  });

  it("Given 세션 없음 When 내려받으면 Then 로그인으로 보낸다", async () => {
    const { api } = respond({ error: "signed_out", message: "로그인이 필요해요." }, { status: 401 });
    await expect(api.exportBackup()).resolves.toEqual({ ok: false, failure: signedIn.signed_out });
  });

  it("Given 고른 파일의 글자 When 복원하면 Then 그 글자를 그대로 JSON으로 보내고 바뀐 보관함을 돌려준다", async () => {
    const text = `${JSON.stringify(backup, null, 2)}\n`;
    const { fetcher, api } = respond({ products: [product], collections: [collection] }, { status: 200 });

    await expect(api.restore(text)).resolves.toEqual({ ok: true, value: { products: [product], collections: [collection] } });
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/library/restore");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe(text);
  });

  it("Given 큰 보관함의 복원 When 요청하면 Then 다른 요청의 15초 대신 60초까지 기다린다", async () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    try {
      const { api } = respond({ products: [], collections: [] }, { status: 200 });
      await api.restore("{}");
      await api.read();
      expect(timeouts).toEqual([60_000, 15_000]);
    } finally {
      spy.mockRestore();
    }
  });
});
