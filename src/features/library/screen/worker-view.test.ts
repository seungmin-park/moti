import { describe, expect, it } from "vitest";
import type { WorkerKeyResponse, WorkerRunResponse } from "../../worker/presentation/worker-dto";
import { SILENCE_MS, workerConfirmView, workerKeyView, workerRunView, workerSilence } from "./worker-view";

const key: WorkerKeyResponse = {
  id: "55555555-5555-4555-8555-555555555555",
  hint: "Wk9_",
  createdAt: "2026-11-13T05:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};
const run: WorkerRunResponse = {
  id: "66666666-6666-4666-8666-666666666666",
  startedAt: "2026-11-13T05:17:00.000Z",
  finishedAt: "2026-11-13T05:17:41.000Z",
  state: "done",
  collections: { collected: 3, failed: 2 },
  prices: { confirmed: 0, kept: 0 },
  failures: { timeout: 1, blocked_by_site: 1 },
};
const forbidden = /연결됨|연결 완료|설치 완료|설치됨|설정 완료/;

describe("작업 키 표시", () => {
  it("Given 키 없음 When 보이면 Then 키를 만들어 GitHub에 넣으라고 안내한다", () => {
    expect(workerKeyView(null)).toEqual({
      title: "아직 작업 키가 없어요.",
      detail: "키를 만들어 GitHub 저장소의 비밀값에 넣으면 예약 실행이 moti에 들어올 수 있어요.",
    });
  });

  it("Given 활성 키 When 보이면 Then 끝 네 글자와 만든 날, 이 키로 실행을 시작한 때만 증거로 보인다", () => {
    expect(workerKeyView(key)).toEqual({ title: "작업 키 ••••Wk9_ · 11월 13일 만듦", detail: "아직 이 키로 실행한 적이 없어요." });
    expect(workerKeyView({ ...key, lastUsedAt: "2026-11-13T05:17:00.000Z" }).detail).toBe("마지막으로 이 키로 실행을 시작한 때: 11월 13일 오후 2:17");
  });

  it("Given 폐기한 키 When 보이면 Then 언제 폐기했고 그 키로는 실행할 수 없다고 말한다", () => {
    expect(workerKeyView({ ...key, revokedAt: "2026-11-14T01:00:00.000Z" })).toEqual({
      title: "이전 키(••••Wk9_)는 11월 14일에 폐기했어요.",
      detail: "그 키로는 더 이상 실행할 수 없어요.",
    });
  });

  it("Given 바꾸기·폐기 확인 When 보이면 Then 진행 중인 실행도 멈추고 GitHub 비밀값을 바꿔야 한다고 말한다", () => {
    expect(workerConfirmView("rotate", key)).toEqual({
      message: "새 키를 만들면 지금 키(••••Wk9_)는 바로 폐기되고 진행 중인 실행도 멈춰요. GitHub 비밀값도 새 키로 바꿔야 해요.",
      action: "새 키로 바꾸기",
    });
    expect(workerConfirmView("revoke", key)).toEqual({
      message: "키를 폐기하면 예약 실행이 더 이상 moti에 들어오지 못하고, 진행 중인 실행도 멈춰요.",
      action: "키 폐기",
    });
  });
});

describe("최근 실행 표시", () => {
  it("Given 끝난 실행 When 보이면 Then 서울 시각, 수집·실패 셈, 멈춘 이유와 이유별 실패를 보인다", () => {
    expect(workerRunView(run)).toEqual({
      id: run.id,
      when: "11월 13일 오후 2:17",
      counts: "수집 3 · 실패 2",
      state: "할 일을 모두 마쳤어요.",
      failed: false,
      failures: ["1건 · 쇼핑몰이 자동 확인을 막았어요.", "1건 · 쇼핑몰이 제때 응답하지 않았어요."],
    });
  });

  it.each([
    ["running", "실행 중이에요.", false],
    ["deadline", "남은 일은 다음 실행에서 이어가요.", false],
    ["cut", "끝까지 실행되지 못했어요.", true],
    ["revoked", "키를 폐기해 멈췄어요.", false],
  ] as const)("Given %s 실행 When 보이면 Then %s이고 cut만 오류로 보인다", (state, line, failed) => {
    expect(workerRunView({ ...run, state })).toMatchObject({ state: line, failed });
  });

  it("Given 모든 표시 When 보이면 Then 연결·설치를 말하지 않는다", () => {
    const texts = [
      workerKeyView(null), workerKeyView(key), workerKeyView({ ...key, revokedAt: key.createdAt }),
      ...(["running", "done", "deadline", "cut", "revoked"] as const).map((state) => workerRunView({ ...run, state })),
    ];
    expect(JSON.stringify(texts)).not.toMatch(forbidden);
  });
});

describe("오래 실행이 없을 때", () => {
  const created = Date.parse(key.createdAt);

  it("Given 활성 키 When 키를 만든 뒤나 마지막 실행 뒤 26시간이 지나면 Then 늦거나 멈췄을 수 있다고 말한다", () => {
    expect(workerSilence(key, [], created + SILENCE_MS)).toBeNull();
    expect(workerSilence(key, [], created + SILENCE_MS + 1)).toBe("26시간 넘게 실행 기록이 없어요. GitHub 예약 실행이 늦거나 멈췄을 수 있어요.");
    expect(workerSilence(key, [run], Date.parse(run.startedAt) + SILENCE_MS - 1)).toBeNull();
  });

  it("Given 새 키를 막 만들었고 이전 키의 실행은 오래됨 When 보이면 Then 새 키의 만든 때부터 센다", () => {
    const old = { ...run, startedAt: "2026-11-10T05:17:00.000Z" };
    expect(workerSilence(key, [old], created + 60_000)).toBeNull();
  });

  it("Given 키가 없거나 폐기됨 When 보이면 Then 아무 말도 하지 않는다", () => {
    expect(workerSilence(null, [], created + 10 * SILENCE_MS)).toBeNull();
    expect(workerSilence({ ...key, revokedAt: key.createdAt }, [], created + 10 * SILENCE_MS)).toBeNull();
  });
});
