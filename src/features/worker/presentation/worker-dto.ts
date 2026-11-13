import { z } from "zod";
import { collectionErrorCodes } from "../../metadata/domain/collection-error";
import type { WorkerKeyIssueResult, WorkerReadResult } from "../application/commands";
import { WORKER_SECRET_PATTERN, type WorkerCounts, type WorkerKey, type WorkerRun } from "../domain/worker";

const count = z.number().int().min(0);
const countsSchema = {
  collections: z.object({ collected: count, failed: count }).strict(),
  prices: z.object({ confirmed: count, kept: count }).strict(),
  // Reasons from the closed list and how often each happened. Never a link, a name or a key.
  failures: z.partialRecord(z.enum(collectionErrorCodes), z.number().int().min(1)),
};

function toCountsResponse({ collections, prices, failures }: WorkerCounts) {
  return { collections: { ...collections }, prices: { ...prices }, failures: { ...failures } };
}

const timestamp = z.iso.datetime();

// The owner's view of a key: its last four characters and times, never the secret or its hash.
export const workerKeyResponseSchema = z.object({
  id: z.uuid(),
  hint: z.string().regex(/^[A-Za-z0-9_-]{4}$/),
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
}).strict();
export const workerRunResponseSchema = z.object({
  id: z.uuid(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  state: z.enum(["running", "done", "deadline", "cut", "revoked"]),
  ...countsSchema,
}).strict();
export const workerReadResponseSchema = z.object({
  key: workerKeyResponseSchema.nullable(),
  runs: z.array(workerRunResponseSchema).max(5),
}).strict();
// `replaces` is the active key the screen showed, or null when it showed none.
export const workerKeyIssueRequestSchema = z.object({ replaces: z.string().nullable() }).strict();
export const workerKeyIssueResponseSchema = z.object({
  key: workerKeyResponseSchema,
  secret: z.string().regex(WORKER_SECRET_PATTERN),
}).strict();
export const workerKeyRevokeResponseSchema = z.object({ key: workerKeyResponseSchema }).strict();

export type WorkerKeyResponse = z.infer<typeof workerKeyResponseSchema>;
export type WorkerRunResponse = z.infer<typeof workerRunResponseSchema>;
export type WorkerReadResponse = z.infer<typeof workerReadResponseSchema>;
export type WorkerKeyIssueRequest = z.infer<typeof workerKeyIssueRequestSchema>;
export type WorkerKeyIssueResponse = z.infer<typeof workerKeyIssueResponseSchema>;
export type WorkerKeyRevokeResponse = z.infer<typeof workerKeyRevokeResponseSchema>;

export function toWorkerKeyResponse(key: WorkerKey): WorkerKeyResponse {
  return { id: key.id, hint: key.hint, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt, revokedAt: key.revokedAt };
}

function toWorkerRunResponse(run: WorkerRun): WorkerRunResponse {
  return { id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, state: run.state, ...toCountsResponse(run) };
}

export function toWorkerReadResponse(result: WorkerReadResult): WorkerReadResponse {
  return { key: result.key && toWorkerKeyResponse(result.key), runs: result.runs.map(toWorkerRunResponse) };
}

export function toWorkerKeyIssueResponse(result: WorkerKeyIssueResult): WorkerKeyIssueResponse {
  return { key: toWorkerKeyResponse(result.key), secret: result.secret };
}

export function toWorkerKeyRevokeResponse(key: WorkerKey): WorkerKeyRevokeResponse {
  return { key: toWorkerKeyResponse(key) };
}
