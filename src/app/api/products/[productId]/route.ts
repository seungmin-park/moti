import { createLibraryHandlers } from "@/features/library/presentation/library-handlers";
import { libraryContext } from "../../../_server/context";

const handlers = createLibraryHandlers(libraryContext);

export const PATCH = handlers.patchProduct;
export const DELETE = handlers.deleteProduct;
