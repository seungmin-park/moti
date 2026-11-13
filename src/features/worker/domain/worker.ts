import type { CollectionErrorCode } from "../../metadata/domain/collection-error";

// The scheduled worker's key: a fixed prefix that differs from the share key's, so each route's format check refuses
// the other, then 256 random bits in base64url. The database makes it and keeps only its SHA-256.
export const WORKER_SECRET_PATTERN = /^moti_wk_[A-Za-z0-9_-]{43}$/;

export type WorkerSecret = string & { readonly __workerSecret: unique symbol };
export type WorkerKeyId = string & { readonly __workerKeyId: unique symbol };
// What the owner sees of a key: never the secret, only its last four characters.
export type WorkerKey = {
  id: WorkerKeyId;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
// `cut` is a run whose lease ended before it finished; `revoked` one its key's revoke stopped.
export type WorkerRunState = "running" | "done" | "deadline" | "cut" | "revoked";
// What a run did, counted as it went. Failures are reasons from the closed list, never links or names.
export type WorkerCounts = {
  collections: { collected: number; failed: number };
  prices: { confirmed: number; kept: number };
  failures: Partial<Record<CollectionErrorCode, number>>;
};
export type WorkerRun = WorkerCounts & { id: string; startedAt: string; finishedAt: string | null; state: WorkerRunState };
