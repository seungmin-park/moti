export const MAX_JSON_BYTES = 16 * 1024;

function firstHeader(request: Request, name: string): string | undefined {
  return request.headers.get(name)?.split(",")[0].trim() || undefined;
}

// Next passes an internal request.url (for example localhost) to Route Handlers, so the public
// address comes from the forwarded or Host header, the same source Next uses for its own CSRF check.
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = firstHeader(request, "x-forwarded-host") ?? firstHeader(request, "host") ?? url.host;
  const protocol = firstHeader(request, "x-forwarded-proto") ?? url.protocol.slice(0, -1);
  return `${protocol}://${host}`;
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(publicOrigin(request)).host;
  } catch {
    return false;
  }
}

export function publicUrl(request: Request, path: string): string {
  return new URL(path, publicOrigin(request)).href;
}

export function redirect(request: Request, path: string): Response {
  return redirectTo(publicUrl(request, path));
}

export function redirectTo(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

export type JsonBody =
  | { ok: true; value: unknown }
  | { ok: false; reason: "unsupported_media_type" | "payload_too_large" | "invalid_json" };

export async function readJsonBody(request: Request): Promise<JsonBody> {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { ok: false, reason: "unsupported_media_type" };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) return { ok: false, reason: "payload_too_large" };
  const bytes = await readLimited(request, MAX_JSON_BYTES);
  if (!bytes) return { ok: false, reason: "payload_too_large" };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
