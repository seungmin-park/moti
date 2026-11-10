import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function readNativeTestState(home, project, stack) {
  const directory = join(home, "stacks");
  const states = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (states.length !== 1) throw new Error("테스트용 Supabase 스택이 하나여야 합니다.");
  const state = JSON.parse(await readFile(join(directory, states[0], "state.json"), "utf8"));
  if (state.runtime !== "native" || state.identity.projectRoot !== project || state.identity.stackName !== stack ||
      !state.instances.some((instance) => instance.creation.endpoints.sql?.port === 56322)) {
    throw new Error("생성된 Supabase 실행 환경이 테스트 구성과 다릅니다.");
  }
  return state;
}
