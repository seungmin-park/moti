import { readJsonBody } from "../../shared/presentation/http";
import { toShareLinkAddCommand } from "../application/commands";
import type { ShareLinkService } from "../application/share-service";
import { ShareError, readShareSecret, type ShareErrorCode } from "../domain/share-key";
import {
  MAX_SHARE_BYTES,
  MAX_SHARE_PAGE_BODY_BYTES,
  shareLinkAddEnvelopeSchema,
  toPageSnapshot,
  shareLinkMessages,
  toShareLinkAddResponse,
  type ShareLinkErrorCode,
  type ShareLinkErrorResponse,
} from "./share-dto";

// Built without cookies: a Shortcut has no session, and a browser's session never counts here.
export type ShareRequestContext = { kind: "unconfigured" } | { kind: "ready"; service: ShareLinkService };

const errorStatus: Record<ShareLinkErrorCode, number> = {
  share_key_rejected: 401,
  share_key_busy: 429,
  invalid_link: 400,
  identity_conflict: 409,
  unsupported_media_type: 415,
  payload_too_large: 413,
  unconfigured: 503,
  unavailable: 503,
};

const fromShareError: Record<ShareErrorCode, ShareLinkErrorCode> = {
  key_rejected: "share_key_rejected",
  key_busy: "share_key_busy",
  invalid_input: "invalid_link",
  identity_conflict: "identity_conflict",
  storage_unavailable: "unavailable",
};

// No Access-Control headers: a page on another site cannot read an answer, and the key is not something it holds.
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function failure(code: ShareLinkErrorCode): Response {
  const body: ShareLinkErrorResponse = { error: code, message: shareLinkMessages[code] };
  return json(errorStatus[code], body, code === "share_key_rejected" ? { "www-authenticate": "Bearer" } : {});
}

function carriesPage(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "page" in value;
}

export function createShareHandlers(context: () => Promise<ShareRequestContext>) {
  return {
    // The key's format is checked before anything else, so a request without one reads no body and reaches no database.
    // Unknown, revoked and malformed keys get the same answer.
    async postShareLink(request: Request): Promise<Response> {
      const secret = readShareSecret(request.headers.get("authorization"));
      if (!secret) return failure("share_key_rejected");
      let current: ShareRequestContext;
      try {
        current = await context();
      } catch {
        return failure("unavailable");
      }
      if (current.kind === "unconfigured") return failure("unconfigured");
      // Only a body that carries the Safari Shortcut's page may pass the 8 KiB that a link or shared text needs.
      const body = await readJsonBody(request, MAX_SHARE_PAGE_BODY_BYTES);
      if (!body.ok && body.reason !== "invalid_json") return failure(body.reason);
      if (body.bytes > MAX_SHARE_BYTES && !(body.ok && carriesPage(body.value))) return failure("payload_too_large");
      if (!body.ok) return failure("invalid_link");
      const parsed = shareLinkAddEnvelopeSchema.safeParse(body.value);
      if (!parsed.success) return failure("invalid_link");
      try {
        // The link comes first: a request without one is invalid_link whatever its page. A page that is not the
        // script's snapshot is dropped and the link is still saved; the answer says the page was not read.
        const command = toShareLinkAddCommand(secret, parsed.data.url);
        const page = parsed.data.page === undefined ? null : toPageSnapshot(parsed.data.page);
        const pageUnread = parsed.data.page !== undefined && page === null;
        const result = await current.service.add({ ...command, page });
        return json(result.kind === "added" ? 201 : 200, toShareLinkAddResponse(result, pageUnread));
      } catch (error) {
        return failure(error instanceof ShareError ? fromShareError[error.code] : "unavailable");
      }
    },
  };
}
