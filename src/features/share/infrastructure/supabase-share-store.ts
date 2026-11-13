import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ShareLinkStore } from "../application/share-store";
import { ShareError, type ShareErrorCode } from "../domain/share-key";

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
