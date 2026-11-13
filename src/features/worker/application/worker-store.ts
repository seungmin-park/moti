import type { CollectionErrorCode } from "../../metadata/domain/collection-error";
import type { CollectedPage } from "../../metadata/application/collection";
import type { PriceCheckOutcome } from "../domain/price-check";
import type { WorkerCounts, WorkerKey, WorkerSecret } from "../domain/worker";
import type { WorkerKeyIssueCommand, WorkerKeyIssueResult, WorkerKeyRevokeCommand, WorkerReadResult } from "./commands";

// The owner's session: it sees each key's hint and times and the runs' counts, never a hash or a lease.
export interface WorkerKeyStore {
  read(): Promise<WorkerReadResult>;
  // Revokes the key the command names (when it is still the active one) and makes a new one in one transaction.
  issue(command: WorkerKeyIssueCommand): Promise<WorkerKeyIssueResult>;
  revoke(command: WorkerKeyRevokeCommand): Promise<WorkerKey>;
}

// A started run: every later step sends the key again with the run and its lease.
export type WorkerRunLease = { secret: WorkerSecret; run: string; lease: string };
export type WorkerJob = { id: string; leaseToken: string; sourceUrl: string };
// A picked daily price check. `fence` is the time the pick set, sent back exactly as it came: only it settles the check.
export type WorkerPriceCheck = { productId: string; fence: string; sourceUrl: string };
export type WorkerItem = { kind: "collection"; job: WorkerJob } | { kind: "price"; check: WorkerPriceCheck } | { kind: "none" };
// `stale`: the job's generation or lease moved on, or the check's product was purchased or picked again, and nothing
// was written.
export type WorkerSettlement = "applied" | "stale";
export type WorkerStop = "done" | "deadline";

// The worker's steps, run with the key and no session. Each step throws WorkerError: key_rejected (the key is unknown,
// revoked or not the owner's), run_lost (the run's lease is gone), run_busy and run_limit (begin only).
export interface WorkerRunStore {
  begin(secret: WorkerSecret): Promise<WorkerRunLease>;
  next(lease: WorkerRunLease): Promise<WorkerItem>;
  complete(lease: WorkerRunLease, job: WorkerJob, page: CollectedPage): Promise<WorkerSettlement>;
  fail(lease: WorkerRunLease, job: WorkerJob, code: CollectionErrorCode): Promise<WorkerSettlement>;
  // Never a name or a picture: the database compares the price with the stored one and keeps it when it cannot.
  price(lease: WorkerRunLease, check: WorkerPriceCheck, outcome: PriceCheckOutcome): Promise<WorkerSettlement>;
  finish(lease: WorkerRunLease, stop: WorkerStop): Promise<WorkerCounts & { stop: WorkerStop }>;
}
