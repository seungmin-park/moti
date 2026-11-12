import { createLibraryHandlers } from "@/features/library/presentation/library-handlers";
import { libraryContext } from "../../_server/context";

// Collection runs after the response within this limit: a page fetch and a picture copy bounded to 40 s together,
// then a few database calls.
export const maxDuration = 60;
export const POST = createLibraryHandlers(libraryContext).postLink;
