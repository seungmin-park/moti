import type { Collection, Library } from "../domain/library";
import type { CollectionCreateCommand, LinkSaveCommand, LinkSaveResult } from "./commands";

export interface LibraryStore {
  snapshot(): Promise<Library>;
  saveLink(command: LinkSaveCommand): Promise<LinkSaveResult>;
  createCollection(command: CollectionCreateCommand): Promise<Collection>;
}
