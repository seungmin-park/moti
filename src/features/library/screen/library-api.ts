import type { z } from "zod";
import { loginPath } from "../../auth/presentation/login-error";
import { MAX_BACKUP_BYTES, backupFileName, readLibraryBackup, type BackupCounts } from "../presentation/library-backup";
import {
  collectionCreateResponseSchema,
  collectionRenameResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveResponseSchema,
  metadataRetryResponseSchema,
  metadataWakeResponseSchema,
  productChangeResponseSchema,
  type CollectionCreateRequest,
  type CollectionCreateResponse,
  type CollectionRenameRequest,
  type CollectionRenameResponse,
  type ErrorCode,
  type ErrorResponse,
  type LibraryReadResponse,
  type LinkSaveRequest,
  type LinkSaveResponse,
  type MetadataRetryRequest,
  type MetadataRetryResponse,
  type MetadataWakeResponse,
  type ProductChangeRequest,
  type ProductChangeResponse,
} from "../presentation/library-dto";

export type FieldName = "url" | "option" | "collection" | "title" | "note" | "date" | "price";
export type ApiFailure =
  | { kind: "redirect"; to: string }
  | { kind: "invalid"; field: FieldName | null; message: string }
  | { kind: "stale"; message: string }
  | { kind: "unavailable"; message: string };
export type ApiOutcome<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };
export type Endpoint =
  | "library.read"
  | "link.save"
  | "collection.create"
  | "collection.rename"
  | "metadata.retry"
  | "metadata.wake"
  | "product.change"
  | "library.backup"
  | "library.restore";
// A backup the server made and the reader accepted, kept as the exact text the owner downloads.
export type BackupFile = { name: string; text: string; counts: BackupCounts; restorable: boolean };
export type LibraryApi = {
  read(): Promise<ApiOutcome<LibraryReadResponse>>;
  saveLink(body: LinkSaveRequest): Promise<ApiOutcome<LinkSaveResponse>>;
  createCollection(body: CollectionCreateRequest): Promise<ApiOutcome<CollectionCreateResponse>>;
  renameCollection(collectionId: string, body: CollectionRenameRequest): Promise<ApiOutcome<CollectionRenameResponse>>;
  retryMetadata(productId: string, body: MetadataRetryRequest): Promise<ApiOutcome<MetadataRetryResponse>>;
  changeProduct(productId: string, body: ProductChangeRequest): Promise<ApiOutcome<ProductChangeResponse>>;
  exportBackup(): Promise<ApiOutcome<BackupFile>>;
  // Sends the chosen file's text unchanged, so the server checks exactly what the screen checked.
  restore(text: string): Promise<ApiOutcome<LibraryReadResponse>>;
  wake(): Promise<ApiOutcome<MetadataWakeResponse>>;
};

const connection: ApiFailure = { kind: "unavailable", message: "연결을 확인하고 다시 시도해 주세요." };
const unavailable = (message: string) => (): ApiFailure => ({ kind: "unavailable", message });
const redirect = (to: string) => (): ApiFailure => ({ kind: "redirect", to });
const stale = (message: string) => (): ApiFailure => ({ kind: "stale", message });
// A field the endpoint's form has; any other field name from the server is shown as a form-level error.
const invalidIn = (fields: readonly FieldName[], fallback: string) => (error: ErrorResponse): ApiFailure => {
  const field = fields.find((name) => name === error.field) ?? null;
  return { kind: "invalid", field, message: field ? error.message : fallback };
};

type Mapping = Record<ErrorCode, (error: ErrorResponse) => ApiFailure>;

const session = {
  signed_out: redirect(loginPath()),
  forbidden: redirect(loginPath("forbidden")),
  unconfigured: redirect(loginPath("unconfigured")),
};
const readFailed = unavailable("보관함을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.");
const retryLater = unavailable("잠시 뒤 다시 시도해 주세요.");
const reload = unavailable("화면을 새로고침한 뒤 다시 시도해 주세요.");
const changedElsewhere = stale("다른 곳에서 먼저 바뀌었어요. 최신 내용을 불러왔어요. 확인 후 다시 저장해 주세요.");
const backupFailed = unavailable("백업을 만들지 못했어요. 잠시 뒤 다시 시도해 주세요.");
// The server refused before or inside the rolled-back transaction, so the library is known to be unchanged.
const unchanged = (message: string) => (): ApiFailure => ({ kind: "invalid", field: null, message: `${message} 보관함은 바뀌지 않았어요.` });
// A commit can precede a lost answer, so the screen re-reads instead of saying nothing changed.
const restoreUnknown = unavailable("복원을 마쳤는지 확인하지 못했어요.");

