import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNativeTestState } from "../../scripts/native-test-state.mjs";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function nativeHome() {
  const home = mkdtempSync(join(tmpdir(), "moti-stack-state-"));
  folders.push(home);
  mkdirSync(join(home, "stacks", "test-stack"), { recursive: true });
  writeFileSync(join(home, "stacks", ".registry-lock.sqlite"), "native CLI registry");
  writeFileSync(join(home, "stacks", "test-stack", "state.json"), JSON.stringify({
    runtime: "native",
    identity: { projectRoot: "/test/project", stackName: "test-stack" },
    instances: [{ creation: { endpoints: { sql: { port: 56322 } } } }],
  }));
  return home;
}

describe("native Supabase 상태 읽기", () => {
  it("CLI registry 파일과 구분해 생성한 스택 디렉터리를 읽는다", async () => {
    await expect(readNativeTestState(nativeHome(), "/test/project", "test-stack"))
      .resolves.toMatchObject({ identity: { stackName: "test-stack" } });
  });

  it("다른 프로젝트나 스택의 상태는 사용하지 않는다", async () => {
    await expect(readNativeTestState(nativeHome(), "/production/project", "test-stack")).rejects.toThrow("테스트 구성과 다릅니다");
    await expect(readNativeTestState(nativeHome(), "/test/project", "other-stack")).rejects.toThrow("테스트 구성과 다릅니다");
  });
});
