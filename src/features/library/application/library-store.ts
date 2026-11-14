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
  ProductDeleteCommand,
  ProductDeleteResult,
} from "./commands";

export interface LibraryStore {
  snapshot(): Promise<Library>;
  saveLink(command: LinkSaveCommand): Promise<LinkSaveResult>;
  createCollection(command: CollectionCreateCommand): Promise<Collection>;
  openPicture(command: PictureViewCommand): Promise<PictureViewResult>;
  changeProduct(command: ProductChangeCommand): Promise<Product>;
  // Removes the product with its memberships and jobs. Its picture copy is left for the orphan sweep.
  deleteProduct(command: ProductDeleteCommand): Promise<ProductDeleteResult>;
  renameCollection(command: CollectionRenameCommand): Promise<Collection>;
  exportLibrary(): Promise<LibraryBackup>;
  // Replaces the owner's library with the backup in one transaction, or changes nothing.
  restoreLibrary(command: LibraryRestoreCommand): Promise<LibraryRestoreResult>;
}
