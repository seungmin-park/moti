import type { WorkerKey } from "../domain/worker";
import type { WorkerKeyIssueCommand, WorkerKeyIssueResult, WorkerKeyRevokeCommand, WorkerReadResult } from "./commands";

// The owner's session: it sees each key's hint and times and the runs' counts, never a hash or a lease.
export interface WorkerKeyStore {
  read(): Promise<WorkerReadResult>;
  // Revokes the key the command names (when it is still the active one) and makes a new one in one transaction.
  issue(command: WorkerKeyIssueCommand): Promise<WorkerKeyIssueResult>;
  revoke(command: WorkerKeyRevokeCommand): Promise<WorkerKey>;
}

