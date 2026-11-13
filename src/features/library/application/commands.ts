import { parseCollectionName } from "../../wishlist/collection-name";
import { parseLink, type SavedLink } from "../../wishlist/link";
import {
  PAID_CURRENCIES,
  parseProductNote,
  parseProductTitle,
  parsePurchaseDate,
  type FieldResult,
} from "../../wishlist/product-fields";
import type { PictureObject } from "../../metadata/application/picture-copy";
import {
  LibraryError,
  type BackupProduct,
  type CollectionId,
  type Library,
  type LibraryBackup,
  type Money,
  type Product,
  type ProductId,
} from "../domain/library";

export type LinkSaveCommand = SavedLink & { collectionIds: CollectionId[] };
export type LinkSaveResult = { kind: "added" | "duplicate"; product: Product };
export type CollectionCreateCommand = { name: string };
export type PictureViewCommand = { productId: ProductId };
// A short-lived link to the product's current private copy, or nothing to show.
export type PictureViewResult = { kind: "found"; url: string } | { kind: "missing" };
// What the owner asks for. The store decides whether the product's state allows it and what changes.
export type ProductChange =
  | { type: "details"; title: string | null; note: string; collectionIds: CollectionId[] }
  | { type: "purchase" }
  | { type: "purchase.record"; date: string | null; price: Money | null }
  | { type: "wish" };
// `revision` is the one the owner's screen showed; a change made elsewhere since then is a conflict.
export type ProductChangeCommand = { productId: ProductId; revision: number; change: ProductChange };
export type ProductChangeInput = {
  revision: number;
  change:
    | { type: "details"; title: string | null; note: string; collectionIds: string[] }
    | { type: "purchase" }
    | { type: "purchase.record"; date: string | null; price: { amountMinor: number; currency: string } | null }
    | { type: "wish" };
};
export type CollectionRenameCommand = { collectionId: CollectionId; revision: number; name: string };
export type LibraryRestoreInput = {
  collections: { name: string; createdAt: string }[];
  products: {
    sourceUrl: string;
    option: string;
    collectedTitle: string;
    ownerTitle: string | null;
    note: string;
    collections: string[];
    addedAt: string;
    purchase:
      | { status: "wish" }
      | { status: "purchased"; date: string | null; price: { amountMinor: number; currency: string } | null };
    lastSuccessfulPrice: { amountMinor: number; currency: string; checkedAt: string } | null;
  }[];
};
export type LibraryRestoreCommand = { backup: LibraryBackup };
// The copies the replaced products showed. Their names come from SQL; nothing here builds one.
export type LibraryRestoreResult = { library: Library; replacedPictures: PictureObject[] };

// The revision columns are PostgreSQL integers; a larger value would reach the database and fail as an outage.
export const MAX_REVISION = 2147483647;
const MAX_COLLECTIONS = 100;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value);

function parseCollectionIds(input: unknown): CollectionId[] {
  if (!Array.isArray(input) || input.length > MAX_COLLECTIONS || !input.every(isUuid)) {
    throw new LibraryError("invalid_input", "컬렉션을 다시 선택해 주세요.", "collection");
  }
  return [...new Set(input.map((id) => id.toLowerCase()))] as CollectionId[];
}

function parseRevision(revision: unknown): number {
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISION) {
    throw new LibraryError("invalid_input", "화면을 새로고침한 뒤 다시 시도해 주세요.");
  }
  return revision;
}

function field<T>(result: FieldResult<T>): T {
  if (!result.ok) throw new LibraryError("invalid_input", result.message, result.field);
  return result.value;
}

export function toLinkSaveCommand(input: unknown): LinkSaveCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LibraryError("invalid_input", "링크 저장 입력을 확인해 주세요.");
  }
  const values = input as Record<string, unknown>;
  const parsed = parseLink(values.url, values.option);
  if (!parsed.ok) {
    throw new LibraryError("invalid_input", parsed.message, parsed.field);
  }
  return { ...parsed.link, collectionIds: parseCollectionIds(values.collectionIds) };
}

