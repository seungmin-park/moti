import type { FetchErrorCode, ImageErrorCode } from "../domain/collection-error";
import type { ImageFormat } from "../domain/picture";

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
export type Normalized = { ok: true; picture: NormalizedPicture } | { ok: false; code: "unreadable_image" | "too_large" };
export type PictureNormalizer = (bytes: Uint8Array, format: ImageFormat) => Promise<Normalized>;
