import { z } from "zod";
import type { ShareKeyIssueResult, ShareLinkAddResult } from "../application/commands";
import { SHARE_SECRET_PATTERN, type ShareKey } from "../domain/share-key";

export const SHARE_LINKS_PATH = "/api/share/links";
// A link is at most 4,096 characters; the rest is room for the shared text around it and JSON escapes, not for other
// fields. The text has its own cap in characters (readSharedText).
export const MAX_SHARE_BYTES = 8 * 1024;

// `url` keeps its name so existing Shortcuts keep working, but it may hold the shared text around a link.
export const shareLinkAddRequestSchema = z.object({ url: z.string() }).strict();
export const shareLinkAddResponseSchema = z.object({
  result: z.enum(["added", "duplicate"]),
  message: z.string().min(1),
}).strict();

export const shareLinkErrorCodes = [
  "share_key_rejected",
  "share_key_busy",
  "invalid_link",
  "identity_conflict",
  "unsupported_media_type",
  "payload_too_large",
  "unconfigured",
  "unavailable",
] as const;
export type ShareLinkErrorCode = (typeof shareLinkErrorCodes)[number];
export const shareLinkErrorResponseSchema = z.object({
  error: z.enum(shareLinkErrorCodes),
  message: z.string().min(1),
}).strict();

export type ShareLinkAddRequest = z.infer<typeof shareLinkAddRequestSchema>;
export type ShareLinkAddResponse = z.infer<typeof shareLinkAddResponseSchema>;
export type ShareLinkErrorResponse = z.infer<typeof shareLinkErrorResponseSchema>;

// What the Shortcut shows in its notification, whatever the status.
export const shareLinkMessages: Record<ShareLinkAddResponse["result"] | ShareLinkErrorCode, string> = {
  added: "위시에 담았어요. 상품 정보는 moti를 열면 가져와요.",
  duplicate: "이미 담아둔 상품이에요.",
  invalid_link: "상품 링크를 찾지 못했어요. 상품 페이지에서 다시 공유해 주세요.",
  share_key_rejected: "저장 키가 맞지 않거나 폐기됐어요. moti의 공유 저장 화면에서 새 키를 만들어 단축어에 넣어 주세요.",
  share_key_busy: "한 시간에 30번까지 담을 수 있어요. 잠시 뒤 다시 공유해 주세요.",
  unsupported_media_type: "단축어 설정을 확인해 주세요. 본문은 url 하나를 담은 JSON이에요.",
  payload_too_large: "공유한 내용이 너무 길어요.",
  identity_conflict: "같은 링크를 확인하지 못했어요. 다시 공유해 주세요.",
  unconfigured: "지금은 moti에 담지 못했어요. 잠시 뒤 다시 공유해 주세요.",
  unavailable: "지금은 moti에 담지 못했어요. 잠시 뒤 다시 공유해 주세요.",
};

export function toShareLinkAddResponse(result: ShareLinkAddResult): ShareLinkAddResponse {
  return { result: result.kind, message: shareLinkMessages[result.kind] };
}

const timestamp = z.iso.datetime();

// The owner's view of a key: its last four characters and times, never the secret or its hash.
export const shareKeyResponseSchema = z.object({
  id: z.uuid(),
  hint: z.string().regex(/^[A-Za-z0-9_-]{4}$/),
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
}).strict();
export const shareKeyReadResponseSchema = z.object({ key: shareKeyResponseSchema.nullable() }).strict();
// `replaces` is the active key the screen showed, or null when it showed none.
export const shareKeyIssueRequestSchema = z.object({ replaces: z.string().nullable() }).strict();
export const shareKeyIssueResponseSchema = z.object({
  key: shareKeyResponseSchema,
  secret: z.string().regex(SHARE_SECRET_PATTERN),
}).strict();
export const shareKeyRevokeResponseSchema = z.object({ key: shareKeyResponseSchema }).strict();

export type ShareKeyResponse = z.infer<typeof shareKeyResponseSchema>;
export type ShareKeyReadResponse = z.infer<typeof shareKeyReadResponseSchema>;
export type ShareKeyIssueRequest = z.infer<typeof shareKeyIssueRequestSchema>;
export type ShareKeyIssueResponse = z.infer<typeof shareKeyIssueResponseSchema>;
export type ShareKeyRevokeResponse = z.infer<typeof shareKeyRevokeResponseSchema>;

export function toShareKeyResponse(key: ShareKey): ShareKeyResponse {
  return { id: key.id, hint: key.hint, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt, revokedAt: key.revokedAt };
}

export function toShareKeyReadResponse(key: ShareKey | null): ShareKeyReadResponse {
  return { key: key && toShareKeyResponse(key) };
}

export function toShareKeyIssueResponse(result: ShareKeyIssueResult): ShareKeyIssueResponse {
  return { key: toShareKeyResponse(result.key), secret: result.secret };
}

export function toShareKeyRevokeResponse(key: ShareKey): ShareKeyRevokeResponse {
  return { key: toShareKeyResponse(key) };
}
