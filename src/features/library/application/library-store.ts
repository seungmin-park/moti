import type { Collection, Library, Product } from "../domain/library";
import type {
  CollectionCreateCommand,
  CollectionRenameCommand,
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
}
