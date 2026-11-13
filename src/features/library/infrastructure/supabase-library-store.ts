import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { collectionErrorCodes, imageErrorCodes } from "../../metadata/domain/collection-error";
import type { LibraryRestoreCommand, ProductChange } from "../application/commands";
import type { LibraryStore } from "../application/library-store";
import { PICTURE_BUCKET, PICTURE_LINK_SECONDS, pictureObjectSchema } from "./product-pictures";
import {
  LibraryError,
  type BackupProduct,
  type Collection,
  type CollectionId,
  type ImageOutcome,
  type Library,
  type LibraryErrorCode,
  type MetadataState,
  type Money,
  type Product,
  type ProductId,
  type Purchase,
} from "../domain/library";

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = count.min(1);
const money = count.nullable();
const currency = z.string().regex(/^[A-Z]{3}$/).nullable();
const collectionRowSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  revision,
  created_at: timestamp,
  updated_at: timestamp,
});
const purchaseColumns = {
  purchase_status: z.enum(["wish", "purchased"]),
  purchased_on: z.iso.date().nullable(),
  purchased_amount_minor: money,
  purchased_currency: currency,
};
const lastSuccessColumns = {
  last_success_amount_minor: money,
  last_success_currency: currency,
  last_success_at: timestamp.nullable(),
};
type PurchaseColumns = { [Key in keyof typeof purchaseColumns]: z.infer<(typeof purchaseColumns)[Key]> };
type LastSuccessColumns = { [Key in keyof typeof lastSuccessColumns]: z.infer<(typeof lastSuccessColumns)[Key]> };

function hasConsistentPurchase(row: PurchaseColumns): boolean {
  return row.purchase_status === "wish"
    ? row.purchased_on === null && row.purchased_amount_minor === null && row.purchased_currency === null
    : (row.purchased_amount_minor === null) === (row.purchased_currency === null);
}

function hasConsistentLastSuccess(row: LastSuccessColumns): boolean {
  return (row.last_success_amount_minor === null) === (row.last_success_currency === null) &&
    (row.last_success_amount_minor === null) === (row.last_success_at === null);
}

export const productRowSchema = z.object({
  id: z.uuid(),
  source_url: z.string(),
  identity_url: z.string(),
  option: z.string(),
  shop: z.string(),
  title: z.string(),
  note: z.string(),
  revision,
  collection_ids: z.array(z.uuid()),
  created_at: timestamp,
  updated_at: timestamp,
  ...purchaseColumns,
  metadata_phase: z.enum(["queued", "running", "ready", "failed"]),
  metadata_generation: revision,
  metadata_attempts: count,
  metadata_error_code: z.enum(collectionErrorCodes).nullable(),
  metadata_stalled: z.boolean(),
  metadata_completed_at: timestamp.nullable(),
  metadata_image: z.enum(["copied", "absent", "failed", "waiting"]).nullable(),
  metadata_image_error_code: z.enum(imageErrorCodes).nullable(),
  ...lastSuccessColumns,
  picture_version: z.uuid().nullable(),
}).refine((row) => {
  const metadataConsistent =
    row.metadata_phase === "ready"
      ? row.metadata_completed_at !== null && row.metadata_error_code === null
      : row.metadata_phase === "failed"
        ? row.metadata_error_code !== null && row.metadata_completed_at === null
        : row.metadata_error_code === null && row.metadata_completed_at === null;
  const imageConsistent = (row.metadata_phase === "ready") === (row.metadata_image !== null) &&
    (row.metadata_image === "failed") === (row.metadata_image_error_code !== null);
  return hasConsistentPurchase(row) && hasConsistentLastSuccess(row) && metadataConsistent && imageConsistent;
});

const libraryRowSchema = z.object({
  products: z.array(productRowSchema),
  collections: z.array(collectionRowSchema),
});

// What moti_backup returns: the collected and the owner's names apart, and membership as collection names.
const backupCollectionRowSchema = z.object({ name: z.string().min(1), created_at: timestamp });
const backupProductRowSchema = z.object({
  source_url: z.string(),
  identity_url: z.string(),
  option: z.string(),
  shop: z.string(),
  title: z.string(),
  owner_title: z.string().nullable(),
  note: z.string(),
  collection_names: z.array(z.string()),
  created_at: timestamp,
  ...purchaseColumns,
  ...lastSuccessColumns,
}).refine((row) => hasConsistentPurchase(row) && hasConsistentLastSuccess(row));
const backupRowSchema = z.object({
  collections: z.array(backupCollectionRowSchema),
  products: z.array(backupProductRowSchema),
});

