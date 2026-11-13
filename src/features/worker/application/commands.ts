import { LibraryError } from "../../library/domain/library";
import type { WorkerCounts, WorkerErrorCode, WorkerKey, WorkerKeyId, WorkerRun, WorkerSecret } from "../domain/worker";

// The owner's view: the active key (else the latest revoked one, else none) and the latest runs.
export type WorkerReadResult = { key: WorkerKey | null; runs: WorkerRun[] };
// `replaces` is the active key the owner's screen showed, or null when it showed none.
export type WorkerKeyIssueCommand = { replaces: WorkerKeyId | null };
// The only time the secret leaves the database.
export type WorkerKeyIssueResult = { key: WorkerKey; secret: WorkerSecret };
export type WorkerKeyRevokeCommand = { keyId: WorkerKeyId };

export type ScheduledRunCommand = { secret: WorkerSecret };
// A run either finished (done: nothing was left to pick; deadline: it stopped picking first) or was refused.
export type ScheduledRunResult =
  | ({ kind: "finished"; stop: "done" | "deadline" } & WorkerCounts)
  | { kind: "refused"; code: WorkerErrorCode };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The owner's key routes go through the library's gate, so their input errors are the library's.
function toWorkerKeyId(value: unknown): WorkerKeyId {
  if (typeof value !== "string" || !uuid.test(value)) {
    throw new LibraryError("invalid_input", "화면을 새로고침한 뒤 다시 시도해 주세요.");
  }
  return value.toLowerCase() as WorkerKeyId;
}

export function toWorkerKeyIssueCommand(input: { replaces: unknown }): WorkerKeyIssueCommand {
  return { replaces: input.replaces === null ? null : toWorkerKeyId(input.replaces) };
}

export function toWorkerKeyRevokeCommand(keyId: unknown): WorkerKeyRevokeCommand {
  return { keyId: toWorkerKeyId(keyId) };
}
