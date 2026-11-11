import { parseCollectionName } from "../../wishlist/collection-name";
import { parseLink, type SavedLink } from "../../wishlist/link";
import { LibraryError, type CollectionId, type Product } from "../domain/library";

export type LinkSaveCommand = SavedLink & { collectionIds: CollectionId[] };
export type LinkSaveResult = { kind: "added" | "duplicate"; product: Product };
export type CollectionCreateCommand = { name: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toLinkSaveCommand(input: unknown): LinkSaveCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LibraryError("invalid_input", "링크 저장 입력을 확인해 주세요.");
  }
  const values = input as Record<string, unknown>;
  const parsed = parseLink(values.url, values.option);
  if (!parsed.ok) {
    throw new LibraryError("invalid_input", parsed.message, parsed.field);
  }
  if (
    !Array.isArray(values.collectionIds) ||
    values.collectionIds.length > 100 ||
    !values.collectionIds.every((id): id is string => typeof id === "string" && uuid.test(id))
  ) {
    throw new LibraryError("invalid_input", "컬렉션을 다시 선택해 주세요.", "collection");
  }
  return {
    ...parsed.link,
    collectionIds: [...new Set(values.collectionIds.map((id) => id.toLowerCase()))] as CollectionId[],
  };
}

export function toCollectionCreateCommand(input: unknown): CollectionCreateCommand {
  const parsed = parseCollectionName(input);
  if (!parsed.ok) throw new LibraryError("invalid_input", parsed.message, "collection");
  return { name: parsed.name };
}
