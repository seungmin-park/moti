import {
  parseCollectionName,
  prepareSaveLink,
  type SaveLinkInput,
} from "../domain";
import type { LibraryStore } from "./library-store";

export function createLibraryService(store: LibraryStore) {
  return {
    snapshot: () => store.snapshot(),
    async saveLink(input: SaveLinkInput) {
      return store.saveLink(prepareSaveLink(input));
    },
    async createCollection(name: string) {
      return store.createCollection(parseCollectionName(name));
    },
  };
}
