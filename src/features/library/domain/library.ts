import type { CollectionErrorCode } from "../../metadata/domain/collection-error";
import type { SavedLink } from "../../wishlist/link";

export type ProductId = string & { readonly __productId: unique symbol };
export type CollectionId = string & { readonly __collectionId: unique symbol };
export type Money = { amountMinor: number; currency: string };
export type Purchase =
  | { status: "wish" }
  | { status: "purchased"; date: string | null; price: Money | null };
export type MetadataState = { generation: number; attempts: number } & (
  | { phase: "queued" | "running"; stalled: boolean }
  | { phase: "ready"; completedAt: string }
  | { phase: "failed"; errorCode: CollectionErrorCode }
);
export type Product = SavedLink & {
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
export type Collection = {
  id: CollectionId;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type Library = {
  products: Product[];
  collections: Collection[];
};
export type LibraryErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "collection_missing"
  | "collection_duplicate"
  | "identity_conflict"
  | "product_missing"
  | "metadata_not_retryable"
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
