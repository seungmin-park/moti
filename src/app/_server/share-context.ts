import { createAnonymousClient, readAuthConfig } from "@/features/auth/infrastructure/supabase-auth";
import { createShareLinkService } from "@/features/share/application/share-service";
import { createSupabaseShareLinkStore } from "@/features/share/infrastructure/supabase-share-store";
import type { ShareRequestContext } from "@/features/share/presentation/share-handlers";

// The Shortcut's requests. Nothing here reads or writes a cookie (lint keeps it that way), so the database always sees
// anon and the key, never the owner's session.
export async function shareContext(): Promise<ShareRequestContext> {
  const config = readAuthConfig(process.env);
  if (!config) return { kind: "unconfigured" };
  const client = createAnonymousClient(config, { requestTimeoutMs: 10_000 });
  return { kind: "ready", service: createShareLinkService(createSupabaseShareLinkStore(client)) };
}
