import { createLibraryHandlers } from "@/features/library/presentation/library-handlers";
import { libraryContext } from "../../../_server/context";

// Woken collections run after the response within this limit, two at a time and none started after 40 s; the rest
// wake again on the next open.
export const maxDuration = 60;
export const POST = createLibraryHandlers(libraryContext).postMetadataWake;
