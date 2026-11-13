import type { ShareKey } from "../domain/share-key";
import type {
  ShareKeyIssueCommand,
  ShareKeyIssueResult,
  ShareKeyRevokeCommand,
  ShareLinkAddCommand,
  ShareLinkAddResult,
} from "./commands";

export interface ShareLinkStore {
  // Adds the link to the library of the key's owner, or reports that it is already there.
  add(command: ShareLinkAddCommand): Promise<ShareLinkAddResult>;
}

// The owner's session: it sees each key's hint and times, never the secret's hash.
export interface ShareKeyStore {
  // The active key, else the latest revoked one, else null.
  read(): Promise<ShareKey | null>;
  // Revokes the key the command names (when it is still the active one) and makes a new one in one transaction.
  issue(command: ShareKeyIssueCommand): Promise<ShareKeyIssueResult>;
  revoke(command: ShareKeyRevokeCommand): Promise<ShareKey>;
}
