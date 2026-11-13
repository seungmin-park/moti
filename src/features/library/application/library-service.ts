import type {
  CollectionCreateCommand,
  CollectionRenameCommand,
  LinkSaveCommand,
  PictureViewCommand,
  ProductChangeCommand,
} from "./commands";
import type { LibraryStore } from "./library-store";

export function createLibraryService(store: LibraryStore) {
  return {
    snapshot: () => store.snapshot(),
    saveLink: (command: LinkSaveCommand) => store.saveLink(command),
    createCollection: (command: CollectionCreateCommand) => store.createCollection(command),
    openPicture: (command: PictureViewCommand) => store.openPicture(command),
    changeProduct: (command: ProductChangeCommand) => store.changeProduct(command),
    renameCollection: (command: CollectionRenameCommand) => store.renameCollection(command),
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;
