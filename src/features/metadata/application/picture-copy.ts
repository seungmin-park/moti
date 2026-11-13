import type { FetchErrorCode, ImageErrorCode } from "../domain/collection-error";
import { sniffImageFormat, type ImageFormat } from "../domain/picture";
import type { JobSettlement } from "./collection";

// The name the database reserved for one attempt's copy. Only the database makes one; code passes it along.
export type PictureObject = string & { readonly __pictureObject: unique symbol };
export type ImageCopy = { outcome: "copied" | "absent" } | { outcome: "failed"; code: ImageErrorCode };

export type ImageRead = { ok: true; bytes: Uint8Array } | { ok: false; code: FetchErrorCode };
// The boundary to the shop's image server. `pageUrl` is the page that named the image.
export interface ImageSource {
  read(url: string, options: { pageUrl: string; signal: AbortSignal }): Promise<ImageRead>;
}

// Always WebP in sRGB with no metadata, re-encoded from pixels so nothing of the shop's file survives but the picture.
export type NormalizedPicture = { bytes: Uint8Array; width: number; height: number };
export type Normalized = { ok: true; picture: NormalizedPicture } | { ok: false; code: "unreadable_image" | "too_large" | "timeout" };
export type PictureNormalizer = (bytes: Uint8Array, format: ImageFormat) => Promise<Normalized>;

// The private bucket, reached with the owner's token. Storage policies admit only the reserved name of a running job.
export interface PictureStore {
  put(object: PictureObject, picture: NormalizedPicture): Promise<boolean>;
  // Best effort and never throws: an object left behind is unreferenced and a later sweep can remove it.
  discard(objects: readonly PictureObject[]): Promise<void>;
}

export type PictureTask = { imageUrl: string | null; pageUrl: string; target: PictureObject };
export interface PictureCopier {
  // Copies the page's picture under `task.target`, hands the outcome to `settle` exactly once, then removes the
  // object the settlement left unreferenced. Never throws for image problems; rethrows only what `settle` throws,
  // and then removes nothing: a settlement that threw here may still commit and point the product at the copy.
  settleWith(task: PictureTask, settle: (image: ImageCopy) => Promise<JobSettlement>): Promise<JobSettlement>;
}

// The image server's whole answer, redirects included.
const IMAGE_FETCH_MS = 10_000;

const failed = (code: ImageErrorCode): ImageCopy => ({ outcome: "failed", code });

export function createPictureCopier({ source, normalize, pictures }: {
  source: ImageSource;
  normalize: PictureNormalizer;
  pictures: PictureStore;
}): PictureCopier {
  async function copy(task: PictureTask): Promise<ImageCopy> {
    if (task.imageUrl === null) return { outcome: "absent" };
    try {
      const read = await source.read(task.imageUrl, { pageUrl: task.pageUrl, signal: AbortSignal.timeout(IMAGE_FETCH_MS) });
      if (!read.ok) return failed(read.code);
      const format = sniffImageFormat(read.bytes);
      if (format === null) return failed("unsupported_content");
      const normalized = await normalize(read.bytes, format);
      if (!normalized.ok) return failed(normalized.code);
      return (await pictures.put(task.target, normalized.picture)) ? { outcome: "copied" } : failed("upload_failed");
    } catch {
      return failed("internal");
    }
  }

  return {
    async settleWith(task, settle) {
      const image = await copy(task);
      // An object left by a thrown settlement is unreferenced if it never commits; unit 5 sweeps those.
      const settlement = await settle(image);
      if (image.outcome === "copied" && settlement.kind === "stale") await pictures.discard([task.target]);
      if (settlement.kind === "applied" && settlement.replacedPicture !== null) {
        await pictures.discard([settlement.replacedPicture]);
      }
      return settlement;
    },
  };
}