const readFailures: Mapping = {
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
  revision_conflict: readFailed,
  picture_missing: readFailed,
  share_key_missing: readFailed,
};

const failures: Record<Endpoint, Mapping> = {
  // The screen shows nothing when a wake fails: the library it read is still right, and the retry button remains.
  "metadata.wake": readFailures,
  "library.read": readFailures,
  "link.save": {
    ...session,
    storage_unavailable: retryLater,
    cross_origin: reload,
    unsupported_media_type: retryLater,
    payload_too_large: () => ({ kind: "invalid", field: "url", message: "링크가 너무 길어요." }),
    invalid_input: invalidIn(["url", "option", "collection"], "입력을 확인해 주세요."),
    collection_missing: stale("선택한 컬렉션을 찾을 수 없어요. 목록을 새로 불러왔어요."),
    collection_duplicate: retryLater,
    identity_conflict: unavailable("같은 링크를 확인하지 못했어요. 다시 시도해 주세요."),
    product_missing: retryLater,
    metadata_not_retryable: retryLater,
    revision_conflict: retryLater,
    picture_missing: retryLater,
    share_key_missing: retryLater,
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
      message: error.field === "collection" ? error.message : "입력을 확인해 주세요.",
    }),
    collection_missing: retryLater,
    collection_duplicate: stale("같은 이름의 컬렉션이 이미 있어요."),
    identity_conflict: retryLater,
    product_missing: retryLater,
    metadata_not_retryable: retryLater,
    revision_conflict: retryLater,
    picture_missing: retryLater,
    share_key_missing: retryLater,
  },
  "collection.rename": {
    ...session,
    storage_unavailable: retryLater,
    cross_origin: reload,
    unsupported_media_type: retryLater,
    payload_too_large: () => ({ kind: "invalid", field: "collection", message: "컬렉션 이름이 너무 길어요." }),
    invalid_input: (error) => ({
      kind: "invalid",
      field: "collection",
      message: error.field === "collection" ? error.message : "입력을 확인해 주세요.",
    }),
    collection_missing: stale("컬렉션을 찾을 수 없어요. 목록을 새로 불러왔어요."),
    collection_duplicate: stale("같은 이름의 컬렉션이 이미 있어요."),
    identity_conflict: retryLater,
    product_missing: retryLater,
    metadata_not_retryable: retryLater,
    revision_conflict: changedElsewhere,
    picture_missing: retryLater,
    share_key_missing: retryLater,
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
    revision_conflict: retryLater,
    picture_missing: retryLater,
    share_key_missing: retryLater,
  },
  "product.change": {
    ...session,
    storage_unavailable: retryLater,
    cross_origin: reload,
    unsupported_media_type: retryLater,
    payload_too_large: () => ({ kind: "invalid", field: "note", message: "메모가 너무 길어요." }),
    invalid_input: invalidIn(["title", "note", "collection", "date", "price"], "화면을 새로고침한 뒤 다시 시도해 주세요."),
    collection_missing: stale("선택한 컬렉션을 찾을 수 없어요. 목록을 새로 불러왔어요."),
    collection_duplicate: retryLater,
    identity_conflict: retryLater,
    product_missing: stale("상품을 찾을 수 없어요. 목록을 새로 불러왔어요."),
    metadata_not_retryable: retryLater,
    revision_conflict: changedElsewhere,
    picture_missing: retryLater,
    share_key_missing: retryLater,
  },
  "library.backup": {
    ...session,
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
    ...session,
    storage_unavailable: restoreUnknown,
    cross_origin: unchanged("화면을 새로고침한 뒤 다시 시도해 주세요."),
    unsupported_media_type: unchanged("복원 요청을 보내지 못했어요."),
    payload_too_large: unchanged("4MB보다 큰 백업은 한 번에 복원할 수 없어요."),
    invalid_input: (error) => unchanged(error.message)(),
    collection_missing: restoreUnknown,
    collection_duplicate: restoreUnknown,
    identity_conflict: restoreUnknown,
    product_missing: restoreUnknown,
    metadata_not_retryable: restoreUnknown,
    revision_conflict: restoreUnknown,
    picture_missing: restoreUnknown,
    share_key_missing: restoreUnknown,
  },
};

