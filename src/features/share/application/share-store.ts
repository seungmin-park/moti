import type { ShareLinkAddCommand, ShareLinkAddResult } from "./commands";

export interface ShareLinkStore {
  // Adds the link to the library of the key's owner, or reports that it is already there.
  add(command: ShareLinkAddCommand): Promise<ShareLinkAddResult>;
}
