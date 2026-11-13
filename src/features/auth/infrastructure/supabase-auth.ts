import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient, isAuthApiError, isAuthSessionMissingError, type SupabaseClient, type User } from "@supabase/supabase-js";
import { z } from "zod";
import type { GoogleSession } from "../domain/access";

const environmentSchema = z.object({
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  SUPABASE_ANON_KEY: z.string().min(20),
  MOTI_OWNER_GOOGLE_SUBJECT: z.string().optional(),
});

export type AuthConfig = {
  supabaseUrl: string;
  supabaseKey: string;
  ownerSubject: string | undefined;
};

export function readAuthConfig(environment: Record<string, string | undefined>): AuthConfig | null {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) return null;
  return {
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseKey: parsed.data.SUPABASE_ANON_KEY,
    ownerSubject: parsed.data.MOTI_OWNER_GOOGLE_SUBJECT,
  };
}

export type CookieJar = {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
};

export function createSupabaseServerClient(config: AuthConfig, cookies: CookieJar): SupabaseClient {
  return createServerClient(config.supabaseUrl, config.supabaseKey, {
    cookies: {
      getAll: () => cookies.getAll(),
      setAll: (list) => {
        for (const { name, value, options } of list) cookies.set(name, value, options);
      },
    },
  });
}

function boundedFetch(requestTimeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

// For work that outlives the request: it cannot write cookies, so it cannot refresh and only uses this token.
// Every call is bounded because Storage uploads take no abort signal and a hung call would outlive the job's lease.
export function createAccessTokenClient(config: AuthConfig, accessToken: string,
  { requestTimeoutMs }: { requestTimeoutMs: number }): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    accessToken: async () => accessToken,
    global: { fetch: boundedFetch(requestTimeoutMs) },
  });
}

// For a request that carries no session, such as the share Shortcut's: it never reads or keeps one, so the database
// always sees anon.
export function createAnonymousClient(config: AuthConfig, { requestTimeoutMs }: { requestTimeoutMs: number }): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch(requestTimeoutMs) },
  });
}

// Call after readGoogleSession: that call validated the session and already refreshed an expiring token.
export async function readAccessToken(client: SupabaseClient): Promise<string | null> {
  const { data } = await client.auth.getSession();
  return data.session?.access_token ?? null;
}

export function toGoogleSession(user: User): GoogleSession {
  return {
    userId: user.id,
    googleSubjects: (user.identities ?? [])
      .filter((identity) => identity.provider === "google")
      .map((identity) => identity.id),
  };
}

export async function readGoogleSession(client: SupabaseClient): Promise<GoogleSession | null> {
  const { data, error } = await client.auth.getUser();
  if (error) {
    if (isAuthSessionMissingError(error)) return null;
    if (isAuthApiError(error) && error.status >= 400 && error.status < 500) return null;
    throw error;
  }
  return toGoogleSession(data.user);
}

export async function startGoogleLogin(client: SupabaseClient, redirectTo: string): Promise<string> {
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error || !data.url) throw error ?? new Error("Google 로그인 주소를 만들지 못했습니다.");
  return data.url;
}

export async function exchangeCode(client: SupabaseClient, code: string): Promise<GoogleSession> {
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data.user) throw error ?? new Error("로그인 code를 교환하지 못했습니다.");
  return toGoogleSession(data.user);
}

export async function signOut(client: SupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut();
  if (error) throw error;
}
