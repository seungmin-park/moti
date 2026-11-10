import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  LibraryError,
  type CollectionId,
  type LibraryCollection,
  type LibraryErrorCode,
  type LibraryProduct,
  type MetadataState,
  type ProductId,
} from "../domain";
import type { LibraryStore } from "./library-store";

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = count.min(1);
const money = count.nullable();
const currency = z.string().regex(/^[A-Z]{3}$/).nullable();
const collectionRow = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  revision,
  created_at: timestamp,
  updated_at: timestamp,
});
const productRow = z.object({
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
  purchase_status: z.enum(["wish", "purchased"]),
  purchased_on: z.iso.date().nullable(),
  purchased_amount_minor: money,
  purchased_currency: currency,
  metadata_phase: z.enum(["queued", "running", "ready", "failed"]),
  metadata_generation: revision,
  metadata_attempts: count,
  metadata_error_code: z.string().min(1).nullable(),
  metadata_completed_at: timestamp.nullable(),
  last_success_amount_minor: money,
  last_success_currency: currency,
  last_success_at: timestamp.nullable(),
}).refine((row) => {
  const purchaseConsistent =
    row.purchase_status === "wish"
      ? row.purchased_on === null && row.purchased_amount_minor === null && row.purchased_currency === null
      : (row.purchased_amount_minor === null) === (row.purchased_currency === null);
  const priceConsistent =
    (row.last_success_amount_minor === null) === (row.last_success_currency === null) &&
    (row.last_success_amount_minor === null) === (row.last_success_at === null);
  const metadataConsistent =
    row.metadata_phase === "ready"
      ? row.metadata_completed_at !== null && row.metadata_error_code === null
      : row.metadata_phase === "failed"
        ? row.metadata_error_code !== null && row.metadata_completed_at === null
        : row.metadata_error_code === null && row.metadata_completed_at === null;
  return purchaseConsistent && priceConsistent && metadataConsistent;
});

function toCollection(row: z.infer<typeof collectionRow>): LibraryCollection {
  return {
    id: row.id as CollectionId,
    name: row.name,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProduct(row: z.infer<typeof productRow>): LibraryProduct {
  const generation = { generation: row.metadata_generation, attempts: row.metadata_attempts };
  const metadata: MetadataState =
    row.metadata_phase === "ready"
      ? { ...generation, phase: "ready", completedAt: row.metadata_completed_at! }
      : row.metadata_phase === "failed"
        ? { ...generation, phase: "failed", errorCode: row.metadata_error_code! }
        : { ...generation, phase: row.metadata_phase };
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
    purchase: row.purchase_status === "wish" ? { status: "wish" } : {
      status: "purchased",
      date: row.purchased_on,
      price: row.purchased_amount_minor === null ? null : {
        amountMinor: row.purchased_amount_minor,
        currency: row.purchased_currency!,
      },
    },
    metadata,
    lastSuccessfulPrice: row.last_success_amount_minor === null ? null : {
      amountMinor: row.last_success_amount_minor,
      currency: row.last_success_currency!,
      checkedAt: row.last_success_at!,
    },
  };
}

function readResponse<T>(schema: z.ZodType<T>, value: unknown): T {
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
  "42501": "unauthorized",
  "23514": "invalid_input",
  "22023": "invalid_input",
  "22P02": "invalid_input",
};

export function createSupabaseLibraryStore(client: SupabaseClient): LibraryStore {
  async function rpc(name: string, parameters?: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.rpc(name, parameters);
    if (error) {
      throw new LibraryError(
        databaseErrors[error.code] ?? "storage_unavailable",
        "보관함 요청을 처리하지 못했어요.",
      );
    }
    return data;
  }

  return {
    async snapshot() {
      const response = readResponse(z.object({
        products: z.array(productRow),
        collections: z.array(collectionRow),
      }), await rpc("moti_snapshot"));
      return {
        products: response.products.map(toProduct),
        collections: response.collections.map(toCollection),
      };
    },
    async saveLink(command) {
      const response = readResponse(z.object({
        kind: z.enum(["added", "duplicate"]),
        product: productRow,
      }), await rpc("moti_save_link", {
        p_source_url: command.sourceUrl,
        p_identity_url: command.identityUrl,
        p_option: command.option,
        p_shop: command.shop,
        p_collection_ids: command.collectionIds,
      }));
      return { kind: response.kind, product: toProduct(response.product) };
    },
    async createCollection(name) {
      return toCollection(readResponse(collectionRow, await rpc("moti_create_collection", {
        p_name: name,
      })));
    },
  };
}
