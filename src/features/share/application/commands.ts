import { parseLink, type SavedLink } from "../../wishlist/link";
import { ShareError, type ShareSecret } from "../domain/share-key";

export type ShareLinkAddCommand = { secret: ShareSecret; link: SavedLink };
// Only whether the link was new: a key never reads the library.
export type ShareLinkAddResult = { kind: "added" | "duplicate" };

// The share sheet gives a link and nothing else, so the owner's link rules apply with no option.
export function toShareLinkAddCommand(secret: ShareSecret, url: unknown): ShareLinkAddCommand {
  const parsed = parseLink(url, "");
  if (!parsed.ok) throw new ShareError("invalid_input", parsed.message);
  return { secret, link: parsed.link };
}
