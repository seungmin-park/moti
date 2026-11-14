import type { CollectionErrorCode, ImageErrorCode, PriceCheckCode } from "../../metadata/domain/collection-error";
import type { SavedLink } from "../../wishlist/link";

export type ProductId = string & { readonly __productId: unique symbol };
export type CollectionId = string & { readonly __collectionId: unique symbol };
export type Money = { amountMinor: number; currency: string };
export type Purchase =
  | { status: "wish" }
  | { status: "purchased"; date: string | null; price: Money | null };
// What this generation's run did with the page's picture. The shown picture can be an earlier generation's copy.
// `waiting`: the scheduled worker read the page, and only the owner's session can copy its picture.
export type ImageOutcome = { outcome: "copied" | "absent" | "waiting" } | { outcome: "failed"; errorCode: ImageErrorCode };
export type MetadataState = { generation: number; attempts: number } & (
  | { phase: "queued" | "running"; stalled: boolean }
  | { phase: "ready"; completedAt: string; image: ImageOutcome }
  | { phase: "failed"; errorCode: CollectionErrorCode }
);
// The last good private copy. `version` changes only when a newer copy replaces it.
export type Picture = { version: string };
// The latest daily price check. `code` says why it kept the previous price; null when it confirmed one or has not
// settled. A check newer than the last good price with a code means the shown price is an earlier one.
export type PriceCheck = { checkedAt: string; code: PriceCheckCode | null };
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
  priceCheck: PriceCheck | null;
  picture: Picture | null;
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
// What the owner can see or set, without the ids, revisions, jobs and picture copies the server keeps for itself.
// Membership is by collection name, which is unique per owner.
export type BackupCollection = { name: string; createdAt: string };
export type BackupProduct = SavedLink & {
  collectedTitle: string;
  ownerTitle: string | null;
  note: string;
  collectionNames: string[];
  addedAt: string;
  purchase: Purchase;
  lastSuccessfulPrice: (Money & { checkedAt: string }) | null;
};
export type LibraryBackup = { collections: BackupCollection[]; products: BackupProduct[] };
export type LibraryErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "collection_missing"
  | "collection_duplicate"
  | "identity_conflict"
  | "product_missing"
  | "metadata_not_retryable"
  | "revision_conflict"
  | "share_key_missing"
  | "worker_key_missing"
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
