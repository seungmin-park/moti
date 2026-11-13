import type { ShareKeyIssueCommand, ShareKeyRevokeCommand, ShareLinkAddCommand } from "./commands";
import type { ShareKeyStore, ShareLinkStore } from "./share-store";

export function createShareLinkService(store: ShareLinkStore) {
  return {
    add: (command: ShareLinkAddCommand) => store.add(command),
  };
}

export type ShareLinkService = ReturnType<typeof createShareLinkService>;

export function createShareKeyService(store: ShareKeyStore) {
  return {
    read: () => store.read(),
    issue: (command: ShareKeyIssueCommand) => store.issue(command),
    revoke: (command: ShareKeyRevokeCommand) => store.revoke(command),
  };
}

export type ShareKeyService = ReturnType<typeof createShareKeyService>;
