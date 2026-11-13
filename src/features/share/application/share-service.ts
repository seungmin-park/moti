import type { ShareLinkAddCommand } from "./commands";
import type { ShareLinkStore } from "./share-store";

export function createShareLinkService(store: ShareLinkStore) {
  return {
    add: (command: ShareLinkAddCommand) => store.add(command),
  };
}

export type ShareLinkService = ReturnType<typeof createShareLinkService>;
