import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callRpc, readResponse } from "../../library/infrastructure/supabase-library-store";
import type { ShareKeyStore, ShareLinkStore } from "../application/share-store";
import {
  SHARE_SECRET_PATTERN,
  ShareError,
  type ShareErrorCode,
  type ShareKey,
  type ShareKeyId,
  type ShareSecret,
} from "../domain/share-key";

// Exactly the kind: any other field would mean the key's function reads the library.
const shareLinkAddRowSchema = z.object({ kind: z.enum(["added", "duplicate"]) }).strict();
export type ShareLinkAddRow = z.infer<typeof shareLinkAddRowSchema>;

const shareErrors: Record<string, ShareErrorCode> = {
  M0009: "key_rejected",
  M0010: "key_busy",
  M0002: "invalid_input",
  M0005: "identity_conflict",
};

// The client runs as anon. The key is the only credential, and the database decides what it may do.
export function createSupabaseShareLinkStore(client: SupabaseClient): ShareLinkStore {
  return {
    async add({ secret, link }) {
      const { data, error } = await client.rpc("moti_share_add", {
        p_key: secret,
        p_source_url: link.sourceUrl,
        p_identity_url: link.identityUrl,
        p_option: link.option,
        p_shop: link.shop,
      });
      if (error) throw new ShareError(shareErrors[error.code] ?? "storage_unavailable", "공유한 링크를 담지 못했어요.");
      const row = shareLinkAddRowSchema.safeParse(data);
      if (!row.success) throw new ShareError("storage_unavailable", "저장 응답을 확인할 수 없어요.");
      return { kind: row.data.kind };
    },
  };
}

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const shareKeyRowSchema = z.object({
  id: z.uuid(),
  hint: z.string().regex(/^[A-Za-z0-9_-]{4}$/),
  created_at: timestamp,
  last_used_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
}).strict();
const shareKeyIssueRowSchema = z.object({ key: shareKeyRowSchema, secret: z.string().regex(SHARE_SECRET_PATTERN) }).strict();
export type ShareKeyRow = z.infer<typeof shareKeyRowSchema>;

function toShareKey(row: ShareKeyRow): ShareKey {
  return {
    id: row.id as ShareKeyId,
    hint: row.hint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

// The owner's session client. Errors map like every owner call: M0008 a stale screen, M0011 a key the owner lacks.
export function createSupabaseShareKeyStore(client: SupabaseClient): ShareKeyStore {
  return {
    async read() {
      const row = readResponse(shareKeyRowSchema.nullable(), await callRpc(client, "moti_share_key_read"));
      return row && toShareKey(row);
    },
    async issue({ replaces }) {
      const row = readResponse(shareKeyIssueRowSchema, await callRpc(client, "moti_share_key_issue", { p_replaces: replaces }));
      return { key: toShareKey(row.key), secret: row.secret as ShareSecret };
    },
    async revoke({ keyId }) {
      return toShareKey(readResponse(shareKeyRowSchema, await callRpc(client, "moti_share_key_revoke", { p_key_id: keyId })));
    },
  };
}
