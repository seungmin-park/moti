import { describe, expect, it, vi } from "vitest";
import type { Access } from "../../auth/domain/access";
import { toLinkSaveCommand, type LibraryRestoreResult, type PictureViewResult } from "../application/commands";
import {
  LibraryError,
  type Collection,
  type CollectionId,
  type Library,
  type LibraryBackup,
  type Product,
  type ProductId,
} from "../domain/library";
import type { CollectionRequest } from "../../metadata/application/collection";
import type { MetadataRetryCommand, MetadataRetryResult } from "../../metadata/application/commands";
import { readLibraryBackup } from "./library-backup";
import { createLibraryHandlers } from "./library-handlers";
import {
  collectionCreateResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  collectionRenameResponseSchema,
  linkSaveResponseSchema,
  metadataRetryResponseSchema,
  productChangeResponseSchema,
} from "./library-dto";

const origin = "https://moti.test";
const signedUrl = "https://project.supabase.test/storage/v1/object/sign/product-pictures/a/b/c-1.webp?token=signed";
const allowed: Access = { kind: "allowed", userId: "user-1" };
const collection = {
  id: "11111111-1111-4111-8111-111111111111" as CollectionId,
  name: "책상",
  revision: 1,
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
} satisfies Collection;
const product = {
  id: "22222222-2222-4222-8222-222222222222" as ProductId,
  sourceUrl: "https://example.com/item",
  identityUrl: "https://example.com/item",
  option: "",
  shop: "example.com",
  title: "새로 담은 상품",
  note: "",
  revision: 1,
  collectionIds: [],
  addedAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  purchase: { status: "wish" },
  metadata: { phase: "queued", generation: 1, attempts: 0, stalled: false },
  lastSuccessfulPrice: null,
  picture: null,
} satisfies Product;
const backup = {
  collections: [{ name: "책상", createdAt: "2026-11-11T00:00:00.000Z" }],
  products: [{
    sourceUrl: "https://example.com/item?utm_source=x",
    identityUrl: "https://example.com/item",
    option: "",
    shop: "example.com",
    collectedTitle: "무선 헤드폰",
    ownerTitle: "내 헤드폰",
    note: "선물용",
    collectionNames: ["책상"],
    addedAt: "2026-11-11T00:00:00.000Z",
    purchase: { status: "purchased", date: null, price: { amountMinor: 0, currency: "KRW" } },
    lastSuccessfulPrice: null,
  }],
} satisfies LibraryBackup;

function given(access: Access) {
  const service = {
    snapshot: vi.fn(async (): Promise<Library> => ({ products: [product], collections: [collection] })),
    saveLink: vi.fn(async () => ({ kind: "added" as const, product })),
    createCollection: vi.fn(async () => collection),
    openPicture: vi.fn(async (): Promise<PictureViewResult> => ({ kind: "found", url: signedUrl })),
    changeProduct: vi.fn(async (): Promise<Product> => product),
    renameCollection: vi.fn(async (): Promise<Collection> => collection),
    exportLibrary: vi.fn(async (): Promise<LibraryBackup> => backup),
    restoreLibrary: vi.fn(async (): Promise<LibraryRestoreResult> => ({ library: { products: [product], collections: [collection] }, replacedPictures: [] })),
  };
  const signOut = vi.fn(async () => {});
  // collect is a mock: scheduling the collection is itself the requirement, its work happens after the response.
  const collect = vi.fn<(request: CollectionRequest) => void>();
  const retry = vi.fn(async (command: MetadataRetryCommand): Promise<MetadataRetryResult> => ({
    kind: "requeued",
    product: { ...product, id: command.productId, metadata: { phase: "queued", generation: 2, attempts: 0, stalled: false } },
  }));
  const handlers = createLibraryHandlers(async () => ({ access, service, signOut, collect, retry }));
  return { handlers, service, signOut, collect, retry };
}

const get = () => new Request(`${origin}/api/library`);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const link = { url: "https://example.com/item", option: "", collectionIds: [] };

async function errorOf(response: Response) {
  return errorResponseSchema.parse(await response.json());
}