type CollectionRow = z.infer<typeof collectionRowSchema>;
type LibraryRow = z.infer<typeof libraryRowSchema>;
export type ProductRow = z.infer<typeof productRowSchema>;
type BackupProductRow = z.infer<typeof backupProductRowSchema>;

function toCollection(row: CollectionRow): Collection {
  return {
    id: row.id as CollectionId,
    name: row.name,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPurchase(row: PurchaseColumns): Purchase {
  if (row.purchase_status === "wish") return { status: "wish" };
  const price: Money | null = row.purchased_amount_minor === null
    ? null
    : { amountMinor: row.purchased_amount_minor, currency: row.purchased_currency! };
  return { status: "purchased", date: row.purchased_on, price };
}

function toLastSuccessfulPrice(row: LastSuccessColumns): (Money & { checkedAt: string }) | null {
  return row.last_success_amount_minor === null ? null : {
    amountMinor: row.last_success_amount_minor,
    currency: row.last_success_currency!,
    checkedAt: row.last_success_at!,
  };
}

function toImageOutcome(row: ProductRow): ImageOutcome {
  return row.metadata_image === "failed"
    ? { outcome: "failed", errorCode: row.metadata_image_error_code! }
    : { outcome: row.metadata_image! };
}

export function toProduct(row: ProductRow): Product {
  const generation = { generation: row.metadata_generation, attempts: row.metadata_attempts };
  const metadata: MetadataState =
    row.metadata_phase === "ready"
      ? { ...generation, phase: "ready", completedAt: row.metadata_completed_at!, image: toImageOutcome(row) }
      : row.metadata_phase === "failed"
        ? { ...generation, phase: "failed", errorCode: row.metadata_error_code! }
        : { ...generation, phase: row.metadata_phase, stalled: row.metadata_stalled };
  return {
    id: row.id as ProductId,
    sourceUrl: row.source_url,
    identityUrl: row.identity_url,
    option: row.option,
    shop: row.shop,
    title: row.title,
    note: row.note,
    revision: row.revision,
    collectionIds: row.collection_ids as CollectionId[],
    addedAt: row.created_at,
    updatedAt: row.updated_at,
    purchase: toPurchase(row),
    metadata,
    lastSuccessfulPrice: toLastSuccessfulPrice(row),
    picture: row.picture_version === null ? null : { version: row.picture_version },
  };
}

function toLibrary(row: LibraryRow): Library {
  return { products: row.products.map(toProduct), collections: row.collections.map(toCollection) };
}

function toBackupProduct(row: BackupProductRow): BackupProduct {
  return {
    sourceUrl: row.source_url,
    identityUrl: row.identity_url,
    option: row.option,
    shop: row.shop,
    collectedTitle: row.title,
    ownerTitle: row.owner_title,
    note: row.note,
    collectionNames: row.collection_names,
    addedAt: row.created_at,
    purchase: toPurchase(row),
    lastSuccessfulPrice: toLastSuccessfulPrice(row),
  };
}

export function readResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new LibraryError("storage_unavailable", "저장 응답을 확인할 수 없어요.");
  }
  return result.data;
}

const databaseErrors: Record<string, LibraryErrorCode> = {
  M0001: "unauthorized",
  M0002: "invalid_input",
  M0003: "collection_missing",
  M0004: "collection_duplicate",
  M0005: "identity_conflict",
  M0006: "product_missing",
  M0007: "metadata_not_retryable",
  M0008: "revision_conflict",
  M0011: "share_key_missing",
  M0016: "worker_key_missing",
  "42501": "unauthorized",
  "23514": "invalid_input",
  "22023": "invalid_input",
  "22P02": "invalid_input",
  "22003": "invalid_input",
  "22007": "invalid_input",
  "22008": "invalid_input",
};

type RpcCall = { name: string; parameters: Record<string, unknown> };
// The RPC that applies each owner change, and what it sends besides the product and the revision the screen saw.
const productChanges: { [Type in ProductChange["type"]]: (change: Extract<ProductChange, { type: Type }>) => RpcCall } = {
  details: ({ title, note, collectionIds }) => ({
    name: "moti_edit_product",
    parameters: { p_title: title, p_note: note, p_collection_ids: collectionIds },
  }),
  purchase: () => ({ name: "moti_purchase_product", parameters: {} }),
  "purchase.record": ({ date, price }) => ({
    name: "moti_record_purchase",
    parameters: { p_date: date, p_amount_minor: price?.amountMinor ?? null, p_currency: price?.currency ?? null },
  }),
  wish: () => ({ name: "moti_return_to_wish", parameters: {} }),
};

