import { z } from "zod";
import type { LinkSaveResult } from "../application/commands";
import type { Collection, Library, Product } from "../domain/library";

const timestamp = z.iso.datetime();
const moneyResponseSchema = z.object({
  amountMinor: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const collectionResponseSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(40),
  revision: z.number().int().min(1),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const productResponseSchema = z.object({
  id: z.uuid(),
  sourceUrl: z.string(),
  identityUrl: z.string(),
  option: z.string(),
  shop: z.string(),
  title: z.string(),
  note: z.string(),
  revision: z.number().int().min(1),
  collectionIds: z.array(z.uuid()),
  addedAt: timestamp,
  updatedAt: timestamp,
  purchase: z.discriminatedUnion("status", [
    z.object({ status: z.literal("wish") }).strict(),
    z.object({ status: z.literal("purchased"), date: z.iso.date().nullable(), price: moneyResponseSchema.nullable() }).strict(),
  ]),
  metadata: z.discriminatedUnion("phase", [
    z.object({ phase: z.enum(["queued", "running"]), generation: z.number().int(), attempts: z.number().int() }).strict(),
    z.object({ phase: z.literal("ready"), generation: z.number().int(), attempts: z.number().int(), completedAt: timestamp }).strict(),
    z.object({ phase: z.literal("failed"), generation: z.number().int(), attempts: z.number().int(), errorCode: z.string() }).strict(),
  ]),
  lastSuccessfulPrice: moneyResponseSchema.extend({ checkedAt: timestamp }).strict().nullable(),
}).strict();

export const libraryReadResponseSchema = z.object({
  products: z.array(productResponseSchema),
  collections: z.array(collectionResponseSchema),
}).strict();

export const linkSaveRequestSchema = z.object({
  url: z.string(),
  option: z.string(),
  collectionIds: z.array(z.string()).max(100),
}).strict();

export const linkSaveResponseSchema = z.object({
  kind: z.enum(["added", "duplicate"]),
  product: productResponseSchema,
}).strict();

export const collectionCreateRequestSchema = z.object({ name: z.string() }).strict();
export const collectionCreateResponseSchema = collectionResponseSchema;

export const errorCodes = [
  "signed_out",
  "forbidden",
  "unconfigured",
  "cross_origin",
  "unsupported_media_type",
  "payload_too_large",
  "invalid_input",
  "collection_missing",
  "collection_duplicate",
  "identity_conflict",
  "storage_unavailable",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export const errorResponseSchema = z.object({
  error: z.enum(errorCodes),
  message: z.string().min(1),
  field: z.string().optional(),
}).strict();

export type CollectionResponse = z.infer<typeof collectionResponseSchema>;
export type ProductResponse = z.infer<typeof productResponseSchema>;
export type LibraryReadResponse = z.infer<typeof libraryReadResponseSchema>;
export type LinkSaveRequest = z.infer<typeof linkSaveRequestSchema>;
export type LinkSaveResponse = z.infer<typeof linkSaveResponseSchema>;
export type CollectionCreateRequest = z.infer<typeof collectionCreateRequestSchema>;
export type CollectionCreateResponse = z.infer<typeof collectionCreateResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export function toCollectionResponse(collection: Collection): CollectionResponse {
  return {
    id: collection.id,
    name: collection.name,
    revision: collection.revision,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

export function toProductResponse(product: Product): ProductResponse {
  return {
    id: product.id,
    sourceUrl: product.sourceUrl,
    identityUrl: product.identityUrl,
    option: product.option,
    shop: product.shop,
    title: product.title,
    note: product.note,
    revision: product.revision,
    collectionIds: [...product.collectionIds],
    addedAt: product.addedAt,
    updatedAt: product.updatedAt,
    purchase: product.purchase.status === "wish"
      ? { status: "wish" }
      : {
        status: "purchased",
        date: product.purchase.date,
        price: product.purchase.price && { ...product.purchase.price },
      },
    metadata: { ...product.metadata },
    lastSuccessfulPrice: product.lastSuccessfulPrice && { ...product.lastSuccessfulPrice },
  };
}

export function toLibraryReadResponse(library: Library): LibraryReadResponse {
  return {
    products: library.products.map(toProductResponse),
    collections: library.collections.map(toCollectionResponse),
  };
}

export function toLinkSaveResponse(result: LinkSaveResult): LinkSaveResponse {
  return { kind: result.kind, product: toProductResponse(result.product) };
}
