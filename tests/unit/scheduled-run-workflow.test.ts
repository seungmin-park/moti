import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const workflowFile = new URL(".github/workflows/scheduled-run.yml", root);
// Read per test, so a missing workflow fails each check rather than the whole file.
const read = () => (existsSync(workflowFile) ? readFileSync(workflowFile, "utf8") : "");
const script = new URL("scripts/scheduled-run.sh", root).pathname;
const token = `moti_wk_${"AbcdEfghIjklMnopQrstUvwxYz0123456789-_AWk9_"}`;
const url = "https://moti.example";

describe("예약 실행 워크플로", () => {
  it("한국 시간 06:17·14:17·22:17에 예약하고 손으로도 실행할 수 있다", () => {
    const workflow = read();
    const crons = [...workflow.matchAll(/cron: "(\d+) (\d+) \* \* \*"/g)].map(([, minute, hour]) => {
      const kst = (Number(hour) + 9) % 24;
      return `${String(kst).padStart(2, "0")}:${minute.padStart(2, "0")}`;
    });
    expect(crons).toEqual(["06:17", "14:17", "22:17"]);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it("PR·push로는 실행하지 않고 저장소를 읽기만 하며 몇 분 안에 끝난다", () => {
    const workflow = read();
    const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(triggers.match(/^ {2}[a-z_]+:/gm)).toEqual(["  schedule:", "  workflow_dispatch:"]);
    expect(workflow.replace(/#.*$/gm, "")).not.toMatch(/pull_request|push/);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    const minutes = Number(/timeout-minutes: (\d+)/.exec(workflow)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(5);
    expect(workflow).toMatch(/persist-credentials: false/);
  });

  it("키와 주소는 환경 변수로만 스크립트에 넘긴다", () => {
    const workflow = read();
    expect(workflow.match(/\$\{\{[^}]*\}\}/g)).toEqual(["${{ vars.MOTI_WORKER_URL }}", "${{ secrets.MOTI_WORKER_TOKEN }}"]);
    expect(workflow).toMatch(/ {10}MOTI_WORKER_URL: \$\{\{ vars\.MOTI_WORKER_URL \}\}\n {10}MOTI_WORKER_TOKEN: \$\{\{ secrets\.MOTI_WORKER_TOKEN \}\}/);
    expect(workflow).toMatch(/- run: scripts\/scheduled-run\.sh\n/);
  });
});

// A stand-in curl first on PATH: it records its arguments and stdin, writes the canned body and prints the status.
let stub: string;
beforeEach(() => {
  stub = mkdtempSync(join(tmpdir(), "moti-curl-"));
  writeFileSync(join(stub, "curl"), `#!/usr/bin/env bash
out=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [[ "\${args[$i]}" == "--output" ]]; then out="\${args[$((i + 1))]}"; fi
done
printf '%s\\n' "$@" > "$STUB_DIR/argv"
cat > "$STUB_DIR/stdin"
printf '%s' "$STUB_BODY" > "$out"
printf '%s' "$STUB_STATUS"
exit "\${STUB_EXIT:-0}"
`);
  chmodSync(join(stub, "curl"), 0o755);
});
afterEach(() => rmSync(stub, { recursive: true, force: true }));

function call(env: Record<string, string>, answer: { status?: number; body?: unknown; exit?: number } = {}) {
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    // Only PATH and the stub's answers: no MOTI_ value leaks in from the shell that runs the tests.
    env: {
      NODE_ENV: "test",
      PATH: `${stub}:${process.env.PATH}`,
      STUB_DIR: stub,
      STUB_STATUS: String(answer.status ?? 200),
      STUB_BODY: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {}),
      STUB_EXIT: String(answer.exit ?? 0),
      ...env,
    },
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(stub, name), "utf8");
    } catch {
      return null;
    }
  };
  return { code: result.status, output: result.stdout + result.stderr, argv: read("argv"), stdin: read("stdin") };
}

