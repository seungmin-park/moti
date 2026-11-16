import type { CollectedPage } from "../../metadata/application/collection";
import type { SavedLink } from "../../wishlist/link";
import type { PageSnapshot } from "../domain/page-snapshot";
import type { ShareKey, ShareSecret } from "../domain/share-key";
import type {
  ShareKeyIssueCommand,
  ShareKeyIssueResult,
  ShareKeyRevokeCommand,
  ShareLinkAddResult,
} from "./commands";

// What the Safari Shortcut's page snapshot yields, decided by the collection's own rules: a name, the page's one price
// or none, and the picture's address. The server still fetches the picture itself, later, as for a page it read.
export type SharedPage = CollectedPage;
// Reads a snapshot as the collection reads a fetched page. Null when the snapshot is not of the shared link's host or
// names no product: the add then goes on as without one.
export type SharedPageReader = (page: PageSnapshot, sourceUrl: string) => SharedPage | null;

// What the key adds. `sharedPage` waits on the new product's first job for the owner's next collection; a duplicate
// never takes it.
export type ShareLinkEntry = { secret: ShareSecret; link: SavedLink; title: string | null; sharedPage: SharedPage | null };

export interface ShareLinkStore {
  // Adds the link to the library of the key's owner, or reports that it is already there.
  add(entry: ShareLinkEntry): Promise<ShareLinkAddResult>;
}

// The owner's session: it sees each key's hint and times, never the secret's hash.
export interface ShareKeyStore {
  // The active key, else the latest revoked one, else null.
  read(): Promise<ShareKey | null>;
  // Revokes the key the command names (when it is still the active one) and makes a new one in one transaction.
  issue(command: ShareKeyIssueCommand): Promise<ShareKeyIssueResult>;
  revoke(command: ShareKeyRevokeCommand): Promise<ShareKey>;
}
