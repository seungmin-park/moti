import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callRpc, readResponse } from "../../library/infrastructure/supabase-library-store";
import { collectionErrorCodes } from "../../metadata/domain/collection-error";
import type { WorkerKeyStore, WorkerRunLease, WorkerRunStore } from "../application/worker-store";
import {
  WORKER_SECRET_PATTERN,
  WorkerError,
  type WorkerCounts,
  type WorkerErrorCode,
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

// The worker's answers carry ids, a link and counts, never a library row: anything else means the function reads more.
const beginRowSchema = z.object({ run: z.uuid(), lease: z.uuid() }).strict();
const itemRowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection"), job: z.uuid(), job_lease: z.uuid(), source_url: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
const settlementRowSchema = z.object({ kind: z.enum(["applied", "stale"]) }).strict();
const finishRowSchema = z.object({ stop: z.enum(["done", "deadline"]), ...countsColumns }).strict();
export type WorkerItemRow = z.infer<typeof itemRowSchema>;
export type WorkerFinishRow = z.infer<typeof finishRowSchema>;

const workerErrors: Record<string, WorkerErrorCode> = {
  M0012: "key_rejected",
  M0013: "run_lost",
  M0014: "run_busy",
  M0015: "run_limit",
};

function toCounts(row: z.infer<z.ZodObject<typeof countsColumns>>): WorkerCounts {
  return {
    collections: { collected: row.collected, failed: row.collect_failed },
    prices: { confirmed: row.prices_confirmed, kept: row.prices_kept },
    failures: row.failures,
  };
}

// The client runs as anon. The key is the only credential, and the database decides what each step may do.
export function createSupabaseWorkerRunStore(client: SupabaseClient): WorkerRunStore {
  async function call<T>(name: string, parameters: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const { data, error } = await client.rpc(name, parameters);
    if (error) throw new WorkerError(workerErrors[error.code] ?? "storage_unavailable", "예약 실행을 이어가지 못했어요.");
    const row = schema.safeParse(data);
    if (!row.success) throw new WorkerError("storage_unavailable", "저장 응답을 확인할 수 없어요.");
    return row.data;
  }
  const step = ({ secret, run, lease }: WorkerRunLease) => ({ p_key: secret, p_run: run, p_lease: lease });

  return {
    async begin(secret) {
      const row = await call("moti_worker_begin", { p_key: secret }, beginRowSchema);
      return { secret, run: row.run, lease: row.lease };
    },
    async next(lease) {
      const row = await call("moti_worker_next", step(lease), itemRowSchema);
      return row.kind === "none"
        ? row
        : { kind: "collection", job: { id: row.job, leaseToken: row.job_lease, sourceUrl: row.source_url } };
    },
    async complete(lease, job, page) {
      const row = await call("moti_worker_complete", {
        ...step(lease),
        p_job: job.id,
        p_job_lease: job.leaseToken,
        p_title: page.title,
        p_amount_minor: page.price?.amountMinor ?? null,
        p_currency: page.price?.currency ?? null,
        p_image_source_url: page.imageSourceUrl,
      }, settlementRowSchema);
      return row.kind;
    },
    async fail(lease, job, code) {
      const row = await call("moti_worker_fail", {
        ...step(lease), p_job: job.id, p_job_lease: job.leaseToken, p_error_code: code,
      }, settlementRowSchema);
      return row.kind;
    },
    async finish(lease, stop) {
      const row = await call("moti_worker_finish", { ...step(lease), p_stop: stop }, finishRowSchema);
      return { stop: row.stop, ...toCounts(row) };
    },
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
