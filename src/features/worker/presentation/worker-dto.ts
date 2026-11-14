import { z } from "zod";
import type { ScheduledRunResult, WorkerKeyIssueResult, WorkerReadResult } from "../application/commands";
import { WORKER_SECRET_PATTERN, workerFailureCodes, type WorkerCounts, type WorkerKey, type WorkerRun } from "../domain/worker";

export const SCHEDULED_RUNS_PATH = "/api/scheduled-runs";
// What the owner sets in GitHub. Nothing runs until both are set; the screen shows these names.
export const WORKER_TOKEN_SECRET = "MOTI_WORKER_TOKEN";
export const WORKER_URL_VARIABLE = "MOTI_WORKER_URL";

const count = z.number().int().min(0);
const countsSchema = {
  collections: z.object({ collected: count, failed: count }).strict(),
  prices: z.object({ confirmed: count, kept: count }).strict(),
  // Why collections failed and why price checks kept the previous price, from the closed lists, and how often each
  // happened. Never a link, a name or a key.
  failures: z.partialRecord(z.enum(workerFailureCodes), z.number().int().min(1)),
};

export const scheduledRunResponseSchema = z.object({ stop: z.enum(["done", "deadline"]), ...countsSchema }).strict();
export const scheduledRunErrorCodes = [
  "worker_key_rejected",
  "run_busy",
  "run_lost",
  "run_limit",
  "unconfigured",
  "unavailable",
] as const;
export type ScheduledRunErrorCode = (typeof scheduledRunErrorCodes)[number];
export const scheduledRunErrorResponseSchema = z.object({
  error: z.enum(scheduledRunErrorCodes),
  message: z.string().min(1),
}).strict();

export type ScheduledRunResponse = z.infer<typeof scheduledRunResponseSchema>;
export type ScheduledRunErrorResponse = z.infer<typeof scheduledRunErrorResponseSchema>;

// What the GitHub log shows. A refused key reads the same whether it was unknown, revoked or malformed.
export const scheduledRunMessages: Record<ScheduledRunErrorCode, string> = {
  worker_key_rejected: `작업 키가 맞지 않거나 폐기됐어요. moti의 자동 확인에서 새 키를 만들어 GitHub 비밀값 ${WORKER_TOKEN_SECRET}을 바꿔 주세요.`,
  run_busy: "다른 실행이 아직 진행 중이에요. 이번 실행은 건너뛰어요.",
  run_lost: "실행 중에 실행 기록이 닫혔어요. 다음 예약 실행에서 이어가요.",
  run_limit: "24시간에 8번까지 실행해요. 다음 예약 실행을 기다려 주세요.",
  unconfigured: "moti 서버 설정이 아직 없어요.",
  unavailable: "지금은 실행하지 못했어요. 다음 예약 실행에서 다시 시도해요.",
};

function toCountsResponse({ collections, prices, failures }: WorkerCounts) {
  return { collections: { ...collections }, prices: { ...prices }, failures: { ...failures } };
}

export function toScheduledRunResponse(result: Extract<ScheduledRunResult, { kind: "finished" }>): ScheduledRunResponse {
  return { stop: result.stop, ...toCountsResponse(result) };
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
