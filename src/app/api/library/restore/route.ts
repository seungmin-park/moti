import { createLibraryHandlers } from "@/features/library/presentation/library-handlers";
import { libraryContext } from "../../../_server/context";

// Discarding replaced copies and collecting restored products run after the response within this limit; products not
// reached stall and keep the existing retry.
export const maxDuration = 60;
export const POST = createLibraryHandlers(libraryContext).postRestore;