const configured = { MOTI_WORKER_URL: url, MOTI_WORKER_TOKEN: token };
const finished = {
  stop: "done", collections: { collected: 2, failed: 1 }, prices: { confirmed: 0, kept: 0 }, failures: { timeout: 1 },
};

describe("예약 실행 스크립트", () => {
  it.each([
    ["둘 다 없음", {}],
    ["주소만 있음", { MOTI_WORKER_URL: url }],
    ["키만 있음", { MOTI_WORKER_TOKEN: token }],
  ])("Given %s When 실행하면 Then 알림만 남기고 성공으로 끝나며 moti를 부르지 않는다", (_name, env) => {
    const result = call(env);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/^::notice::.*건너뛰었어요/);
    expect(result.argv).toBeNull();
  });

  it.each([
    ["http 주소", { ...configured, MOTI_WORKER_URL: "http://moti.example" }],
    ["경로가 있는 주소", { ...configured, MOTI_WORKER_URL: "https://moti.example/api/scheduled-runs" }],
    ["공유 키", { ...configured, MOTI_WORKER_TOKEN: token.replace("moti_wk_", "moti_sk_") }],
  ])("Given %s When 실행하면 Then 오류로 끝나고 moti를 부르지 않는다", (_name, env) => {
    const result = call(env);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/^::error::/);
    expect(result.argv).toBeNull();
    expect(result.output).not.toContain(token);
  });

  it("Given 설정한 주소와 키 When 실행이 끝나면 Then 키는 표준 입력의 헤더로만 보내고 셈만 기록한다", () => {
    const result = call(configured, { status: 200, body: finished });
    expect(result.code).toBe(0);
    expect(result.output.trim()).toBe(`실행을 마쳤어요. ${JSON.stringify(finished)}`);
    expect(result.stdin).toBe(`Authorization: Bearer ${token}\n`);
    expect(result.argv).not.toContain(token);
    expect(result.argv?.split("\n")).toEqual(expect.arrayContaining([
      "--proto", "=https", "--max-time", "75", "--request", "POST", "--header", "@-", `${url}/api/scheduled-runs`,
    ]));
    expect(result.argv).not.toMatch(/--location|-L\b/);
  });

  it.each([
    [409, { error: "run_busy" }, 0, /^::notice::.*run_busy/],
    [429, { error: "run_limit" }, 0, /^::warning::/],
    [401, { error: "worker_key_rejected" }, 1, /^::error::작업 키가 맞지 않거나 폐기됐어요/],
    [503, { error: "unavailable" }, 1, /^::error::moti가 HTTP 503\(unavailable\)로 답했어요/],
    [502, "<html>bad gateway</html>", 1, /^::error::moti가 HTTP 502\(응답 없음\)로 답했어요/],
  ] as const)("Given HTTP %i When 실행하면 Then 정해진 문구로 알리고 409·429만 성공으로 끝낸다", (status, body, code, line) => {
    const result = call(configured, { status, body });
    expect(result.code).toBe(code);
    expect(result.output).toMatch(line);
    expect(result.output).not.toContain(token);
  });

  it("Given 서버가 워크플로 명령을 담아 답함 When 실행하면 Then 그 글자를 그대로 내보내지 않는다", () => {
    const result = call(configured, { status: 503, body: { error: "x\n::add-mask::y", message: "\n::set-env name=A::b" } });
    expect(result.code).toBe(1);
    expect(result.output).not.toMatch(/^::(add-mask|set-env)/m);
    expect(result.output).toMatch(/^::error::moti가 HTTP 503\(응답 없음\)로 답했어요/);
  });

  it("Given 연결 실패 When 실행하면 Then 오류로 끝나고 키를 남기지 않는다", () => {
    const result = call(configured, { status: 0, exit: 28 });
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/^::error::moti에 연결하지 못했어요/);
    expect(result.output).not.toContain(token);
  });
});
