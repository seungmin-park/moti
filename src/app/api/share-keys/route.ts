import { createLibraryHandlers } from "@/features/library/presentation/library-handlers";
import { libraryContext } from "../../_server/context";

const handlers = createLibraryHandlers(libraryContext);
export const GET = handlers.getShareKey;
export const POST = handlers.postShareKey;
