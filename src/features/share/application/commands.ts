import { LibraryError } from "../../library/domain/library";
import { parseLink, type SavedLink } from "../../wishlist/link";
import { ShareError, type ShareKey, type ShareKeyId, type ShareSecret } from "../domain/share-key";

export type ShareLinkAddCommand = { secret: ShareSecret; link: SavedLink };
// Only whether the link was new: a key never reads the library.
export type ShareLinkAddResult = { kind: "added" | "duplicate" };
// `replaces` is the active key the owner's screen showed, or null when it showed none.
export type ShareKeyIssueCommand = { replaces: ShareKeyId | null };
// The only time the secret leaves the database.
export type ShareKeyIssueResult = { key: ShareKey; secret: ShareSecret };
export type ShareKeyRevokeCommand = { keyId: ShareKeyId };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The share sheet gives a link and nothing else, so the owner's link rules apply with no option.
export function toShareLinkAddCommand(secret: ShareSecret, url: unknown): ShareLinkAddCommand {
  const parsed = parseLink(url, "");
  if (!parsed.ok) throw new ShareError("invalid_input", parsed.message);
  return { secret, link: parsed.link };
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
