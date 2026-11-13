import { createWorkerHandlers } from "@/features/worker/presentation/worker-handlers";
import { workerContext } from "../../_server/worker-context";

// The run happens inside the request so GitHub sees its outcome; by its own budget it ends within 55 s.
export const maxDuration = 60;

// POST only. Next answers OPTIONS with Allow and nothing else, so no other site's page gets past a preflight.
export const POST = createWorkerHandlers(workerContext).postScheduledRun;
