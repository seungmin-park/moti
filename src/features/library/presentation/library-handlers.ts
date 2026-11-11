import type { Access } from "../../auth/domain/access";
import { isSameOrigin, readJsonBody } from "../../shared/presentation/http";
import { toCollectionCreateCommand, toLinkSaveCommand } from "../application/commands";
import type { LibraryService } from "../application/library-service";
import { LibraryError, type LibraryErrorCode } from "../domain/library";
import {
  collectionCreateRequestSchema,
  linkSaveRequestSchema,
  toCollectionResponse,
  toLibraryReadResponse,
  toLinkSaveResponse,
  type ErrorCode,
  type ErrorResponse,
} from "./library-dto";

export type LibraryRequestContext = {
  access: Access;
  service: LibraryService;
  signOut(): Promise<void>;
};

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
  storage_unavailable: "storage_unavailable",
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function failure(code: ErrorCode, message = errorMessages[code], field?: string): Response {
  const body: ErrorResponse = { error: code, message, ...(field && { field }) };
  return json(errorStatus[code], body);
}

type Allowed = { service: LibraryService };
type Action = (allowed: Allowed, request: Request) => Promise<Response>;

export function createLibraryHandlers(context: (request: Request) => Promise<LibraryRequestContext>) {
  function handle(action: Action, { write }: { write: boolean }) {
    return async (request: Request): Promise<Response> => {
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
        return await action({ service: current.service }, request);
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
    postLink: handle(async ({ service }, request) => {
      const linkSaveRequest = await readRequest(request, (value) => linkSaveRequestSchema.parse(value));
      if (linkSaveRequest instanceof Response) return linkSaveRequest;
      const result = await service.saveLink(toLinkSaveCommand(linkSaveRequest));
      return json(result.kind === "added" ? 201 : 200, toLinkSaveResponse(result));
    }, { write: true }),
    postCollection: handle(async ({ service }, request) => {
      const collectionCreateRequest = await readRequest(request, (value) => collectionCreateRequestSchema.parse(value));
      if (collectionCreateRequest instanceof Response) return collectionCreateRequest;
      const collection = await service.createCollection(toCollectionCreateCommand(collectionCreateRequest.name));
      return json(201, toCollectionResponse(collection));
    }, { write: true }),
  };
}