function productChangeCall(change: ProductChange): RpcCall {
  return (productChanges[change.type] as (change: ProductChange) => RpcCall)(change);
}

function toRestoreParameters({ backup }: LibraryRestoreCommand) {
  return {
    p_collections: backup.collections.map(({ name, createdAt }) => ({ name, created_at: createdAt })),
    p_products: backup.products.map((product) => {
      const paid = product.purchase.status === "purchased" ? product.purchase : null;
      return {
        source_url: product.sourceUrl,
        identity_url: product.identityUrl,
        option: product.option,
        shop: product.shop,
        title: product.collectedTitle,
        owner_title: product.ownerTitle,
        note: product.note,
        collection_names: product.collectionNames,
        created_at: product.addedAt,
        purchase_status: product.purchase.status,
        purchased_on: paid?.date ?? null,
        purchased_amount_minor: paid?.price?.amountMinor ?? null,
        purchased_currency: paid?.price?.currency ?? null,
        last_success_amount_minor: product.lastSuccessfulPrice?.amountMinor ?? null,
        last_success_currency: product.lastSuccessfulPrice?.currency ?? null,
        last_success_at: product.lastSuccessfulPrice?.checkedAt ?? null,
      };
    }),
  };
}

export async function callRpc(client: SupabaseClient, name: string, parameters?: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(name, parameters);
  if (error) {
    throw new LibraryError(
      databaseErrors[error.code] ?? "storage_unavailable",
      "보관함 요청을 처리하지 못했어요.",
    );
  }
  return data;
}

export function createSupabaseLibraryStore(client: SupabaseClient): LibraryStore {
  const rpc = (name: string, parameters?: Record<string, unknown>) => callRpc(client, name, parameters);

  return {
    async snapshot() {
      return toLibrary(readResponse(libraryRowSchema, await rpc("moti_snapshot")));
    },
    async saveLink(command) {
      const response = readResponse(z.object({
        kind: z.enum(["added", "duplicate"]),
        product: productRowSchema,
      }), await rpc("moti_save_link", {
        p_source_url: command.sourceUrl,
        p_identity_url: command.identityUrl,
        p_option: command.option,
        p_shop: command.shop,
        p_collection_ids: command.collectionIds,
      }));
      return { kind: response.kind, product: toProduct(response.product) };
    },
    async createCollection(command) {
      return toCollection(readResponse(collectionRowSchema, await rpc("moti_create_collection", {
        p_name: command.name,
      })));
    },
    async openPicture(command) {
      const name = readResponse(pictureObjectSchema.nullable(), await rpc("moti_picture_locate", {
        p_product_id: command.productId,
      }));
      if (name === null) return { kind: "missing" };
      const { data, error } = await client.storage.from(PICTURE_BUCKET).createSignedUrl(name, PICTURE_LINK_SECONDS);
      if (!error) return { kind: "found", url: data.signedUrl };
      if ("statusCode" in error && error.statusCode === "404") return { kind: "missing" };
      throw new LibraryError("storage_unavailable", "사진을 열지 못했어요.");
    },
    async changeProduct({ productId, revision, change }) {
      const { name, parameters } = productChangeCall(change);
      return toProduct(readResponse(productRowSchema, await rpc(name, {
        p_product_id: productId,
        p_revision: revision,
        ...parameters,
      })));
    },
    async renameCollection({ collectionId, revision, name }) {
      return toCollection(readResponse(collectionRowSchema, await rpc("moti_rename_collection", {
        p_collection_id: collectionId,
        p_revision: revision,
        p_name: name,
      })));
    },
    async exportLibrary() {
      const response = readResponse(backupRowSchema, await rpc("moti_backup"));
      return {
        collections: response.collections.map((row) => ({ name: row.name, createdAt: row.created_at })),
        products: response.products.map(toBackupProduct),
      };
    },
    async restoreLibrary(command) {
      const response = readResponse(z.object({
        library: libraryRowSchema,
        replaced_pictures: z.array(pictureObjectSchema),
      }), await rpc("moti_restore_library", toRestoreParameters(command)));
      return { library: toLibrary(response.library), replacedPictures: response.replaced_pictures };
    },
  };
}