describe("GET /api/library", () => {
  it("Given 허용한 Google 계정 When 보관함을 읽으면 Then 200과 계약에 맞는 보관함을 돌려준다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.getLibrary(get());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(libraryReadResponseSchema.parse(await response.json())).toEqual({ products: [product], collections: [collection] });
    expect(service.snapshot).toHaveBeenCalledOnce();
  });

  it("Given 사진 사본이 있는 상품 When 보관함을 읽으면 Then 같은 출처의 사진 주소와 이번 사진 결과만 돌려준다", async () => {
    const { handlers, service } = given(allowed);
    const version = "33333333-3333-4333-8333-333333333333";
    service.snapshot.mockResolvedValueOnce({
      products: [{
        ...product,
        metadata: {
          phase: "ready", generation: 2, attempts: 1, completedAt: "2026-11-12T00:00:00.000Z",
          image: { outcome: "failed", errorCode: "upload_failed" },
        },
        picture: { version },
      }],
      collections: [],
    });

    const body = libraryReadResponseSchema.parse(await (await handlers.getLibrary(get())).json());

    expect(body.products[0]).toMatchObject({
      metadata: { phase: "ready", image: { outcome: "failed", errorCode: "upload_failed" } },
      picture: { src: `/api/products/${product.id}/picture?v=${version}` },
    });
  });

  it.each([
    { src: "https://cdn.shop.example/a.jpg" },
    { src: "/storage/v1/object/sign/product-pictures/a/b/c-1.webp?token=x" },
    { src: "//evil.example/api/products/22222222-2222-4222-8222-222222222222/picture?v=33333333-3333-4333-8333-333333333333" },
    { src: "/api/products/22222222-2222-4222-8222-222222222222/picture?v=33333333-3333-4333-8333-333333333333", url: "x" },
  ])("Given 같은 출처 사진 경로가 아닌 $src When 계약으로 검증하면 Then 거절한다", (picture) => {
    const body = { products: [{ ...JSON.parse(JSON.stringify(product)), picture }], collections: [] };
    expect(libraryReadResponseSchema.safeParse(body).success).toBe(false);
  });

  it("Given 세션 없음 When 보관함을 읽으면 Then 401이고 서비스를 호출하지 않는다", async () => {
    const { handlers, service, signOut } = given({ kind: "signed_out" });
    const response = await handlers.getLibrary(get());
    expect(response.status).toBe(401);
    expect((await errorOf(response)).error).toBe("signed_out");
    expect(service.snapshot).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("Given 다른 Google 계정 When 보관함을 읽으면 Then 403이고 세션을 한 번 종료한다", async () => {
    const { handlers, service, signOut } = given({ kind: "forbidden" });
    const response = await handlers.getLibrary(get());
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toBe("forbidden");
    expect(signOut).toHaveBeenCalledOnce();
    expect(service.snapshot).not.toHaveBeenCalled();
  });

  it("Given 소유자 설정 누락 When 보관함을 읽으면 Then 503이고 데이터에 접근하지 않는다", async () => {
    const { handlers, service } = given({ kind: "unconfigured" });
    const response = await handlers.getLibrary(get());
    expect(response.status).toBe(503);
    expect((await errorOf(response)).error).toBe("unconfigured");
    expect(service.snapshot).not.toHaveBeenCalled();
  });

  it("Given 인증 서버 장애로 요청 정보를 만들 수 없음 When 보관함을 읽으면 Then 503을 돌려준다", async () => {
    const handlers = createLibraryHandlers(async () => { throw new Error("auth down"); });
    const response = await handlers.getLibrary(get());
    expect(response.status).toBe(503);
    expect((await errorOf(response)).error).toBe("storage_unavailable");
  });

  it("Given 허용 계정이지만 DB가 소유자를 거절 When 보관함을 읽으면 Then 403이고 세션을 종료한다", async () => {
    const { handlers, service, signOut } = given(allowed);
    service.snapshot.mockRejectedValueOnce(new LibraryError("unauthorized", "denied"));
    const response = await handlers.getLibrary(get());
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toBe("forbidden");
    expect(signOut).toHaveBeenCalledOnce();
  });
});

describe("POST /api/links", () => {
  it("Given 허용한 Google 계정 When 새 링크를 저장하면 Then 201과 상품을 돌려준다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.postLink(post("/api/links", link));
    expect(response.status).toBe(201);
    expect(linkSaveResponseSchema.parse(await response.json())).toEqual({ kind: "added", product });
    expect(service.saveLink).toHaveBeenCalledWith(toLinkSaveCommand(link));
  });

  it("Given 수집 대기인 새 상품 When 링크를 저장하면 Then 응답 뒤에 그 세대의 수집을 한 번 예약한다", async () => {
    const { handlers, collect } = given(allowed);
    const response = await handlers.postLink(post("/api/links", link));
    expect(response.status).toBe(201);
    expect(collect).toHaveBeenCalledExactlyOnceWith({ productId: product.id, generation: 1 });
  });

  it("Given 아직 수집 대기인 중복 상품 When 다시 저장하면 Then 수집을 다시 예약한다", async () => {
    const { handlers, service, collect } = given(allowed);
    service.saveLink.mockResolvedValueOnce({ kind: "duplicate" as never, product });
    await handlers.postLink(post("/api/links", link));
    expect(collect).toHaveBeenCalledExactlyOnceWith({ productId: product.id, generation: 1 });
  });

  it.each<Product["metadata"]>([
    { phase: "ready", generation: 1, attempts: 1, completedAt: "2026-11-11T00:00:00.000Z", image: { outcome: "absent" } },
    { phase: "failed", generation: 1, attempts: 1, errorCode: "timeout" },
    { phase: "running", generation: 1, attempts: 1, stalled: false },
  ])("Given 수집 단계가 $phase인 중복 상품 When 다시 저장하면 Then 수집을 예약하지 않는다", async (metadata) => {
    const { handlers, service, collect } = given(allowed);
    service.saveLink.mockResolvedValueOnce({ kind: "duplicate" as never, product: { ...product, metadata } as never });
    const response = await handlers.postLink(post("/api/links", link));
    expect(response.status).toBe(200);
    expect(collect).not.toHaveBeenCalled();
  });

  it("Given 저장 실패 When 링크를 저장하면 Then 수집을 예약하지 않는다", async () => {
    const { handlers, service, collect } = given(allowed);
    service.saveLink.mockRejectedValueOnce(new LibraryError("collection_missing", "없어요."));
    await handlers.postLink(post("/api/links", link));
    expect(collect).not.toHaveBeenCalled();
  });

  it("Given 이미 저장한 링크 When 다시 저장하면 Then 200과 기존 상품을 돌려준다", async () => {
    const { handlers, service } = given(allowed);
    service.saveLink.mockResolvedValueOnce({ kind: "duplicate" as never, product });
    const response = await handlers.postLink(post("/api/links", link));
    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("duplicate");
  });

  it.each([
    ["다른 출처", { origin: "https://evil.test" }],
    ["Origin 없음", { origin: "" }],
  ])("Given %s의 쓰기 요청 When 링크를 저장하면 Then 403이고 세션과 서비스를 건드리지 않는다", async (_, headers) => {
    const { handlers, service, signOut } = given(allowed);
    const response = await handlers.postLink(post("/api/links", link, headers));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toBe("cross_origin");
    expect(service.saveLink).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("Given JSON이 아닌 Content-Type When 링크를 저장하면 Then 415이고 저장하지 않는다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.postLink(post("/api/links", link, { "content-type": "text/plain" }));
    expect(response.status).toBe(415);
    expect(service.saveLink).not.toHaveBeenCalled();
  });

  it("Given 16KiB를 넘는 본문 When 링크를 저장하면 Then 413이고 저장하지 않는다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.postLink(post("/api/links", { ...link, option: "가".repeat(6000) }));
    expect(response.status).toBe(413);
    expect(service.saveLink).not.toHaveBeenCalled();
  });

  it("Given 형식은 맞지만 업무 규칙에 맞지 않는 링크 When 저장하면 Then 400과 필드를 돌려주고 저장하지 않는다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.postLink(post("/api/links", { ...link, url: "javascript:alert(1)" }));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ error: "invalid_input", field: "url" });
    expect(service.saveLink).not.toHaveBeenCalled();
  });

  it.each([
    ["깨진 JSON", "{"],
    ["배열 본문", "[]"],
    ["알 수 없는 필드", JSON.stringify({ ...link, owner: "someone" })],
    ["필드 누락", JSON.stringify({ url: link.url })],
  ])("Given %s When 링크를 저장하면 Then 400이고 저장하지 않는다", async (_, body) => {
    const { handlers, service } = given(allowed);
    const response = await handlers.postLink(post("/api/links", body));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe("invalid_input");
    expect(service.saveLink).not.toHaveBeenCalled();
  });

  it("Given 다른 Google 계정 When 링크를 저장하면 Then 본문을 읽기 전에 403으로 거절한다", async () => {
    const { handlers, service, signOut } = given({ kind: "forbidden" });
    const response = await handlers.postLink(post("/api/links", "{"));
    expect(response.status).toBe(403);
    expect(signOut).toHaveBeenCalledOnce();
    expect(service.saveLink).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_input", 400, "url"],
    ["collection_missing", 422, undefined],
    ["identity_conflict", 409, undefined],
    ["storage_unavailable", 503, undefined],
  ] as const)("Given 서비스가 %s로 실패 When 링크를 저장하면 Then %i을 돌려준다", async (code, status, field) => {
    const { handlers, service } = given(allowed);
    service.saveLink.mockRejectedValueOnce(new LibraryError(code, "실패 메시지", field));
    const response = await handlers.postLink(post("/api/links", link));
    expect(response.status).toBe(status);
    const body = await errorOf(response);
    expect(body).toMatchObject({ error: code, message: "실패 메시지" });
    expect(body.field).toBe(field);
  });

  it("Given 예상하지 못한 서비스 오류 When 링크를 저장하면 Then 내부 메시지를 숨기고 503을 돌려준다", async () => {
    const { handlers, service } = given(allowed);
    service.saveLink.mockRejectedValueOnce(new Error("password=secret at db.internal"));
    const response = await handlers.postLink(post("/api/links", link));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});

describe("POST /api/collections", () => {
  it("Given 허용한 Google 계정 When 컬렉션을 만들면 Then 201과 컬렉션을 돌려준다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.postCollection(post("/api/collections", { name: "책상" }));
    expect(response.status).toBe(201);
    expect(collectionCreateResponseSchema.parse(await response.json())).toEqual(collection);
    expect(service.createCollection).toHaveBeenCalledWith({ name: "책상" });
  });

  it("Given 앞뒤 공백이 있는 이름 When 컬렉션을 만들면 Then 정규화한 명령으로 서비스를 호출한다", async () => {
    const { handlers, service } = given(allowed);
    await handlers.postCollection(post("/api/collections", { name: " 책상 " }));
    expect(service.createCollection).toHaveBeenCalledWith({ name: "책상" });
  });

  it("Given 같은 이름 When 컬렉션을 만들면 Then 409를 돌려준다", async () => {
    const { handlers, service } = given(allowed);
    service.createCollection.mockRejectedValueOnce(new LibraryError("collection_duplicate", "이미 있어요."));
    const response = await handlers.postCollection(post("/api/collections", { name: "책상" }));
    expect(response.status).toBe(409);
    expect((await errorOf(response)).error).toBe("collection_duplicate");
  });

  it("Given 세션 없음 When 컬렉션을 만들면 Then 401이고 만들지 않는다", async () => {
    const { handlers, service } = given({ kind: "signed_out" });
    const response = await handlers.postCollection(post("/api/collections", { name: "책상" }));
    expect(response.status).toBe(401);
    expect(service.createCollection).not.toHaveBeenCalled();
  });
});