export function toApiFailure(endpoint: Endpoint, status: number, body: unknown): ApiFailure {
  const error = errorResponseSchema.safeParse(body);
  if (error.success) return failures[endpoint][error.data.error](error.data);
  return status === 401 ? session.signed_out() : connection;
}

type Success<T> = { status: number; parse: (body: unknown) => T | null };

// A large restore runs one transaction and the route allows 60 s; every other request gives up after 15 s.
const RESTORE_TIMEOUT_MS = 60_000;

export function createLibraryApi(fetcher: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 15_000): LibraryApi {
  async function request<T>(
    endpoint: Endpoint, path: string, init: RequestInit, success: Success<T>[], timeout = timeoutMs,
  ): Promise<ApiOutcome<T>> {
    try {
      const response = await fetcher(path, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeout) });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) return { ok: false, failure: toApiFailure(endpoint, response.status, body) };
      const value = success.find((expected) => expected.status === response.status)?.parse(body) ?? null;
      return value === null ? { ok: false, failure: connection } : { ok: true, value };
    } catch {
      return { ok: false, failure: connection };
    }
  }

  const write = (method: "POST" | "PATCH", body: unknown): RequestInit => ({
    method,
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
  const segment = encodeURIComponent;

  return {
    read: () => request("library.read", "/api/library", { method: "GET", headers: { accept: "application/json" } }, [
      { status: 200, parse: parsed(libraryReadResponseSchema) },
    ]),
    saveLink: (body) => request("link.save", "/api/links", write("POST", body), [
      { status: 201, parse: savedAs("added") },
      { status: 200, parse: savedAs("duplicate") },
    ]),
    createCollection: (body) => request("collection.create", "/api/collections", write("POST", body), [
      { status: 201, parse: parsed(collectionCreateResponseSchema) },
    ]),
    renameCollection: (collectionId, body) => request("collection.rename", `/api/collections/${segment(collectionId)}`, write("PATCH", body), [
      { status: 200, parse: parsed(collectionRenameResponseSchema) },
    ]),
    retryMetadata: (productId, body) => request("metadata.retry", `/api/products/${segment(productId)}/metadata`, write("POST", body), [
      { status: 202, parse: parsed(metadataRetryResponseSchema) },
    ]),
    changeProduct: (productId, body) => request("product.change", `/api/products/${segment(productId)}`, write("PATCH", body), [
      { status: 200, parse: parsed(productChangeResponseSchema) },
    ]),
    async exportBackup() {
      try {
        const response = await fetcher("/api/library/backup", {
          method: "GET", headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
        if (!response.ok) return { ok: false, failure: toApiFailure("library.backup", response.status, body) };
        const reading = readLibraryBackup(body);
        if (!reading.ok) return { ok: false, failure: backupFailed() };
        return {
          ok: true,
          value: {
            name: backupFileName(new Date(reading.document.exportedAt)),
            text,
            counts: reading.counts,
            restorable: new TextEncoder().encode(text).byteLength <= MAX_BACKUP_BYTES,
          },
        };
      } catch {
        return { ok: false, failure: connection };
      }
    },
    restore: (text) => request("library.restore", "/api/library/restore", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: text,
    }, [{ status: 200, parse: parsed(libraryReadResponseSchema) }], RESTORE_TIMEOUT_MS),
    wake: () => request("metadata.wake", "/api/library/metadata", write("POST", {}), [
      { status: 202, parse: parsed(metadataWakeResponseSchema) },
    ]),
  };
}
