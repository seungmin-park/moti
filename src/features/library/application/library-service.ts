import type { CollectionCreateCommand, LinkSaveCommand } from "./commands";
import type { LibraryStore } from "./library-store";

export function createLibraryService(store: LibraryStore) {
  return {
    snapshot: () => store.snapshot(),
    saveLink: (command: LinkSaveCommand) => store.saveLink(command),
    createCollection: (command: CollectionCreateCommand) => store.createCollection(command),
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;
