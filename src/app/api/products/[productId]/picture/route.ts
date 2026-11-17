import { createLibraryHandlers } from "@/features/library/presentation/library-handlers";
import { libraryContext } from "../../../../_server/context";

// A paste runs sharp (5 s) and four Storage or database calls of at most 10 s each inside the request.
export const maxDuration = 60;

const handlers = createLibraryHandlers(libraryContext);
export const GET = handlers.getPicture;
export const PUT = handlers.putPicture;
export const DELETE = handlers.deletePicture;
