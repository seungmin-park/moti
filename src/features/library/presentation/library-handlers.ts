import type { Access } from "../../auth/domain/access";
import type { CollectionRequest } from "../../metadata/application/collection";
import { toMetadataRetryCommand, type MetadataRetryCommand, type MetadataRetryResult } from "../../metadata/application/commands";
import { isSameOrigin, readJsonBody } from "../../shared/presentation/http";
import { toCollectionCreateCommand, toLinkSaveCommand, toPictureViewCommand } from "../application/commands";
import type { LibraryService } from "../application/library-service";
import { LibraryError, type LibraryErrorCode } from "../domain/library";
import {
  collectionCreateRequestSchema,
  linkSaveRequestSchema,
  metadataRetryRequestSchema,
  toCollectionResponse,
  toLibraryReadResponse,
  toLinkSaveResponse,
  toMetadataRetryResponse,
  type ErrorCode,
  type ErrorResponse,
} from "./library-dto";

export type LibraryRequestContext = {
  access: Access;
  service: LibraryService;
  signOut(): Promise<void>;
  // Schedules collection to run after the response is sent; it never delays or fails the request.
  collect(request: CollectionRequest): void;
  retry(command: MetadataRetryCommand): Promise<MetadataRetryResult>;
};
export type ProductRoute = { params: Promise<{ productId: string }> };

const errorStatus: Record<ErrorCode, number> = {
  signed_out: 401,
  forbidden: 403,
  cross_origin: 403,
  unconfigured: 503,
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

const errorMessages: Record<ErrorCode, string> = {
  signed_out: "로그인이 필요해요.",
  forbidden: "이 계정으로는 보관함을 열 수 없어요.",
  cross_origin: "이 화면에서 보낸 요청이 아니에요.",
  unconfigured: "보관함 소유자 설정이 아직 없어요.",
  unsupported_media_type: "JSON 형식으로 보내 주세요.",
  payload_too_large: "요청이 너무 커요.",
  invalid_input: "입력을 확인해 주세요.",
  collection_missing: "선택한 컬렉션을 찾을 수 없어요.",
  collection_duplicate: "같은 이름의 컬렉션이 이미 있어요.",
  identity_conflict: "같은 링크를 확인하지 못했어요. 다시 시도해 주세요.",
  product_missing: "상품을 찾을 수 없어요.",
  metadata_not_retryable: "지금은 정보를 다시 가져올 수 없어요.",
  revision_conflict: "다른 곳에서 먼저 바뀌었어요. 최신 내용을 확인해 주세요.",
  picture_missing: "보여줄 사진이 없어요.",
  storage_unavailable: "잠시 뒤 다시 시도해 주세요.",
};

const fromLibraryError: Record<LibraryErrorCode, ErrorCode> = {
  invalid_input: "invalid_input",
  unauthorized: "forbidden",
  collection_missing: "collection_missing",
  collection_duplicate: "collection_duplicate",
  identity_conflict: "identity_conflict",
  product_missing: "product_missing",
  metadata_not_retryable: "metadata_not_retryable",
  revision_conflict: "revision_conflict",
  storage_unavailable: "storage_unavailable",
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function failure(code: ErrorCode, message = errorMessages[code], field?: string): Response {
  const body: ErrorResponse = { error: code, message, ...(field && { field }) };
  return json(errorStatus[code], body);
}

type Allowed = Pick<LibraryRequestContext, "service" | "collect" | "retry">;
type Action<Route> = (allowed: Allowed, request: Request, route: Route) => Promise<Response>;

export function createLibraryHandlers(context: (request: Request) => Promise<LibraryRequestContext>) {
  function handle<Route = unknown>(action: Action<Route>, { write }: { write: boolean }) {
    return async (request: Request, route?: Route): Promise<Response> => {
      if (write && !isSameOrigin(request)) return failure("cross_origin");
      let current: LibraryRequestContext;
      try {
        current = await context(request);
      } catch {
        return failure("storage_unavailable");
      }
      const { access } = current;
      if (access.kind === "forbidden") {
        await current.signOut().catch(() => undefined);
        return failure("forbidden");
      }
      if (access.kind !== "allowed") return failure(access.kind);
      try {
        return await action(current, request, route as Route);
      } catch (error) {
        if (!(error instanceof LibraryError)) return failure("storage_unavailable");
        const code = fromLibraryError[error.code];
        if (code === "forbidden") {
          await current.signOut().catch(() => undefined);
          return failure("forbidden");
        }
        return failure(code, error.message, error.field);
      }
    };
  }

  async function readRequest<T>(request: Request, parse: (value: unknown) => T): Promise<T | Response> {
    const body = await readJsonBody(request);
    if (!body.ok) return failure(body.reason === "invalid_json" ? "invalid_input" : body.reason);
    try {
      return parse(body.value);
    } catch {
      return failure("invalid_input");
    }
  }

  return {
    getLibrary: handle(async ({ service }) => json(200, toLibraryReadResponse(await service.snapshot())), { write: false }),
    postLink: handle(async ({ service, collect }, request) => {
      const linkSaveRequest = await readRequest(request, (value) => linkSaveRequestSchema.parse(value));
      if (linkSaveRequest instanceof Response) return linkSaveRequest;
      const result = await service.saveLink(toLinkSaveCommand(linkSaveRequest));
      const { id, metadata } = result.product;
      if (metadata.phase === "queued") collect({ productId: id, generation: metadata.generation });
      return json(result.kind === "added" ? 201 : 200, toLinkSaveResponse(result));
    }, { write: true }),
    postCollection: handle(async ({ service }, request) => {
      const collectionCreateRequest = await readRequest(request, (value) => collectionCreateRequestSchema.parse(value));
      if (collectionCreateRequest instanceof Response) return collectionCreateRequest;
      const collection = await service.createCollection(toCollectionCreateCommand(collectionCreateRequest.name));
      return json(201, toCollectionResponse(collection));
    }, { write: true }),
    postMetadataRetry: handle<ProductRoute>(async ({ retry, collect }, request, route) => {
      const { productId } = await route.params;
      const metadataRetryRequest = await readRequest(request, (value) => metadataRetryRequestSchema.parse(value));
      if (metadataRetryRequest instanceof Response) return metadataRetryRequest;
      const result = await retry(toMetadataRetryCommand(productId, metadataRetryRequest.generation));
      const { id, metadata } = result.product;
      collect({ productId: id, generation: metadata.generation });
      return json(202, toMetadataRetryResponse(result));
    }, { write: true }),
    // The src of an <img>: same-origin and stable for one copy. Each request signs a fresh short-lived link, and the
    // browser keeps the redirect privately for less than that link lives.
    getPicture: handle<ProductRoute>(async ({ service }, _request, route) => {
      const { productId } = await route.params;
      const picture = await service.openPicture(toPictureViewCommand(productId));
      if (picture.kind === "missing") return failure("picture_missing");
      return new Response(null, { status: 302, headers: { location: picture.url, "cache-control": "private, max-age=3000" } });
    }, { write: false }),
  };
}
