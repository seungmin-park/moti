import type { Collection, Library } from "../domain/library";
import type { CollectionCreateCommand, LinkSaveCommand, LinkSaveResult, PictureViewCommand, PictureViewResult } from "./commands";

export interface LibraryStore {
  snapshot(): Promise<Library>;
  saveLink(command: LinkSaveCommand): Promise<LinkSaveResult>;
  createCollection(command: CollectionCreateCommand): Promise<Collection>;
  openPicture(command: PictureViewCommand): Promise<PictureViewResult>;
}
