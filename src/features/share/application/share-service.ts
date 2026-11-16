import type { ShareKeyIssueCommand, ShareKeyRevokeCommand, ShareLinkAddCommand } from "./commands";
import type { ShareKeyStore, ShareLinkStore, SharedPage, SharedPageReader } from "./share-store";

// `readPage` turns the Safari Shortcut's snapshot into what a collection would have read. The read name becomes the
// product's first name (it outranks the shared text's), and the read page waits on the new product's first job.
export function createShareLinkService(store: ShareLinkStore, readPage: SharedPageReader) {
  function sharedPageOf({ page, link }: ShareLinkAddCommand): SharedPage | null {
    if (page === null) return null;
    try {
      return readPage(page, link.sourceUrl);
    } catch {
      // The snapshot is a hint: failing to read it never costs the link.
      return null;
    }
  }

  return {
    add(command: ShareLinkAddCommand) {
      const sharedPage = sharedPageOf(command);
      return store.add({ secret: command.secret, link: command.link, title: sharedPage?.title ?? command.title, sharedPage });
    },
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
