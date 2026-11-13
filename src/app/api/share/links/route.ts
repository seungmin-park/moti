import { createShareHandlers } from "@/features/share/presentation/share-handlers";
import { shareContext } from "../../../_server/share-context";

// POST only. Next answers OPTIONS with Allow and nothing else, so no other site's page gets past a preflight.
export const POST = createShareHandlers(shareContext).postShareLink;
