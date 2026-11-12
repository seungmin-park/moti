import type { ImageErrorCode } from "../domain/collection-error";

// The name the database reserved for one attempt's copy. Only the database makes one; code passes it along.
export type PictureObject = string & { readonly __pictureObject: unique symbol };
export type ImageCopy = { outcome: "copied" | "absent" } | { outcome: "failed"; code: ImageErrorCode };
