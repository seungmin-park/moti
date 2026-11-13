import type { ScheduledRunService } from "../application/scheduled-run";
import { readWorkerSecret, type WorkerErrorCode } from "../domain/worker";
import {
  scheduledRunMessages,
  toScheduledRunResponse,
  type ScheduledRunErrorCode,
  type ScheduledRunErrorResponse,
} from "./worker-dto";

// Built without cookies: GitHub has no session, and a browser's session never counts here.
export type WorkerRequestContext = { kind: "unconfigured" } | { kind: "ready"; service: ScheduledRunService };

const errorStatus: Record<ScheduledRunErrorCode, number> = {
  worker_key_rejected: 401,
  run_busy: 409,
  run_lost: 409,
  run_limit: 429,
  unconfigured: 503,
  unavailable: 503,
};

const fromWorkerError: Record<WorkerErrorCode, ScheduledRunErrorCode> = {
  key_rejected: "worker_key_rejected",
  run_busy: "run_busy",
  run_lost: "run_lost",
  run_limit: "run_limit",
  storage_unavailable: "unavailable",
};

// No Access-Control headers: a page on another site cannot read an answer, and the key is not something it holds.
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function failure(code: ScheduledRunErrorCode): Response {
  const body: ScheduledRunErrorResponse = { error: code, message: scheduledRunMessages[code] };
  return json(errorStatus[code], body, code === "worker_key_rejected" ? { "www-authenticate": "Bearer" } : {});
}

export function createWorkerHandlers(context: () => Promise<WorkerRequestContext>) {
  return {
    // The key's format is checked before anything else, so a request without one reaches no database. The route reads
    // no body and no cookie. The run happens inside the request, so the caller sees what it did.
    async postScheduledRun(request: Request): Promise<Response> {
      const secret = readWorkerSecret(request.headers.get("authorization"));
      if (!secret) return failure("worker_key_rejected");
      let current: WorkerRequestContext;
      try {
        current = await context();
      } catch {
        return failure("unavailable");
      }
      if (current.kind === "unconfigured") return failure("unconfigured");
      const result = await current.service.run({ secret });
      return result.kind === "finished" ? json(200, toScheduledRunResponse(result)) : failure(fromWorkerError[result.code]);
    },
  };
}
