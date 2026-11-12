import { createLibraryHandlers } from "@/features/library/presentation/library-handlers";
import { libraryContext } from "../../_server/context";

// Collection runs after the response within this limit: one bounded page fetch plus a few database calls.
export const maxDuration = 30;
export const POST = createLibraryHandlers(libraryContext).postLink;
