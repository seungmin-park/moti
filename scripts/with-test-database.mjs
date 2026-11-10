import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import pg from "pg";
import { databaseConfigSchema } from "../tests/support/database-config.ts";
import { executeUntilClosed, withTermination } from "./process-lifecycle.mjs";
import { assertDatabaseReport } from "./assert-test-report.mjs";
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
    await supabase(["start", "--runtime", "native", "--eager", "--frozen", "--exclude", "realtime,storage,functions,studio,mail,analytics,pooler"], signal);
    const state = await readNativeTestState(supabaseHome, project, stack);
    const connection = databaseConfigSchema.parse({
      runId,
      apiUrl: "http://127.0.0.1:56321",
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
    const report = join(directory, "database-results.json");
    const childArgs = [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.database.config.ts",
      "--reporter=default", "--reporter=json", `--outputFile=${report}`, ...process.argv.slice(2)];
    console.log("Running persistence and service checks against real PostgREST and PostgreSQL.");
    const exitCode = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, childArgs, {
        cwd: root,
        stdio: "inherit",
        signal,
        env: { ...environment, MOTI_TEST_DATABASE_CONFIG: file, MOTI_TEST_DATABASE_RUN: runId },
      });
      child.on("error", (error) => { if (!signal.aborted) reject(error); });
      child.on("close", (code) => resolveExit(code ?? 1));
    });
    if (exitCode !== 0) return exitCode;
    const counts = assertDatabaseReport(JSON.parse(await readFile(report, "utf8")));
    console.log(`Verified ${counts.persistence} persistence and ${counts.service} service tests with no skipped assertions.`);
    return 0;
  } catch (error) {
    console.error(safeFailure(error));
    return 1;
  }
}, async () => {
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
