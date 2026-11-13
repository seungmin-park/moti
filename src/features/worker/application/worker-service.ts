import type { WorkerKeyIssueCommand, WorkerKeyRevokeCommand } from "./commands";
import type { WorkerKeyStore } from "./worker-store";

export function createWorkerKeyService(store: WorkerKeyStore) {
  return {
    read: () => store.read(),
    issue: (command: WorkerKeyIssueCommand) => store.issue(command),
    revoke: (command: WorkerKeyRevokeCommand) => store.revoke(command),
  };
}

export type WorkerKeyService = ReturnType<typeof createWorkerKeyService>;