describe("POST /api/products/{productId}/metadata", () => {
  const productId = product.id;
  const retryRequest = (body: unknown = { generation: 1 }, headers: Record<string, string> = {}, id: string = productId) =>
    [post(`/api/products/${id}/metadata`, body, headers), { params: Promise.resolve({ productId: id }) }] as const;

  it("Given 실패한 상품 When 다시 가져오면 Then 202와 새 세대 상품을 돌려주고 그 세대의 수집을 예약한다", async () => {
    const { handlers, retry, collect } = given(allowed);
    const response = await handlers.postMetadataRetry(...retryRequest({ generation: 1 }, {}, productId.toUpperCase()));
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = metadataRetryResponseSchema.parse(await response.json());
    expect(body.product).toMatchObject({ id: productId, metadata: { phase: "queued", generation: 2, stalled: false } });
    expect(retry).toHaveBeenCalledExactlyOnceWith({ productId, expectedGeneration: 1 });
    expect(collect).toHaveBeenCalledExactlyOnceWith({ productId, generation: 2 });
  });

  it("Given 멈춘 작업 When 다시 가져오면 Then 같은 세대의 수집을 다시 예약한다", async () => {
    const { handlers, retry, collect } = given(allowed);
    retry.mockResolvedValueOnce({ kind: "resumed", product: { ...product, metadata: { phase: "queued", generation: 1, attempts: 1, stalled: false } } });
    const response = await handlers.postMetadataRetry(...retryRequest());
    expect(response.status).toBe(202);
    expect(collect).toHaveBeenCalledExactlyOnceWith({ productId, generation: 1 });
  });

  it.each([
    ["product_missing", 404],
    ["metadata_not_retryable", 409],
    ["storage_unavailable", 503],
  ] as const)("Given 저장소가 %s로 거절 When 다시 가져오면 Then %i이고 수집을 예약하지 않는다", async (code, status) => {
    const { handlers, retry, collect } = given(allowed);
    retry.mockRejectedValueOnce(new LibraryError(code, "거절"));
    const response = await handlers.postMetadataRetry(...retryRequest());
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error).toBe(code);
    expect(collect).not.toHaveBeenCalled();
  });

  it.each([
    ["UUID가 아닌 상품", { generation: 1 }, "not-a-uuid"],
    ["0 세대", { generation: 0 }, productId],
    ["소수 세대", { generation: 1.5 }, productId],
    ["저장할 수 있는 범위를 넘는 세대", { generation: 2147483648 }, productId],
    ["문자열 세대", { generation: "1" }, productId],
    ["세대 누락", {}, productId],
    ["알 수 없는 필드", { generation: 1, force: true }, productId],
    ["깨진 JSON", "{", productId],
  ])("Given %s When 다시 가져오면 Then 400이고 저장소를 부르지 않는다", async (_, body, id) => {
    const { handlers, retry, collect } = given(allowed);
    const response = await handlers.postMetadataRetry(...retryRequest(body, {}, id));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe("invalid_input");
    expect(retry).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it("Given 다른 출처의 요청 When 다시 가져오면 Then 403이고 세션과 저장소를 건드리지 않는다", async () => {
    const { handlers, retry, signOut } = given(allowed);
    const response = await handlers.postMetadataRetry(...retryRequest({ generation: 1 }, { origin: "https://evil.test" }));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toBe("cross_origin");
    expect(retry).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("Given 세션 없음 When 다시 가져오면 Then 401이고 저장소를 부르지 않는다", async () => {
    const { handlers, retry } = given({ kind: "signed_out" });
    const response = await handlers.postMetadataRetry(...retryRequest());
    expect(response.status).toBe(401);
    expect(retry).not.toHaveBeenCalled();
  });

  it("Given 다른 Google 계정 When 다시 가져오면 Then 403이고 세션을 한 번 종료한다", async () => {
    const { handlers, retry, signOut, collect } = given({ kind: "forbidden" });
    const response = await handlers.postMetadataRetry(...retryRequest());
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toBe("forbidden");
    expect(signOut).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it("Given JSON이 아닌 본문 When 다시 가져오면 Then 415다", async () => {
    const { handlers, retry } = given(allowed);
    const response = await handlers.postMetadataRetry(...retryRequest({ generation: 1 }, { "content-type": "text/plain" }));
    expect(response.status).toBe(415);
    expect(retry).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/products/{productId}", () => {
  const productId = product.id;
  const desk = collection.id;
  const patch = (body: unknown, headers: Record<string, string> = {}, id: string = productId) =>
    [new Request(`${origin}/api/products/${id}`, {
      method: "PATCH",
      headers: { origin, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }), { params: Promise.resolve({ productId: id }) }] as const;

  it.each([
    [
      "이름·메모·컬렉션",
      { type: "details", title: "  책상 조명 ", note: "선물용", collectionIds: [desk.toUpperCase(), desk] },
      { type: "details", title: "책상 조명", note: "선물용", collectionIds: [desk] },
    ],
    ["이름을 두고 메모만", { type: "details", title: null, note: "", collectionIds: [] }, { type: "details", title: null, note: "", collectionIds: [] }],
    ["구매완료", { type: "purchase" }, { type: "purchase" }],
    [
      "구매 기록",
      { type: "purchase.record", date: "2026-11-01", price: { amountMinor: 0, currency: "KRW" } },
      { type: "purchase.record", date: "2026-11-01", price: { amountMinor: 0, currency: "KRW" } },
    ],
    ["빈 구매 기록", { type: "purchase.record", date: null, price: null }, { type: "purchase.record", date: null, price: null }],
    ["위시로 되돌리기", { type: "wish" }, { type: "wish" }],
  ] as const)("Given %s 변경 When 상품을 고치면 Then 200과 바뀐 상품을 돌려주고 정리한 명령으로 서비스를 부른다", async (_, change, expected) => {
    const { handlers, service } = given(allowed);
    const changed = { ...product, revision: 4, note: "선물용" };
    service.changeProduct.mockResolvedValueOnce(changed);

    const response = await handlers.patchProduct(...patch({ revision: 3, change }, {}, productId.toUpperCase()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(productChangeResponseSchema.parse(await response.json())).toEqual({ product: changed });
    expect(service.changeProduct).toHaveBeenCalledExactlyOnceWith({ productId, revision: 3, change: expected });
  });

  it.each([
    ["깨진 JSON", "{", undefined],
    ["알 수 없는 필드", { revision: 1, change: { type: "purchase" }, force: true }, undefined],
    ["revision 누락", { change: { type: "purchase" } }, undefined],
    ["0 revision", { revision: 0, change: { type: "purchase" } }, undefined],
    ["소수 revision", { revision: 1.5, change: { type: "purchase" } }, undefined],
    ["저장할 수 있는 범위를 넘는 revision", { revision: 2147483648, change: { type: "purchase" } }, undefined],
    ["알 수 없는 변경", { revision: 1, change: { type: "delete" } }, undefined],
    ["구매완료에 붙은 값", { revision: 1, change: { type: "purchase", date: null } }, undefined],
    ["101개 컬렉션", { revision: 1, change: { type: "details", title: null, note: "", collectionIds: Array(101).fill(collection.id) } }, undefined],
    ["공백뿐인 이름", { revision: 1, change: { type: "details", title: "  ", note: "", collectionIds: [] } }, "title"],
    ["121자 이름", { revision: 1, change: { type: "details", title: "가".repeat(121), note: "", collectionIds: [] } }, "title"],
    ["3001자 메모", { revision: 1, change: { type: "details", title: null, note: "가".repeat(3001), collectionIds: [] } }, "note"],
    ["UUID가 아닌 컬렉션", { revision: 1, change: { type: "details", title: null, note: "", collectionIds: ["desk"] } }, "collection"],
    ["형식이 다른 구매일", { revision: 1, change: { type: "purchase.record", date: "2026/11/01", price: null } }, "date"],
    ["미래 구매일", { revision: 1, change: { type: "purchase.record", date: "2999-01-01", price: null } }, "date"],
    ["음수 실구매가", { revision: 1, change: { type: "purchase.record", date: null, price: { amountMinor: -1, currency: "KRW" } } }, "price"],
    ["소수 실구매가", { revision: 1, change: { type: "purchase.record", date: null, price: { amountMinor: 1.5, currency: "KRW" } } }, "price"],
    ["원화가 아닌 실구매가", { revision: 1, change: { type: "purchase.record", date: null, price: { amountMinor: 1000, currency: "USD" } } }, "price"],
  ])("Given %s When 상품을 고치면 Then 400이고 서비스를 부르지 않는다", async (_, body, field) => {
    const { handlers, service } = given(allowed);
    const response = await handlers.patchProduct(...patch(body));
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.error).toBe("invalid_input");
    expect(error.field).toBe(field);
    expect(service.changeProduct).not.toHaveBeenCalled();
  });

  it("Given UUID가 아닌 상품 When 고치면 Then 400이고 서비스를 부르지 않는다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.patchProduct(...patch({ revision: 1, change: { type: "purchase" } }, {}, "not-a-uuid"));
    expect(response.status).toBe(400);
    expect(service.changeProduct).not.toHaveBeenCalled();
  });

  it.each([
    ["revision_conflict", 409],
    ["product_missing", 404],
    ["collection_missing", 422],
    ["invalid_input", 400],
    ["storage_unavailable", 503],
  ] as const)("Given 저장소가 %s로 거절 When 상품을 고치면 Then %i이다", async (code, status) => {
    const { handlers, service } = given(allowed);
    service.changeProduct.mockRejectedValueOnce(new LibraryError(code, "거절"));
    const response = await handlers.patchProduct(...patch({ revision: 1, change: { type: "purchase" } }));
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error).toBe(code);
  });

  it("Given 다른 출처의 요청 When 상품을 고치면 Then 403이고 세션과 서비스를 건드리지 않는다", async () => {
    const { handlers, service, signOut } = given(allowed);
    const response = await handlers.patchProduct(...patch({ revision: 1, change: { type: "purchase" } }, { origin: "https://evil.test" }));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toBe("cross_origin");
    expect(service.changeProduct).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "signed_out" } as Access, 401, "signed_out"],
    [{ kind: "unconfigured" } as Access, 503, "unconfigured"],
  ])("Given 접근 결과 $kind When 상품을 고치면 Then %i이고 서비스를 부르지 않는다", async (access, status, code) => {
    const { handlers, service } = given(access);
    const response = await handlers.patchProduct(...patch({ revision: 1, change: { type: "purchase" } }));
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error).toBe(code);
    expect(service.changeProduct).not.toHaveBeenCalled();
  });

  it("Given 다른 Google 계정 When 상품을 고치면 Then 403이고 세션을 한 번 종료한다", async () => {
    const { handlers, service, signOut } = given({ kind: "forbidden" });
    const response = await handlers.patchProduct(...patch({ revision: 1, change: { type: "purchase" } }));
    expect(response.status).toBe(403);
    expect(signOut).toHaveBeenCalledOnce();
    expect(service.changeProduct).not.toHaveBeenCalled();
  });

  it("Given 허용 계정이지만 DB가 소유자를 거절 When 상품을 고치면 Then 403이고 세션을 종료한다", async () => {
    const { handlers, service, signOut } = given(allowed);
    service.changeProduct.mockRejectedValueOnce(new LibraryError("unauthorized", "denied"));
    const response = await handlers.patchProduct(...patch({ revision: 1, change: { type: "purchase" } }));
    expect(response.status).toBe(403);
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("Given JSON이 아니거나 16KiB를 넘는 본문 When 상품을 고치면 Then 415·413이고 서비스를 부르지 않는다", async () => {
    const { handlers, service } = given(allowed);
    expect((await handlers.patchProduct(...patch({ revision: 1, change: { type: "purchase" } }, { "content-type": "text/plain" }))).status).toBe(415);
    const large = { revision: 1, change: { type: "details", title: null, note: "가".repeat(6000), collectionIds: [] } };
    expect((await handlers.patchProduct(...patch(large))).status).toBe(413);
    expect(service.changeProduct).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/collections/{collectionId}", () => {
  const collectionId = collection.id;
  const patch = (body: unknown, headers: Record<string, string> = {}, id: string = collectionId) =>
    [new Request(`${origin}/api/collections/${id}`, {
      method: "PATCH",
      headers: { origin, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }), { params: Promise.resolve({ collectionId: id }) }] as const;

  it("Given 새 이름 When 컬렉션 이름을 바꾸면 Then 200과 컬렉션을 돌려주고 정리한 이름으로 서비스를 부른다", async () => {
    const { handlers, service } = given(allowed);
    const renamed = { ...collection, name: "작업 공간", revision: 2 };
    service.renameCollection.mockResolvedValueOnce(renamed);

    const response = await handlers.patchCollection(...patch({ revision: 1, name: " 작업 공간 " }, {}, collectionId.toUpperCase()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(collectionRenameResponseSchema.parse(await response.json())).toEqual(renamed);
    expect(service.renameCollection).toHaveBeenCalledExactlyOnceWith({ collectionId, revision: 1, name: "작업 공간" });
  });

  it.each([
    ["빈 이름", { revision: 1, name: " " }, "collection"],
    ["41자 이름", { revision: 1, name: "가".repeat(41) }, "collection"],
    ["revision 누락", { name: "책상" }, undefined],
    ["알 수 없는 필드", { revision: 1, name: "책상", owner: "x" }, undefined],
    ["문자열이 아닌 이름", { revision: 1, name: 1 }, undefined],
  ])("Given %s When 컬렉션 이름을 바꾸면 Then 400이고 서비스를 부르지 않는다", async (_, body, field) => {
    const { handlers, service } = given(allowed);
    const response = await handlers.patchCollection(...patch(body));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).field).toBe(field);
    expect(service.renameCollection).not.toHaveBeenCalled();
  });

  it("Given UUID가 아닌 컬렉션 When 이름을 바꾸면 Then 400이고 서비스를 부르지 않는다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.patchCollection(...patch({ revision: 1, name: "책상" }, {}, "desk"));
    expect(response.status).toBe(400);
    expect(service.renameCollection).not.toHaveBeenCalled();
  });

  it.each([
    ["collection_duplicate", 409],
    ["revision_conflict", 409],
    ["collection_missing", 422],
  ] as const)("Given 저장소가 %s로 거절 When 이름을 바꾸면 Then %i이다", async (code, status) => {
    const { handlers, service } = given(allowed);
    service.renameCollection.mockRejectedValueOnce(new LibraryError(code, "거절"));
    const response = await handlers.patchCollection(...patch({ revision: 1, name: "책상" }));
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error).toBe(code);
  });

  it("Given 다른 출처의 요청 When 이름을 바꾸면 Then 403이고 서비스를 부르지 않는다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.patchCollection(...patch({ revision: 1, name: "책상" }, { origin: "https://evil.test" }));
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toBe("cross_origin");
    expect(service.renameCollection).not.toHaveBeenCalled();
  });

  it("Given 세션 없음 When 이름을 바꾸면 Then 401이고 서비스를 부르지 않는다", async () => {
    const { handlers, service } = given({ kind: "signed_out" });
    const response = await handlers.patchCollection(...patch({ revision: 1, name: "책상" }));
    expect(response.status).toBe(401);
    expect(service.renameCollection).not.toHaveBeenCalled();
  });
});

describe("배포 환경의 요청 주소", () => {
  it("Given 서버 내부 URL과 브라우저 Host가 다름 When 같은 Host에서 쓰기 요청 Then Host 헤더 기준으로 허용한다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.postLink(new Request("http://localhost:3000/api/links", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify(link),
    }));
    expect(response.status).toBe(201);
    expect(service.saveLink).toHaveBeenCalledOnce();
  });

  it("Given 프록시가 공개 Host를 전달 When 공개 주소에서 쓰기 요청 Then x-forwarded-host 기준으로 허용한다", async () => {
    const { handlers } = given(allowed);
    const response = await handlers.postLink(new Request("http://localhost:3000/api/links", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "x-forwarded-host": "moti.example.com",
        origin: "https://moti.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify(link),
    }));
    expect(response.status).toBe(201);
  });
});

describe("세션 종료 실패", () => {
  it("Given 다른 Google 계정이고 세션 종료가 실패 When 보관함을 읽으면 Then 그래도 403을 돌려준다", async () => {
    const { handlers, signOut } = given({ kind: "forbidden" });
    signOut.mockRejectedValueOnce(new Error("auth down"));
    const response = await handlers.getLibrary(get());
    expect(response.status).toBe(403);
  });
});

describe("GET /api/products/{productId}/picture", () => {
  const productId = product.id;
  const pictureRequest = (id: string = productId) =>
    [new Request(`${origin}/api/products/${id}/picture?v=33333333-3333-4333-8333-333333333333`),
      { params: Promise.resolve({ productId: id }) }] as const;

  it("Given 소유자와 저장한 사본 When 브라우저가 사진을 요청하면 Then 짧게 서명한 주소로 보내고 개인 캐시에만 50분 둔다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.getPicture(...pictureRequest(productId.toUpperCase()));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(signedUrl);
    expect(response.headers.get("cache-control")).toBe("private, max-age=3000");
    expect(await response.text()).toBe("");
    expect(service.openPicture).toHaveBeenCalledExactlyOnceWith({ productId });
  });

  it("Given 사본이 없는 상품 When 사진을 요청하면 Then 404이고 캐시하지 않는다", async () => {
    const { handlers, service } = given(allowed);
    service.openPicture.mockResolvedValueOnce({ kind: "missing" });
    const response = await handlers.getPicture(...pictureRequest());
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await errorOf(response)).error).toBe("picture_missing");
  });

  it("Given UUID가 아닌 상품 When 사진을 요청하면 Then 400이고 저장소를 부르지 않는다", async () => {
    const { handlers, service } = given(allowed);
    const response = await handlers.getPicture(...pictureRequest("not-a-uuid"));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe("invalid_input");
    expect(service.openPicture).not.toHaveBeenCalled();
  });

  it.each([
    ["product_missing", 404],
    ["storage_unavailable", 503],
  ] as const)("Given 저장소가 %s로 답함 When 사진을 요청하면 Then %i이다", async (code, status) => {
    const { handlers, service } = given(allowed);
    service.openPicture.mockRejectedValueOnce(new LibraryError(code, "거절"));
    const response = await handlers.getPicture(...pictureRequest());
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error).toBe(code);
  });

  it.each([
    [{ kind: "signed_out" } as Access, 401, "signed_out"],
    [{ kind: "unconfigured" } as Access, 503, "unconfigured"],
  ])("Given 접근 결과 $kind When 사진을 요청하면 Then %i이고 저장소를 부르지 않는다", async (access, status, code) => {
    const { handlers, service } = given(access);
    const response = await handlers.getPicture(...pictureRequest());
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error).toBe(code);
    expect(service.openPicture).not.toHaveBeenCalled();
  });

  it("Given 다른 Google 계정 When 사진을 요청하면 Then 403이고 세션을 한 번 종료한다", async () => {
    const { handlers, service, signOut } = given({ kind: "forbidden" });
    const response = await handlers.getPicture(...pictureRequest());
    expect(response.status).toBe(403);
    expect(signOut).toHaveBeenCalledOnce();
    expect(service.openPicture).not.toHaveBeenCalled();
  });
});

