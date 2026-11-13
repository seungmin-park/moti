import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import pg from "pg";
import { databaseConfigSchema, HTTP_APP_PORT, HTTP_OWNER_SUBJECT } from "../tests/support/database-config.ts";
import { executeUntilClosed, withTermination } from "./process-lifecycle.mjs";
import { assertBrowserReport, assertDatabaseReport, assertHttpReport } from "./assert-test-report.mjs";
import { readNativeTestState } from "./native-test-state.mjs";

const root = resolve(import.meta.dirname, "..");
const lock = join(root, ".test-database.lock");
const cli = join(root, "node_modules/supabase/dist/supabase.js");
const runId = randomUUID();
let directory;
let environment;
let stack;
let project;
let started = false;
let app;

async function supabase(args, signal) {
  return executeUntilClosed(process.execPath, [cli, ...args, "--workdir", project, "--stack", stack], {
    env: environment,
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
    signal,
  });
}

function safeFailure(error) {
  return String(error.stderr || error.message || error).split("\n")
    .filter((line) => !/secret|password|service.?role|anon.?key|publishable.?key|postgres(?:ql)?:|eyJ[A-Za-z0-9_-]{15}/i.test(line))
    .slice(-12).join("\n");
}

await mkdir(lock).catch((error) => {
  if (error.code === "EEXIST") throw new Error("다른 DB 검증이 실행 중입니다. 해당 실행이 끝난 뒤 다시 시작하세요.");
  throw error;
});

process.exitCode = await withTermination(async (signal) => {
  try {
    directory = await realpath(await mkdtemp(join(tmpdir(), "moti-database-")));
    project = join(directory, "project");
    stack = basename(directory);
    const supabaseHome = join(directory, "supabase-home");
    environment = { ...process.env, SUPABASE_HOME: supabaseHome, SUPABASE_TELEMETRY_DISABLED: "true" };
    await mkdir(join(project, "supabase"), { recursive: true });
    for (const file of ["config.toml", "supabase.lock", "migrations"]) {
      await cp(join(root, "supabase", file), join(project, "supabase", file), { recursive: true });
    }
    console.log("Starting an isolated native Supabase database with committed migrations.");
    started = true;
    await supabase(["start", "--runtime", "native", "--eager", "--frozen", "--exclude", "realtime,functions,studio,mail,analytics,pooler"], signal);
    const state = await readNativeTestState(supabaseHome, project, stack);
    const connection = databaseConfigSchema.parse({
      runId,
      apiUrl: "http://127.0.0.1:56321",
      appUrl: `http://127.0.0.1:${HTTP_APP_PORT}/`,
      databaseUrl: `postgresql://postgres:${encodeURIComponent(state.credentials.databasePassword)}@127.0.0.1:56322/postgres`,
      anonKey: state.credentials.anonKey,
      serviceRoleKey: state.credentials.serviceRoleKey,
    });
    const database = new pg.Client({ connectionString: connection.databaseUrl, connectionTimeoutMillis: 10000 });
    try {
      await database.connect();
      await database.query("create schema moti_test; create table moti_test.run (id uuid primary key)");
      await database.query("insert into moti_test.run (id) values ($1)", [runId]);
    } finally {
      await database.end();
    }
    const file = join(directory, "connection.json");
    await writeFile(file, JSON.stringify(connection), { mode: 0o600 });
    const testEnvironment = { ...environment, MOTI_TEST_DATABASE_CONFIG: file, MOTI_TEST_DATABASE_RUN: runId };
    const vitest = async (name, files) => {
      const report = join(directory, `${name}-results.json`);
      const exitCode = await new Promise((resolveExit, reject) => {
        const child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config",
          "vitest.database.config.ts", "--reporter=default", "--reporter=json", `--outputFile=${report}`, ...files], {
          cwd: root, stdio: "inherit", signal, env: testEnvironment,
        });
        child.on("error", (error) => { if (!signal.aborted) reject(error); });
        child.on("close", (code) => resolveExit(code ?? 1));
      });
      return { exitCode, report: exitCode === 0 ? JSON.parse(await readFile(report, "utf8")) : null };
    };

    console.log("Running persistence and service checks against real PostgREST, Storage and PostgreSQL without Next.");
    const slice = await vitest("database", ["tests/persistence", "tests/service", ...process.argv.slice(2)]);
    if (slice.exitCode !== 0) return slice.exitCode;
    const counts = assertDatabaseReport(slice.report);
    console.log(`Verified ${counts.persistence} persistence and ${counts.service} service tests with no skipped assertions.`);

    await access(join(root, ".next/BUILD_ID")).catch(() => {
      throw new Error("HTTP 검사에는 빌드 결과가 필요합니다. npm run build 후 다시 실행하세요.");
    });
    console.log(`Starting the built app on 127.0.0.1:${HTTP_APP_PORT} against the isolated Supabase stack.`);
    app = await startApp(connection);
    const http = await vitest("http", ["tests/http"]);
    if (http.exitCode !== 0) return http.exitCode;
    console.log(`Verified ${assertHttpReport(http.report)} HTTP tests against the running app with no skipped assertions.`);

    console.log("Running browser checks on desktop Chromium and iPhone WebKit against the same app and stack.");
    const browserReport = join(directory, "browser-results.json");
    const browserExit = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [join(root, "node_modules/@playwright/test/cli.js"), "test",
        "--config", "playwright.database.config.ts"], {
        cwd: root, stdio: "inherit", signal, env: { ...testEnvironment, MOTI_BROWSER_REPORT: browserReport },
      });
      child.on("error", (error) => { if (!signal.aborted) reject(error); });
      child.on("close", (code) => resolveExit(code ?? 1));
    });
    if (browserExit !== 0) return 1;
    const browser = assertBrowserReport(JSON.parse(await readFile(browserReport, "utf8")));
    console.log(`Verified ${browser} browser tests against the running app with no skipped assertions.`);
    return 0;
  } catch (error) {
    console.error(safeFailure(error));
    return 1;
  }
}, async () => {
  if (app) await stopApp(app);
  let stopped = !started;
  let stopError;
  if (started) {
    try {
      await supabase(["stop"]);
      stopped = true;
    } catch (error) {
      stopError = new Error(`Owned test stack did not stop cleanly. ${safeFailure(error)}`);
    }
  }
  if (directory && stopped) await rm(directory, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
  if (stopError) throw stopError;
});

async function startApp(connection) {
  const child = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start",
    "--hostname", "127.0.0.1", "--port", String(HTTP_APP_PORT)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      SUPABASE_URL: connection.apiUrl,
      SUPABASE_ANON_KEY: connection.anonKey,
      MOTI_OWNER_GOOGLE_SUBJECT: HTTP_OWNER_SUBJECT,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
  const exited = new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const code = await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 250, "waiting"))]);
    if (code !== "waiting") throw new Error(`테스트 앱이 시작 중 종료됐습니다 (${code}). 포트 ${HTTP_APP_PORT} 사용 여부를 확인하세요.\n${output}`);
    const ready = await fetch(`http://127.0.0.1:${HTTP_APP_PORT}/api/library`).then(() => true, () => false);
    if (ready) return child;
  }
  await stopApp(child);
  throw new Error(`테스트 앱이 60초 안에 응답하지 않았습니다.\n${output}`);
}

async function stopApp(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  await exited;
  clearTimeout(timer);
}
