import type { z } from "zod";
import { loginPath } from "../../auth/presentation/login-error";
import {
  collectionCreateResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveResponseSchema,
  metadataRetryResponseSchema,
  type CollectionCreateRequest,
  type CollectionCreateResponse,
  type ErrorCode,
  type ErrorResponse,
  type LibraryReadResponse,
  type LinkSaveRequest,
  type LinkSaveResponse,
  type MetadataRetryRequest,
  type MetadataRetryResponse,
} from "../presentation/library-dto";

export type FieldName = "url" | "option" | "collection";
export type ApiFailure =
  | { kind: "redirect"; to: string }
  | { kind: "invalid"; field: FieldName | null; message: string }
  | { kind: "stale"; message: string }
  | { kind: "unavailable"; message: string };
export type ApiOutcome<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };
export type Endpoint = "library.read" | "link.save" | "collection.create" | "metadata.retry";
export type LibraryApi = {
  read(): Promise<ApiOutcome<LibraryReadResponse>>;
  saveLink(body: LinkSaveRequest): Promise<ApiOutcome<LinkSaveResponse>>;
  createCollection(body: CollectionCreateRequest): Promise<ApiOutcome<CollectionCreateResponse>>;
  retryMetadata(productId: string, body: MetadataRetryRequest): Promise<ApiOutcome<MetadataRetryResponse>>;
};

const connection: ApiFailure = { kind: "unavailable", message: "연결을 확인하고 다시 시도해 주세요." };
const unavailable = (message: string) => (): ApiFailure => ({ kind: "unavailable", message });
const redirect = (to: string) => (): ApiFailure => ({ kind: "redirect", to });
const stale = (message: string) => (): ApiFailure => ({ kind: "stale", message });
const fieldNames: readonly string[] = ["url", "option", "collection"] satisfies FieldName[];
const knownField = (field: string | undefined): FieldName | null =>
  field !== undefined && fieldNames.includes(field) ? (field as FieldName) : null;

type Mapping = Record<ErrorCode, (error: ErrorResponse) => ApiFailure>;

const session = {
  signed_out: redirect(loginPath()),
  forbidden: redirect(loginPath("forbidden")),
  unconfigured: redirect(loginPath("unconfigured")),
};
const readFailed = unavailable("보관함을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.");
const retryLater = unavailable("잠시 뒤 다시 시도해 주세요.");
const reload = unavailable("화면을 새로고침한 뒤 다시 시도해 주세요.");

const failures: Record<Endpoint, Mapping> = {
  "library.read": {
    ...session,
    storage_unavailable: readFailed,
    cross_origin: readFailed,
    unsupported_media_type: readFailed,
    payload_too_large: readFailed,
    invalid_input: readFailed,
    collection_missing: readFailed,
    collection_duplicate: readFailed,
    identity_conflict: readFailed,
    product_missing: readFailed,
    metadata_not_retryable: readFailed,
    picture_missing: readFailed,
  },
  "link.save": {
    ...session,
    storage_unavailable: retryLater,
    cross_origin: reload,
    unsupported_media_type: retryLater,
    payload_too_large: () => ({ kind: "invalid", field: "url", message: "링크가 너무 길어요." }),
    invalid_input: (error) => {
      const field = knownField(error.field);
      return { kind: "invalid", field, message: field ? error.message : "입력을 확인해 주세요." };
    },
    collection_missing: stale("선택한 컬렉션을 찾을 수 없어요. 목록을 새로 불러왔어요."),
    collection_duplicate: retryLater,
    identity_conflict: unavailable("같은 링크를 확인하지 못했어요. 다시 시도해 주세요."),
    product_missing: retryLater,
    metadata_not_retryable: retryLater,
    picture_missing: retryLater,
  },
  "collection.create": {
    ...session,
    storage_unavailable: retryLater,
    cross_origin: reload,
    unsupported_media_type: retryLater,
    payload_too_large: () => ({ kind: "invalid", field: "collection", message: "컬렉션 이름이 너무 길어요." }),
    invalid_input: (error) => ({
      kind: "invalid",
      field: "collection",
      message: knownField(error.field) ? error.message : "입력을 확인해 주세요.",
    }),
    collection_missing: retryLater,
    collection_duplicate: stale("같은 이름의 컬렉션이 이미 있어요."),
    identity_conflict: retryLater,
    product_missing: retryLater,
    metadata_not_retryable: retryLater,
    picture_missing: retryLater,
  },
  "metadata.retry": {
    ...session,
    storage_unavailable: retryLater,
    cross_origin: reload,
    unsupported_media_type: retryLater,
    payload_too_large: retryLater,
    invalid_input: reload,
    collection_missing: retryLater,
    collection_duplicate: retryLater,
    identity_conflict: retryLater,
    product_missing: stale("상품을 찾을 수 없어요. 목록을 새로 불러왔어요."),
    metadata_not_retryable: stale("상품 상태가 바뀌었어요. 목록을 새로 불러왔어요."),
    picture_missing: retryLater,
  },
};

export function toApiFailure(endpoint: Endpoint, status: number, body: unknown): ApiFailure {
  const error = errorResponseSchema.safeParse(body);
  if (error.success) return failures[endpoint][error.data.error](error.data);
  return status === 401 ? session.signed_out() : connection;
}

type Success<T> = { status: number; parse: (body: unknown) => T | null };

export function createLibraryApi(fetcher: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 15_000): LibraryApi {
  async function request<T>(endpoint: Endpoint, path: string, init: RequestInit, success: Success<T>[]): Promise<ApiOutcome<T>> {
    try {
      const response = await fetcher(path, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) return { ok: false, failure: toApiFailure(endpoint, response.status, body) };
      const value = success.find((expected) => expected.status === response.status)?.parse(body) ?? null;
      return value === null ? { ok: false, failure: connection } : { ok: true, value };
    } catch {
      return { ok: false, failure: connection };
    }
  }

  const post = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = <T>(schema: z.ZodType<T>) => (body: unknown): T | null => {
    const result = schema.safeParse(body);
    return result.success ? result.data : null;
  };
  const savedAs = (kind: LinkSaveResponse["kind"]) => (body: unknown) => {
    const value = parsed(linkSaveResponseSchema)(body);
    return value?.kind === kind ? value : null;
  };

  return {
    read: () => request("library.read", "/api/library", { method: "GET", headers: { accept: "application/json" } }, [
      { status: 200, parse: parsed(libraryReadResponseSchema) },
    ]),
    saveLink: (body) => request("link.save", "/api/links", post(body), [
      { status: 201, parse: savedAs("added") },
      { status: 200, parse: savedAs("duplicate") },
    ]),
    createCollection: (body) => request("collection.create", "/api/collections", post(body), [
      { status: 201, parse: parsed(collectionCreateResponseSchema) },
    ]),
    retryMetadata: (productId, body) => request("metadata.retry", `/api/products/${encodeURIComponent(productId)}/metadata`, post(body), [
      { status: 202, parse: parsed(metadataRetryResponseSchema) },
    ]),
  };
}
