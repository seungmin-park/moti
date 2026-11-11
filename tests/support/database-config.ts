import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const localUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "56321";
}, "테스트 전용 로컬 Supabase만 사용할 수 있습니다.");

// Below the OS ephemeral ranges and the ports the native Supabase stack picks at runtime; 56380 was already taken in CI.
export const HTTP_APP_PORT = 3180;
export const HTTP_OWNER_SUBJECT = "moti-http-owner";

const localApp = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === String(HTTP_APP_PORT) &&
    url.pathname === "/" && !url.search && !url.hash;
}, "테스트 전용 로컬 앱만 사용할 수 있습니다.");

const localDatabase = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "postgresql:" && url.hostname === "127.0.0.1" &&
      url.port === "56322" && url.username === "postgres" && url.pathname === "/postgres" &&
      !url.search && !url.hash;
  } catch {
    return false;
  }
}, "테스트 전용 로컬 PostgreSQL만 사용할 수 있습니다.");

export const databaseConfigSchema = z.object({
  runId: z.uuid(),
  apiUrl: localUrl,
  appUrl: localApp,
  databaseUrl: localDatabase,
  anonKey: z.string().min(20),
  serviceRoleKey: z.string().min(20),
}).strict();

export function readDatabaseConfig() {
  const file = process.env.MOTI_TEST_DATABASE_CONFIG;
  const runId = process.env.MOTI_TEST_DATABASE_RUN;
  if (!file || !runId) throw new Error("npm run test:database로 격리된 DB 테스트를 시작하세요.");
  const resolved = realpathSync(file);
  const folder = dirname(resolved);
  if (dirname(folder) !== realpathSync(tmpdir()) || !basename(folder).startsWith("moti-database-") ||
      resolved !== join(folder, "connection.json")) {
    throw new Error("테스트 실행기가 생성한 임시 연결 파일만 사용할 수 있습니다.");
  }
  const config = databaseConfigSchema.parse(JSON.parse(readFileSync(resolved, "utf8")));
  if (config.runId !== runId) throw new Error("DB 테스트 실행 식별자가 일치하지 않습니다.");
  return config;
}
