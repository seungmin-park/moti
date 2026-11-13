import { decideOutcome, type CollectedPage, type PageReader, type PageSource } from "../../metadata/application/collection";
import type { CollectionErrorCode } from "../../metadata/domain/collection-error";
import { WorkerError, type WorkerErrorCode } from "../domain/worker";
import type { ScheduledRunCommand, ScheduledRunResult } from "./commands";
import type { WorkerItem, WorkerJob, WorkerRunLease, WorkerRunStore } from "./worker-store";

// One run fits the route's 60 s: begin (5 s), new items only in the first 20 s, the last item's page (15 s) between
// two steps (5 s each), then finish (5 s): 55 s at worst. Three lanes, at most 60 items.
export const RUN_LANES = 3;
export const RUN_START_WINDOW_MS = 20_000;
export const RUN_MAX_ITEMS = 60;

const codeOf = (error: unknown): WorkerErrorCode => (error instanceof WorkerError ? error.code : "storage_unavailable");
// The key or the run is gone: every lane stops, and the run is not finished, since finishing needs both.
const endsRun = (code: WorkerErrorCode) => code === "key_rejected" || code === "run_lost";

export function createScheduledRunService({ store, source, read, now }: {
  store: WorkerRunStore;
  source: PageSource;
  read: PageReader;
  now: () => number;
}) {
  async function pageOf(job: WorkerJob): Promise<CollectedPage | CollectionErrorCode> {
    const fetched = await source.read(job.sourceUrl);
    if (!fetched.ok) return fetched.code;
    const outcome = decideOutcome(read(fetched.page.html, fetched.page.url));
    return outcome.kind === "complete" ? outcome.page : outcome.code;
  }

  // Reads the page and settles the job. The worker never copies the picture: the owner's screen does.
  async function collect(lease: WorkerRunLease, job: WorkerJob): Promise<void> {
    let page: CollectedPage | CollectionErrorCode;
    try {
      page = await pageOf(job);
    } catch {
      page = "internal";
    }
    await (typeof page === "string" ? store.fail(lease, job, page) : store.complete(lease, job, page));
  }

  return {
    // Runs inside the request so the caller sees the outcome. It never throws: every failure becomes a refusal code.
    async run({ secret }: ScheduledRunCommand): Promise<ScheduledRunResult> {
      let lease: WorkerRunLease;
      try {
        lease = await store.begin(secret);
      } catch (error) {
        return { kind: "refused", code: codeOf(error) };
      }
      const deadline = now() + RUN_START_WINDOW_MS;
      // Shared by the lanes: slots taken toward the item cap, lanes that found nothing left, and why the run ended early.
      const shared: { started: number; drained: number; ended: WorkerErrorCode | null } = { started: 0, drained: 0, ended: null };

      // A lane ends when nothing is left, the window or the item cap is reached, the run ends, or two steps in a row
      // fail. An item whose step failed is left to its job lease, and a later run picks it up again.
      async function lane() {
        let failures = 0;
        const goesOn = (error: unknown) => {
          const code = codeOf(error);
          if (endsRun(code)) shared.ended = code;
          failures += 1;
          return shared.ended === null && failures < 2;
        };
        while (shared.ended === null && shared.started < RUN_MAX_ITEMS && now() < deadline) {
          shared.started += 1;
          let item: WorkerItem;
          try {
            item = await store.next(lease);
          } catch (error) {
            shared.started -= 1;
            if (goesOn(error)) continue;
            return;
          }
          if (item.kind === "none") {
            shared.started -= 1;
            shared.drained += 1;
            return;
          }
          try {
            await collect(lease, item.job);
            failures = 0;
          } catch (error) {
            if (!goesOn(error)) return;
          }
        }
      }

      await Promise.all(Array.from({ length: RUN_LANES }, lane));
      if (shared.ended !== null) return { kind: "refused", code: shared.ended };
      try {
        const counts = await store.finish(lease, shared.drained === RUN_LANES ? "done" : "deadline");
        return { kind: "finished", ...counts };
      } catch (error) {
        return { kind: "refused", code: codeOf(error) };
      }
    },
  };
}

export type ScheduledRunService = ReturnType<typeof createScheduledRunService>;
