import type { PictureNormalizer, PictureObject, PictureStore } from "../../metadata/application/picture-copy";
import { sniffImageFormat } from "../../metadata/domain/picture";
import { LibraryError, type Product, type ProductId } from "../domain/library";

// The bytes the owner pasted, already within the route's size limit. Nothing about them is trusted yet.
export type PicturePasteCommand = { productId: ProductId; bytes: Uint8Array };
export type PictureClearCommand = { productId: ProductId };
// Why a paste was refused: the bytes are not one of the collected copies' formats, or sharp would not make a copy.
export type PicturePasteProblem = "unsupported_format" | "unreadable" | "too_large" | "timeout";
export type PicturePasteResult = { kind: "pasted"; product: Product } | { kind: "refused"; problem: PicturePasteProblem };
// `stale`: the reservation lapsed or a newer paste replaced it before this one was applied.
export type PictureApplied = { kind: "applied"; product: Product; replaced: PictureObject | null } | { kind: "stale" };

// The database side of a paste. Only SQL makes a name; the pasted copy it replaces comes back for discarding.
export interface PicturePasteStore {
  reserve(productId: ProductId): Promise<PictureObject>;
  apply(productId: ProductId, object: PictureObject): Promise<PictureApplied>;
  clear(productId: ProductId): Promise<{ product: Product; replaced: PictureObject | null }>;
}

const problems = { unreadable_image: "unreadable", too_large: "too_large", timeout: "timeout" } as const;

// The collected copies' pipeline for a picture the owner pasted: the bytes decide the format, sharp re-encodes it to a
// WebP without metadata within the same limits, and the owner's token uploads it to a name the database reserved.
export function createPicturePasteService({ store, normalize, pictures }: {
  store: PicturePasteStore;
  normalize: PictureNormalizer;
  pictures: PictureStore;
}) {
  return {
    async paste({ productId, bytes }: PicturePasteCommand): Promise<PicturePasteResult> {
      const format = sniffImageFormat(bytes);
      if (format === null) return { kind: "refused", problem: "unsupported_format" };
      const normalized = await normalize(bytes, format);
      if (!normalized.ok) return { kind: "refused", problem: problems[normalized.code] };
      const object = await store.reserve(productId);
      if (!(await pictures.put(object, normalized.picture))) {
        throw new LibraryError("storage_unavailable", "사진을 보관하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
      }
      // A throw here may still commit and point the product at the copy, so nothing is discarded; the sweep has it.
      const applied = await store.apply(productId, object);
      if (applied.kind === "stale") {
        await pictures.discard([object]);
        throw new LibraryError("storage_unavailable", "사진을 저장하는 데 너무 오래 걸렸어요. 다시 붙여 넣어 주세요.");
      }
      if (applied.replaced !== null) await pictures.discard([applied.replaced]);
      return { kind: "pasted", product: applied.product };
    },
    async clear({ productId }: PictureClearCommand): Promise<Product> {
      const { product, replaced } = await store.clear(productId);
      if (replaced !== null) await pictures.discard([replaced]);
      return product;
    },
  };
}

export type PicturePasteService = ReturnType<typeof createPicturePasteService>;
