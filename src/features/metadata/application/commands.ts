import { LibraryError, type Product, type ProductId } from "../../library/domain/library";

export type MetadataRetryCommand = { productId: ProductId; expectedGeneration: number };
export type MetadataRetryResult = { kind: "requeued" | "resumed"; product: Product };

// The generation column is a PostgreSQL integer; a larger value would reach the database and fail as an outage.
export const MAX_METADATA_GENERATION = 2147483647;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toMetadataRetryCommand(productId: unknown, generation: unknown): MetadataRetryCommand {
  if (typeof productId !== "string" || !uuid.test(productId)) {
    throw new LibraryError("invalid_input", "상품을 다시 선택해 주세요.");
  }
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || generation > MAX_METADATA_GENERATION) {
    throw new LibraryError("invalid_input", "화면을 새로고침한 뒤 다시 시도해 주세요.");
  }
  return { productId: productId.toLowerCase() as ProductId, expectedGeneration: generation };
}
