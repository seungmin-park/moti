import { createAuthHandlers } from "@/features/auth/presentation/auth-handlers";
import { authContext } from "../../_server/context";

export const GET = createAuthHandlers(authContext).login;
