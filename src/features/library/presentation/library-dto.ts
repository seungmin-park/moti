import { z } from "zod";
import { MAX_METADATA_GENERATION, type MetadataRetryResult } from "../../metadata/application/commands";
import type { LinkSaveResult } from "../application/commands";
import { collectionErrorCodes, imageErrorCodes } from "../../metadata/domain/collection-error";
import type { Collection, Library, Picture, Product, ProductId } from "../domain/library";

const timestamp = z.iso.datetime();
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
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

// A same-origin address that stays the same for one copy. No storage path, signed token or shop address reaches
// the screen; the route signs a short-lived link when the browser asks for the bytes.
export const pictureResponseSchema = z.object({
  src: z.string().regex(new RegExp(`^/api/products/${uuid}/picture\\?v=${uuid}$`)),
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
    z.object({
      phase: z.enum(["queued", "running"]),
      generation: z.number().int(),
      attempts: z.number().int(),
      stalled: z.boolean(),
    }).strict(),
    z.object({
      phase: z.literal("ready"),
      generation: z.number().int(),
      attempts: z.number().int(),
      completedAt: timestamp,
      image: z.discriminatedUnion("outcome", [
        z.object({ outcome: z.enum(["copied", "absent"]) }).strict(),
        z.object({ outcome: z.literal("failed"), errorCode: z.enum(imageErrorCodes) }).strict(),
      ]),
    }).strict(),
    z.object({
      phase: z.literal("failed"),
      generation: z.number().int(),
      attempts: z.number().int(),
      errorCode: z.enum(collectionErrorCodes),
    }).strict(),
  ]),
  lastSuccessfulPrice: moneyResponseSchema.extend({ checkedAt: timestamp }).strict().nullable(),
  picture: pictureResponseSchema.nullable(),
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
export const metadataRetryRequestSchema = z.object({ generation: z.number().int().min(1).max(MAX_METADATA_GENERATION) }).strict();
export const metadataRetryResponseSchema = z.object({ product: productResponseSchema }).strict();
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
  "product_missing",
  "metadata_not_retryable",
  "picture_missing",
  "storage_unavailable",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

export const errorResponseSchema = z.object({
  error: z.enum(errorCodes),
  message: z.string().min(1),
  field: z.string().optional(),
}).strict();

export type CollectionResponse = z.infer<typeof collectionResponseSchema>;
export type PictureResponse = z.infer<typeof pictureResponseSchema>;
export type ProductResponse = z.infer<typeof productResponseSchema>;
export type LibraryReadResponse = z.infer<typeof libraryReadResponseSchema>;
export type LinkSaveRequest = z.infer<typeof linkSaveRequestSchema>;
export type LinkSaveResponse = z.infer<typeof linkSaveResponseSchema>;
export type CollectionCreateRequest = z.infer<typeof collectionCreateRequestSchema>;
export type CollectionCreateResponse = z.infer<typeof collectionCreateResponseSchema>;
export type MetadataRetryRequest = z.infer<typeof metadataRetryRequestSchema>;
export type MetadataRetryResponse = z.infer<typeof metadataRetryResponseSchema>;
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
    metadata: product.metadata.phase === "ready"
      ? { ...product.metadata, image: { ...product.metadata.image } }
      : { ...product.metadata },
    lastSuccessfulPrice: product.lastSuccessfulPrice && { ...product.lastSuccessfulPrice },
    picture: product.picture && toPictureResponse(product.id, product.picture),
  };
}

export function toPictureResponse(productId: ProductId, picture: Picture): PictureResponse {
  return { src: `/api/products/${productId}/picture?v=${picture.version}` };
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

export function toMetadataRetryResponse(result: MetadataRetryResult): MetadataRetryResponse {
  return { product: toProductResponse(result.product) };
}
