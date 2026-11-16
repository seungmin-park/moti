import { z } from "zod";
import type { ShareKeyIssueResult, ShareLinkAddResult } from "../application/commands";
import { PAGE_SNAPSHOT_LIMITS, PAGE_SNAPSHOT_META_KEYS, type PageSnapshot } from "../domain/page-snapshot";
import { SHARE_SECRET_PATTERN, type ShareKey } from "../domain/share-key";

export const SHARE_LINKS_PATH = "/api/share/links";
// A link is at most 4,096 characters; the rest is room for the shared text around it and JSON escapes, not for other
// fields. The text has its own cap in characters (readSharedText); Korean text (3 bytes a character in UTF-8) reaches
// this byte cap first, at about 2,700 characters.
export const MAX_SHARE_BYTES = 8 * 1024;
// A body that carries the Safari Shortcut's page snapshot: the 8 KiB above plus the snapshot (64 KiB as JSON) sent as
// JSON text, whose quotes and backslashes JSON escapes again, so at most twice its size.
export const MAX_SHARE_PAGE_BODY_BYTES = MAX_SHARE_BYTES + 2 * PAGE_SNAPSHOT_LIMITS.bytes;

// The head data the Safari Shortcut's script reads from the open page, with the script's own caps: only the meta keys
// the page reader reads, each value cut as the script cuts it.
export const sharePageSnapshotSchema = z.object({
  url: z.string().max(PAGE_SNAPSHOT_LIMITS.url),
  title: z.string().max(PAGE_SNAPSHOT_LIMITS.title),
  canonical: z.string().max(PAGE_SNAPSHOT_LIMITS.canonical),
  metas: z.array(z.tuple([z.enum(PAGE_SNAPSHOT_META_KEYS), z.string().max(PAGE_SNAPSHOT_LIMITS.metaContent)]))
    .max(PAGE_SNAPSHOT_LIMITS.metas),
  jsonLd: z.array(z.string().max(PAGE_SNAPSHOT_LIMITS.jsonLdBlock)).max(PAGE_SNAPSHOT_LIMITS.jsonLd),
}).strict();

// `url` keeps its name so existing Shortcuts keep working, but it may hold the shared text around a link. `page` is
// optional: the Safari Shortcut sends the script's result, as JSON text (what a Shortcut text field holds) or as an
// object.
export const shareLinkAddRequestSchema = z.object({
  url: z.string(),
  page: z.union([sharePageSnapshotSchema, z.string()]).optional(),
}).strict();
// What the route parses first: the same fields, with `page` checked afterwards so a wrong page only loses the page.
export const shareLinkAddEnvelopeSchema = z.object({ url: z.string(), page: z.unknown().optional() }).strict();
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

// The snapshot in its contract shape, or null when `page` is not one: wrong fields, a cap passed, or text that is not
// such JSON. The whole snapshot, as JSON, stays within PAGE_SNAPSHOT_LIMITS.bytes in UTF-8 either way.
export function toPageSnapshot(value: unknown): PageSnapshot | null {
  let candidate = value;
  if (typeof value === "string") {
    if (utf8Bytes(value) > PAGE_SNAPSHOT_LIMITS.bytes) return null;
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = sharePageSnapshotSchema.safeParse(candidate);
  if (!parsed.success || utf8Bytes(JSON.stringify(parsed.data)) > PAGE_SNAPSHOT_LIMITS.bytes) return null;
  return parsed.data;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

// A `page` that is not the script's snapshot (an edited or old script, another action's result) costs only the page:
// the link is saved, and a new product's answer tells the owner to paste the script again. A duplicate would not have
// used the page anyway, so its answer stays the same.
export const shareLinkPageUnreadMessage = "담았어요. 다만 페이지 정보는 읽지 못했어요. 단축어에 moti의 스크립트를 다시 붙여 넣어 주세요.";

export function toShareLinkAddResponse(result: ShareLinkAddResult, pageUnread = false): ShareLinkAddResponse {
  const message = result.kind === "added" && pageUnread ? shareLinkPageUnreadMessage : shareLinkMessages[result.kind];
  return { result: result.kind, message };
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
