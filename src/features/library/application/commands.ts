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
  if (typeof input !== "string" || !input.isWellFormed() || input.includes("\u0000")) {
    throw new LibraryError("invalid_input", "컬렉션 이름을 확인해 주세요.", "collection");
  }
  const name = input.trim().normalize("NFC");
  if (!name || [...name].length > 40) {
    throw new LibraryError("invalid_input", "컬렉션 이름은 1~40자로 입력해 주세요.", "collection");
  }
  return { name };
}