export function toCollectionCreateCommand(input: unknown): CollectionCreateCommand {
  const parsed = parseCollectionName(input);
  if (!parsed.ok) throw new LibraryError("invalid_input", parsed.message, "collection");
  return { name: parsed.name };
}

export function toPictureViewCommand(productId: unknown): PictureViewCommand {
  if (!isUuid(productId)) {
    throw new LibraryError("invalid_input", "상품을 다시 선택해 주세요.");
  }
  return { productId: productId.toLowerCase() as ProductId };
}

function toPaidPrice(price: { amountMinor: number; currency: string } | null): Money | null {
  if (price === null) return null;
  const { amountMinor, currency } = price;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !(PAID_CURRENCIES as readonly string[]).includes(currency)) {
    throw new LibraryError("invalid_input", "실구매가는 0 이상의 정수로 입력해 주세요.", "price");
  }
  return { amountMinor, currency };
}

function toProductChange(change: ProductChangeInput["change"], today: string): ProductChange {
  switch (change.type) {
    case "details":
      return {
        type: "details",
        title: change.title === null ? null : field(parseProductTitle(change.title)),
        note: field(parseProductNote(change.note)),
        collectionIds: parseCollectionIds(change.collectionIds),
      };
    case "purchase.record":
      return { type: "purchase.record", date: field(parsePurchaseDate(change.date, today)), price: toPaidPrice(change.price) };
    case "purchase":
    case "wish":
      return { type: change.type };
  }
}

// `today` is the server's Seoul calendar day: a purchase date after it is refused whatever the client's clock says.
export function toProductChangeCommand(productId: unknown, input: ProductChangeInput, today: string): ProductChangeCommand {
  const { productId: id } = toPictureViewCommand(productId);
  return { productId: id, revision: parseRevision(input.revision), change: toProductChange(input.change, today) };
}

export function toCollectionRenameCommand(collectionId: unknown, input: { revision: number; name: unknown }): CollectionRenameCommand {
  if (!isUuid(collectionId)) {
    throw new LibraryError("invalid_input", "컬렉션을 다시 선택해 주세요.", "collection");
  }
  const revision = parseRevision(input.revision);
  const { name } = toCollectionCreateCommand(input.name);
  return { collectionId: collectionId.toLowerCase() as CollectionId, revision, name };
}

// The file already passed the backup reader. Identity and shop come from the link the way a save derives them, so a
// file never carries an identity that disagrees with its link; purchase dates are checked against the server's day.
export function toLibraryRestoreCommand(input: LibraryRestoreInput, today: string): LibraryRestoreCommand {
  const products = input.products.map((product, index): BackupProduct => {
    const parsed = parseLink(product.sourceUrl, product.option);
    if (!parsed.ok) throw new LibraryError("invalid_input", parsed.message, `products.${index}.sourceUrl`);
    const { purchase } = product;
    let date: string | null = null;
    if (purchase.status === "purchased") {
      const checked = parsePurchaseDate(purchase.date, today);
      if (!checked.ok) throw new LibraryError("invalid_input", checked.message, `products.${index}.purchase.date`);
      date = checked.value;
    }
    return {
      ...parsed.link,
      collectedTitle: product.collectedTitle,
      ownerTitle: product.ownerTitle,
      note: product.note,
      collectionNames: [...product.collections],
      addedAt: product.addedAt,
      purchase: purchase.status === "wish"
        ? { status: "wish" }
        : { status: "purchased", date, price: purchase.price && { ...purchase.price } },
      lastSuccessfulPrice: product.lastSuccessfulPrice && { ...product.lastSuccessfulPrice },
    };
  });
  return { backup: { collections: input.collections.map(({ name, createdAt }) => ({ name, createdAt })), products } };
}
