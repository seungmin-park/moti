import { createAnonymousClient, readAuthConfig } from "@/features/auth/infrastructure/supabase-auth";
import { readProductPage } from "@/features/metadata/infrastructure/html-reader";
import { strictFetchPolicy } from "@/features/metadata/infrastructure/address-policy";
import { createSafePageSource } from "@/features/metadata/infrastructure/safe-fetch";
import { createScheduledRunService } from "@/features/worker/application/scheduled-run";
import { createSupabaseWorkerRunStore } from "@/features/worker/infrastructure/supabase-worker-store";
import type { WorkerRequestContext } from "@/features/worker/presentation/worker-handlers";

// GitHub's scheduled requests. Nothing here reads or writes a cookie or reaches Storage (lint keeps it that way), so
// the database always sees anon and the worker key, never the owner's session. Each step gives up after 5 s.
export async function workerContext(): Promise<WorkerRequestContext> {
  const config = readAuthConfig(process.env);
  if (!config) return { kind: "unconfigured" };
  const client = createAnonymousClient(config, { requestTimeoutMs: 5_000 });
  return {
    kind: "ready",
    service: createScheduledRunService({
      store: createSupabaseWorkerRunStore(client),
      source: createSafePageSource({ policy: strictFetchPolicy }),
      read: readProductPage,
      now: Date.now,
    }),
  };
}
