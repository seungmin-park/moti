// What the detail's paste area decides before anything is sent. The server checks the bytes again and re-encodes them;
// this only keeps a large or browser-only picture (an iPhone photo, a HEIC) under the route's limit.

// A picture this small in a format the server reads goes as it is; anything else is redrawn as a JPEG first.
export const PASTE_SEND_BYTES = 2 * 1024 * 1024;
// The server keeps at most 1200 px; a little more leaves its resize something to work with.
export const PASTE_MAX_EDGE = 1600;
const sendable = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export const noImageMessage = "클립보드에 사진이 없어요. 상품 사진을 복사한 뒤 다시 붙여 넣어 주세요.";
export const unreadableMessage = "이 사진은 열 수 없어요. 다른 사진을 복사해 주세요.";
const pasteInstead = "붙여넣기 칸을 길게 누르거나 ⌘V·Ctrl+V로 붙여 넣어 주세요.";

type Typed = { type: string };

// The first image among what was pasted. A copied picture often comes with text or HTML around it.
export function pickPastedImage<T extends Typed>(files: ArrayLike<T>): T | null {
  return Array.from(files).find((file) => file.type.startsWith("image/")) ?? null;
}

export function uploadPlan(image: Typed & { size: number }): "send" | "shrink" {
  return sendable.has(image.type) && image.size <= PASTE_SEND_BYTES ? "send" : "shrink";
}

export function fitWithin({ width, height }: { width: number; height: number }, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// navigator.clipboard.read() refuses without permission (NotAllowedError) and with nothing readable (DataError).
export function clipboardProblem(error: unknown): string {
  const name = error instanceof DOMException ? error.name : null;
  if (name === "NotAllowedError") return `클립보드를 읽도록 허용되지 않았어요. ${pasteInstead}`;
  if (name === "DataError") return noImageMessage;
  return `클립보드를 읽지 못했어요. ${pasteInstead}`;
}
