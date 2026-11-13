import type { CollectionCreateCommand, LinkSaveCommand, PictureViewCommand } from "./commands";
import type { LibraryStore } from "./library-store";

export function createLibraryService(store: LibraryStore) {
  return {
    snapshot: () => store.snapshot(),
    saveLink: (command: LinkSaveCommand) => store.saveLink(command),
    createCollection: (command: CollectionCreateCommand) => store.createCollection(command),
    openPicture: (command: PictureViewCommand) => store.openPicture(command),
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;
