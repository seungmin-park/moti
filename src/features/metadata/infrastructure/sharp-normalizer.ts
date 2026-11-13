import sharp from "sharp";
import type { Normalized, PictureNormalizer } from "../application/picture-copy";
import { pictureLimits, type ImageFormat } from "../domain/picture";

// libvips names an AVIF file by its container.
const decodedAs: Record<ImageFormat, string> = { jpeg: "jpeg", png: "png", webp: "webp", gif: "gif", avif: "heif" };

export function createPictureNormalizer(limits: typeof pictureLimits = pictureLimits): PictureNormalizer {
  return async (bytes, format): Promise<Normalized> => {
    // `error` also refuses truncated data; only the first frame of an animation is read.
    const input = () => sharp(bytes, { limitInputPixels: limits.maxInputPixels, failOn: "error", animated: false });
    try {
      // libvips also reads SVG, TIFF and raw files, so the decoder must agree with what the bytes were judged to be.
      if ((await input().metadata()).format !== decodedAs[format]) return { ok: false, code: "unreadable_image" };
      // Re-encoding from pixels without keepMetadata drops EXIF, GPS, ICC and anything appended to the file.
      // libvips checks the limit while it processes, so a slow decode or encode stops near it.
      const { data, info } = await input()
        .timeout({ seconds: limits.maxNormalizeSeconds })
        .autoOrient()
        .resize({ width: limits.maxEdge, height: limits.maxEdge, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      if (data.byteLength > limits.maxStoredBytes) return { ok: false, code: "too_large" };
      return { ok: true, picture: { bytes: new Uint8Array(data), width: info.width, height: info.height } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/^timeout: /.test(message)) return { ok: false, code: "timeout" };
      return { ok: false, code: /pixel limit/i.test(message) ? "too_large" : "unreadable_image" };
    }
  };
}

export const normalizePicture = createPictureNormalizer();
