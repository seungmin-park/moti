import { isSameOrigin, publicUrl, redirect, redirectTo } from "../../shared/presentation/http";
import { decideAccess, type GoogleSession } from "../domain/access";
import { loginPath } from "./login-error";

export type AuthRequestContext = {
  ownerSubject: string | undefined;
  startGoogleLogin(redirectTo: string): Promise<string>;
  exchangeCode(code: string): Promise<GoogleSession>;
  signOut(): Promise<void>;
};

export function createAuthHandlers(context: (request: Request) => Promise<AuthRequestContext>) {
  return {
    async login(request: Request): Promise<Response> {
      try {
        const current = await context(request);
        if (decideAccess(null, current.ownerSubject).kind === "unconfigured") {
          return redirect(request, loginPath("unconfigured"));
        }
        return redirectTo(await current.startGoogleLogin(publicUrl(request, "/auth/callback")));
      } catch {
        return redirect(request, loginPath("unavailable"));
      }
    },

    async callback(request: Request): Promise<Response> {
      const params = new URL(request.url).searchParams;
      if (params.has("error")) return redirect(request, loginPath("cancelled"));
      const code = params.get("code");
      if (!code) return redirect(request, loginPath("callback"));
      let current: AuthRequestContext;
      let session: GoogleSession;
      try {
        current = await context(request);
        session = await current.exchangeCode(code);
      } catch {
        return redirect(request, loginPath("callback"));
      }
      const access = decideAccess(session, current.ownerSubject);
      if (access.kind === "allowed") return redirect(request, "/");
      await current.signOut().catch(() => undefined);
      return redirect(request, loginPath(access.kind === "unconfigured" ? "unconfigured" : "forbidden"));
    },

    async logout(request: Request): Promise<Response> {
      if (!isSameOrigin(request)) {
        return Response.json({ error: "cross_origin", message: "이 화면에서 보낸 요청이 아니에요." }, { status: 403 });
      }
      await context(request).then((current) => current.signOut()).catch(() => undefined);
      return redirect(request, loginPath());
    },
  };
}
