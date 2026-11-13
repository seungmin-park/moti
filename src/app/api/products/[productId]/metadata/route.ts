import { createLibraryHandlers } from "@/features/library/presentation/library-handlers";
import { libraryContext } from "../../../../_server/context";

// Collection runs after the response within this limit. Its bounded steps can add up to more (see the runner); a run
// cut here leaves a stalled job that the owner retries, with nothing saved lost.
export const maxDuration = 60;
export const POST = createLibraryHandlers(libraryContext).postMetadataRetry;
