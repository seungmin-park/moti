export type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "avif";

// Bounds for a copy: the shop's bytes, the pixels a decoder may allocate, the time to re-encode, and the stored WebP.
export const pictureLimits = {
  maxSourceBytes: 8 * 1024 * 1024,
  maxInputPixels: 25_000_000,
  maxNormalizeSeconds: 5,
  maxEdge: 1200,
  maxStoredBytes: 1024 * 1024,
} as const;

const ascii = (head: Uint8Array, at: number, text: string) =>
  head.length >= at + text.length && [...text].every((char, index) => head[at + index] === char.charCodeAt(0));
const startsWith = (head: Uint8Array, signature: number[]) =>
  head.length >= signature.length && signature.every((byte, index) => head[index] === byte);

// An ISO media file is AVIF only when its ftyp box names an AVIF brand; HEIC shares the container.
function isAvif(head: Uint8Array): boolean {
  if (!ascii(head, 4, "ftyp")) return false;
  const size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
  if (size < 16 || size > head.length) return false;
  for (let at = 8; at + 4 <= size; at += at === 8 ? 8 : 4) {
    if (ascii(head, at, "avif") || ascii(head, at, "avis")) return true;
  }
  return false;
}

// Only the bytes decide. A declared content type or file name never does, so SVG, HTML and HEIC stay out.
export function sniffImageFormat(head: Uint8Array): ImageFormat | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) return "gif";
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return "webp";
  if (isAvif(head)) return "avif";
  return null;
}
