import { createServerClient } from "@supabase/ssr";
import type { DatabaseFixture } from "./database";
import { readDatabaseConfig } from "./database-config";

export type CookieJar = Map<string, string>;

export function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export async function signInCookies(user: DatabaseFixture["owner"]): Promise<CookieJar> {
  const config = readDatabaseConfig();
  const jar: CookieJar = new Map();
  const client = createServerClient(config.apiUrl, config.anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`테스트 세션을 만들지 못했습니다. ${error.message}`);
  if (jar.size === 0) throw new Error("테스트 세션 쿠키가 생성되지 않았습니다.");
  return jar;
}
