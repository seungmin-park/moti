import { z } from "zod";
import type { ShareLinkAddResult } from "../application/commands";

export const SHARE_LINKS_PATH = "/api/share/links";
// A link is at most 4,096 characters; the rest is room for JSON escapes, not for other fields.
export const MAX_SHARE_BYTES = 8 * 1024;

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
