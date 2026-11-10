import { parseLink, type SavedLink } from "../wishlist/link";

export type ProductId = string & { readonly __productId: unique symbol };
export type CollectionId = string & { readonly __collectionId: unique symbol };
export type Money = { amountMinor: number; currency: string };
export type Purchase =
  | { status: "wish" }
  | { status: "purchased"; date: string | null; price: Money | null };
export type MetadataState = { generation: number; attempts: number } & (
  | { phase: "queued" | "running" }
  | { phase: "ready"; completedAt: string }
  | { phase: "failed"; errorCode: string }
);
export type LibraryProduct = SavedLink & {
  id: ProductId;
  revision: number;
  title: string;
  note: string;
  collectionIds: CollectionId[];
  addedAt: string;
  updatedAt: string;
  purchase: Purchase;
  metadata: MetadataState;
  lastSuccessfulPrice: (Money & { checkedAt: string }) | null;
};
export type LibraryCollection = {
  id: CollectionId;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type LibrarySnapshot = {
  products: LibraryProduct[];
  collections: LibraryCollection[];
};
export type SaveLinkInput = {
  url: string;
  option: string;
  collectionIds: readonly string[];
};
export type SaveLinkCommand = SavedLink & { collectionIds: CollectionId[] };
export type SaveLinkResult = {
  kind: "added" | "duplicate";
  product: LibraryProduct;
};
export type LibraryErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "collection_missing"
  | "collection_duplicate"
  | "identity_conflict"
  | "storage_unavailable";

export class LibraryError extends Error {
  constructor(
    readonly code: LibraryErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

export function prepareSaveLink(input: unknown): SaveLinkCommand {
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
    !values.collectionIds.every(
      (id): id is string =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    )
  ) {
    throw new LibraryError("invalid_input", "컬렉션을 다시 선택해 주세요.", "collection");
  }
  return {
    ...parsed.link,
    collectionIds: [...new Set(values.collectionIds.map((id) => id.toLowerCase()))] as CollectionId[],
  };
}

export function parseCollectionName(input: unknown): string {
  if (typeof input !== "string" || !input.isWellFormed() || input.includes("\u0000")) {
    throw new LibraryError("invalid_input", "컬렉션 이름을 확인해 주세요.", "collection");
  }
  const name = input.trim().normalize("NFC");
  if (!name || [...name].length > 40) {
    throw new LibraryError("invalid_input", "컬렉션 이름은 1~40자로 입력해 주세요.", "collection");
  }
  return name;
}
