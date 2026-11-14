import type {
  CollectionCreateCommand,
  CollectionRenameCommand,
  LibraryRestoreCommand,
  LinkSaveCommand,
  PictureViewCommand,
  ProductChangeCommand,
  ProductDeleteCommand,
} from "./commands";
import type { LibraryStore } from "./library-store";

export function createLibraryService(store: LibraryStore) {
  return {
    snapshot: () => store.snapshot(),
    saveLink: (command: LinkSaveCommand) => store.saveLink(command),
    createCollection: (command: CollectionCreateCommand) => store.createCollection(command),
    openPicture: (command: PictureViewCommand) => store.openPicture(command),
    changeProduct: (command: ProductChangeCommand) => store.changeProduct(command),
    deleteProduct: (command: ProductDeleteCommand) => store.deleteProduct(command),
    renameCollection: (command: CollectionRenameCommand) => store.renameCollection(command),
    exportLibrary: () => store.exportLibrary(),
    restoreLibrary: (command: LibraryRestoreCommand) => store.restoreLibrary(command),
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;
