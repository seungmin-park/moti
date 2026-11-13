import { createLibraryHandlers } from "@/features/library/presentation/library-handlers";
import { libraryContext } from "../../../../_server/context";

export const GET = createLibraryHandlers(libraryContext).getPicture;
