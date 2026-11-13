import {
  collectionErrorCodes,
  priceCheckCodes,
  type CollectionErrorCode,
  type PriceCheckCode,
} from "../../metadata/domain/collection-error";

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
// Why a collection failed or why a daily price check kept the previous price: the reasons a run counts.
export type WorkerFailureCode = CollectionErrorCode | PriceCheckCode;
export const workerFailureCodes = [...new Set([...collectionErrorCodes, ...priceCheckCodes])] as [WorkerFailureCode, ...WorkerFailureCode[]];
// What a run did, counted as it went. Failures are reasons from the closed lists, never links or names. A kept price
// counts its reason too, so the failures add up to the failed collections and the kept prices.
export type WorkerCounts = {
  collections: { collected: number; failed: number };
  prices: { confirmed: number; kept: number };
  failures: Partial<Record<WorkerFailureCode, number>>;
};
export type WorkerRun = WorkerCounts & { id: string; startedAt: string; finishedAt: string | null; state: WorkerRunState };

export function parseWorkerSecret(value: unknown): WorkerSecret | null {
  return typeof value === "string" && WORKER_SECRET_PATTERN.test(value) ? (value as WorkerSecret) : null;
}

// One `Bearer <key>` credential and nothing else. Repeated headers arrive comma-joined and are refused.
export function readWorkerSecret(authorization: string | null): WorkerSecret | null {
  const match = authorization === null ? null : /^Bearer ([^\s,]+)$/i.exec(authorization);
  return match ? parseWorkerSecret(match[1]) : null;
}

export type WorkerErrorCode = "key_rejected" | "run_busy" | "run_lost" | "run_limit" | "storage_unavailable";

export class WorkerError extends Error {
  constructor(readonly code: WorkerErrorCode, message: string) {
    super(message);
    this.name = "WorkerError";
  }
}
