import type {
  LibraryCollection,
  LibrarySnapshot,
  SaveLinkCommand,
  SaveLinkResult,
} from "../domain";

export interface LibraryStore {
  snapshot(): Promise<LibrarySnapshot>;
  saveLink(command: SaveLinkCommand): Promise<SaveLinkResult>;
  createCollection(name: string): Promise<LibraryCollection>;
}
