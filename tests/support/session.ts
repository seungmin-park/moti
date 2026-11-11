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

const authToken = /^(sb-.+-auth-token)(?:\.(\d+))?$/;

function sessionCookie(jar: CookieJar) {
  const parts = [...jar].flatMap(([name, value]) => {
    const match = authToken.exec(name);
    return match ? [{ name, base: match[1], index: Number(match[2] ?? -1), value }] : [];
  }).sort((a, b) => a.index - b.index);
  if (parts.length === 0) throw new Error("인증 쿠키가 없습니다.");
  const encoded = parts.map((part) => part.value).join("");
  if (!encoded.startsWith("base64-")) throw new Error("예상한 인증 쿠키 형식이 아닙니다.");
  return { base: parts[0].base, names: parts.map((part) => part.name), encoded };
}

export function readSession(jar: CookieJar): { access_token: string; refresh_token: string; expires_at: number } {
  return JSON.parse(Buffer.from(sessionCookie(jar).encoded.slice("base64-".length), "base64url").toString("utf8"));
}

export function withExpiredAccessToken(jar: CookieJar): CookieJar {
  const { base, names } = sessionCookie(jar);
  const session = { ...readSession(jar), expires_at: Math.floor(Date.now() / 1000) - 60 };
  const expired: CookieJar = new Map([...jar].filter(([name]) => !names.includes(name)));
  expired.set(base, `base64-${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`);
  return expired;
}

export function updatedJar(jar: CookieJar, setCookies: string[]): CookieJar {
  const next: CookieJar = new Map(jar);
  for (const header of setCookies) {
    const [pair] = header.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!value || /max-age=0/i.test(header)) next.delete(name);
    else next.set(name, value);
  }
  return next;
}
