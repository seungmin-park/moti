import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callRpc, readResponse } from "../../library/infrastructure/supabase-library-store";
import { collectionErrorCodes } from "../../metadata/domain/collection-error";
import type { WorkerKeyStore } from "../application/worker-store";
import {
  WORKER_SECRET_PATTERN,
  type WorkerCounts,
  type WorkerKey,
  type WorkerKeyId,
  type WorkerRun,
  type WorkerSecret,
} from "../domain/worker";

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const count = z.number().int().min(0);
const countsColumns = {
  collected: count,
  collect_failed: count,
  prices_confirmed: count,
  prices_kept: count,
  failures: z.partialRecord(z.enum(collectionErrorCodes), z.number().int().min(1)),
};

function toCounts(row: z.infer<z.ZodObject<typeof countsColumns>>): WorkerCounts {
  return {
    collections: { collected: row.collected, failed: row.collect_failed },
    prices: { confirmed: row.prices_confirmed, kept: row.prices_kept },
    failures: row.failures,
  };
}

const workerKeyRowSchema = z.object({
  id: z.uuid(),
  hint: z.string().regex(/^[A-Za-z0-9_-]{4}$/),
  created_at: timestamp,
  last_used_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
}).strict();
const workerRunRowSchema = z.object({
  id: z.uuid(),
  started_at: timestamp,
  finished_at: timestamp.nullable(),
  state: z.enum(["running", "done", "deadline", "cut", "revoked"]),
  ...countsColumns,
}).strict();
const workerReadRowSchema = z.object({ key: workerKeyRowSchema.nullable(), runs: z.array(workerRunRowSchema).max(5) }).strict();
const workerKeyIssueRowSchema = z.object({ key: workerKeyRowSchema, secret: z.string().regex(WORKER_SECRET_PATTERN) }).strict();
export type WorkerKeyRow = z.infer<typeof workerKeyRowSchema>;
export type WorkerRunRow = z.infer<typeof workerRunRowSchema>;

function toWorkerKey(row: WorkerKeyRow): WorkerKey {
  return {
    id: row.id as WorkerKeyId,
    hint: row.hint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function toWorkerRun(row: WorkerRunRow): WorkerRun {
  return { id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, state: row.state, ...toCounts(row) };
}

// The owner's session client. Errors map like every owner call: M0008 a stale screen, M0016 a key the owner lacks.
export function createSupabaseWorkerKeyStore(client: SupabaseClient): WorkerKeyStore {
  return {
    async read() {
      const row = readResponse(workerReadRowSchema, await callRpc(client, "moti_worker_read"));
      return { key: row.key && toWorkerKey(row.key), runs: row.runs.map(toWorkerRun) };
    },
    async issue({ replaces }) {
      const row = readResponse(workerKeyIssueRowSchema, await callRpc(client, "moti_worker_key_issue", { p_replaces: replaces }));
      return { key: toWorkerKey(row.key), secret: row.secret as WorkerSecret };
    },
    async revoke({ keyId }) {
      return toWorkerKey(readResponse(workerKeyRowSchema, await callRpc(client, "moti_worker_key_revoke", { p_key_id: keyId })));
    },
  };
}
