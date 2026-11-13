import type { Collection, Library, LibraryBackup, Product } from "../domain/library";
import type {
  CollectionCreateCommand,
  CollectionRenameCommand,
  LibraryRestoreCommand,
  LibraryRestoreResult,
  LinkSaveCommand,
  LinkSaveResult,
  PictureViewCommand,
  PictureViewResult,
  ProductChangeCommand,
} from "./commands";

export interface LibraryStore {
  snapshot(): Promise<Library>;
  saveLink(command: LinkSaveCommand): Promise<LinkSaveResult>;
  createCollection(command: CollectionCreateCommand): Promise<Collection>;
  openPicture(command: PictureViewCommand): Promise<PictureViewResult>;
  changeProduct(command: ProductChangeCommand): Promise<Product>;
  renameCollection(command: CollectionRenameCommand): Promise<Collection>;
  exportLibrary(): Promise<LibraryBackup>;
  // Replaces the owner's library with the backup in one transaction, or changes nothing.
  restoreLibrary(command: LibraryRestoreCommand): Promise<LibraryRestoreResult>;
}
