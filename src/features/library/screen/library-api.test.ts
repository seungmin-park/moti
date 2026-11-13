import { describe, expect, it, vi } from "vitest";
import type { CollectionResponse, ErrorCode, ProductResponse } from "../presentation/library-dto";
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
  storage_unavailable: 503,
};

const signedIn: Record<"signed_out" | "forbidden" | "unconfigured", ApiFailure> = {
  signed_out: { kind: "redirect", to: "/login" },
  forbidden: { kind: "redirect", to: "/login?error=forbidden" },
  unconfigured: { kind: "redirect", to: "/login?error=unconfigured" },
};

const expected: Record<Endpoint, Record<ErrorCode, ApiFailure>> = {
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
  },
};

function errorBody(endpoint: Endpoint, code: ErrorCode) {
  if (code !== "invalid_input") return { error: code, message: "서버 문구" };
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