describe("GET /api/library/backup", () => {
  const download = () => new Request(`${origin}/api/library/backup`);

  it("Given 허용한 Google 계정 When 백업을 받으면 Then 서울 시각 이름의 첨부 파일로 읽기 함수가 받는 백업을 돌려준다", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T05:12:30.000Z"), toFake: ["Date"] });
    try {
      const { handlers, service } = given(allowed);

      const response = await handlers.getBackup(download());

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("content-disposition")).toBe('attachment; filename="moti-backup-20261113-1412.json"');
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const reading = readLibraryBackup(JSON.parse(await response.text()));
      expect(reading).toMatchObject({ ok: true, counts: { products: 1, collections: 1 } });
      expect(reading.ok && reading.document).toMatchObject({
        exportedAt: "2026-11-13T05:12:30.000Z",
        products: [{ sourceUrl: "https://example.com/item?utm_source=x", collectedTitle: "무선 헤드폰", ownerTitle: "내 헤드폰", collections: ["책상"] }],
      });
      expect(service.exportLibrary).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Given 다른 출처의 페이지 When 백업을 받으면 Then 읽기라 출처를 묻지 않고 세션으로 판단한다", async () => {
    const { handlers } = given(allowed);
    const response = await handlers.getBackup(new Request(`${origin}/api/library/backup`, { headers: { origin: "https://evil.test" } }));
    expect(response.status).toBe(200);
  });

  it.each([
    { access: { kind: "signed_out" } as Access, status: 401, error: "signed_out", signedOut: false },
    { access: { kind: "forbidden" } as Access, status: 403, error: "forbidden", signedOut: true },
    { access: { kind: "unconfigured" } as Access, status: 503, error: "unconfigured", signedOut: false },
  ])("Given $error When 백업을 받으면 Then $status JSON 오류이고 보관함을 읽지 않는다", async ({ access, status, error, signedOut }) => {
    const { handlers, service, signOut } = given(access);
    const response = await handlers.getBackup(download());
    expect(response.status).toBe(status);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect((await errorOf(response)).error).toBe(error);
    expect(service.exportLibrary).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(signedOut ? 1 : 0);
  });

  it("Given 저장소 오류 When 백업을 받으면 Then 503 JSON 오류이고 첨부 파일이 아니다", async () => {
    const { handlers, service } = given(allowed);
    service.exportLibrary.mockRejectedValueOnce(new LibraryError("storage_unavailable", "저장소를 사용할 수 없어요."));
    const response = await handlers.getBackup(download());
    expect(response.status).toBe(503);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect((await errorOf(response)).error).toBe("storage_unavailable");
  });
});
