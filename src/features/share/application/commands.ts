import { LibraryError } from "../../library/domain/library";
import { parseLink, type SavedLink } from "../../wishlist/link";
import { ShareError, type ShareKey, type ShareKeyId, type ShareSecret } from "../domain/share-key";
import { readSharedText } from "../domain/shared-text";

// `title` is the shared text's name for the product, shown until collection reads the page's own.
export type ShareLinkAddCommand = { secret: ShareSecret; link: SavedLink; title: string | null };
// Only whether the link was new: a key never reads the library.
export type ShareLinkAddResult = { kind: "added" | "duplicate" };
// `replaces` is the active key the owner's screen showed, or null when it showed none.
export type ShareKeyIssueCommand = { replaces: ShareKeyId | null };
// The only time the secret leaves the database.
export type ShareKeyIssueResult = { key: ShareKey; secret: ShareSecret };
export type ShareKeyRevokeCommand = { keyId: ShareKeyId };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The request's url may be the shared text around a link. The link found in it meets the owner's link rules with no
// option.
export function toShareLinkAddCommand(secret: ShareSecret, url: unknown): ShareLinkAddCommand {
  const shared = typeof url === "string" ? readSharedText(url) : null;
  if (!shared) throw new ShareError("invalid_input", "상품 링크를 찾지 못했어요.");
  const parsed = parseLink(shared.url, "");
  if (!parsed.ok) throw new ShareError("invalid_input", parsed.message);
  return { secret, link: parsed.link, title: shared.title };
}

// The owner's key routes go through the library's gate, so their input errors are the library's.
function toShareKeyId(value: unknown): ShareKeyId {
  if (typeof value !== "string" || !uuid.test(value)) {
    throw new LibraryError("invalid_input", "화면을 새로고침한 뒤 다시 시도해 주세요.");
  }
  return value.toLowerCase() as ShareKeyId;
}

export function toShareKeyIssueCommand(input: { replaces: unknown }): ShareKeyIssueCommand {
  return { replaces: input.replaces === null ? null : toShareKeyId(input.replaces) };
}

export function toShareKeyRevokeCommand(keyId: unknown): ShareKeyRevokeCommand {
  return { keyId: toShareKeyId(keyId) };
}
