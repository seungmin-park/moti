import type { WorkerKeyResponse, WorkerRunResponse } from "../../worker/presentation/worker-dto";
import type { KeyConfirm } from "./key-panel-state";
import { collectionFailureReason } from "./product-view";

const day = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" });
const moment = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const masked = (hint: string) => `••••${hint}`;

// GitHub runs late or not at all at times, and nothing tells moti. A day of three runs plus two hours of slack.
export const SILENCE_MS = 26 * 60 * 60 * 1000;

// The screen cannot know whether GitHub is set up, so it never says so. The time the key last started a run is the only
// evidence it shows, and it is labelled as exactly that.
export function workerKeyView(key: WorkerKeyResponse | null): { title: string; detail: string } {
  if (key === null) {
    return { title: "아직 작업 키가 없어요.", detail: "키를 만들어 GitHub 저장소의 비밀값에 넣으면 예약 실행이 moti에 들어올 수 있어요." };
  }
  if (key.revokedAt !== null) {
    return {
      title: `이전 키(${masked(key.hint)})는 ${day.format(new Date(key.revokedAt))}에 폐기했어요.`,
      detail: "그 키로는 더 이상 실행할 수 없어요.",
    };
  }
  return {
    title: `작업 키 ${masked(key.hint)} · ${day.format(new Date(key.createdAt))} 만듦`,
    detail: key.lastUsedAt === null
      ? "아직 이 키로 실행한 적이 없어요."
      : `마지막으로 이 키로 실행을 시작한 때: ${moment.format(new Date(key.lastUsedAt))}`,
  };
}

export function workerConfirmView(confirm: KeyConfirm, key: WorkerKeyResponse): { message: string; action: string } {
  return confirm === "rotate"
    ? {
      message: `새 키를 만들면 지금 키(${masked(key.hint)})는 바로 폐기되고 진행 중인 실행도 멈춰요. GitHub 비밀값도 새 키로 바꿔야 해요.`,
      action: "새 키로 바꾸기",
    }
    : { message: "키를 폐기하면 예약 실행이 더 이상 moti에 들어오지 못하고, 진행 중인 실행도 멈춰요.", action: "키 폐기" };
}

const stateLines: Record<WorkerRunResponse["state"], string> = {
  running: "실행 중이에요.",
  done: "할 일을 모두 마쳤어요.",
  deadline: "남은 일은 다음 실행에서 이어가요.",
  cut: "끝까지 실행되지 못했어요.",
  revoked: "키를 폐기해 멈췄어요.",
};

export type WorkerRunView = { id: string; when: string; counts: string; state: string; failed: boolean; failures: string[] };

// One line per run: when, what it collected, how it stopped, and why items failed. Only `cut` reads as an error.
export function workerRunView(run: WorkerRunResponse): WorkerRunView {
  const { collected, failed } = run.collections;
  return {
    id: run.id,
    when: moment.format(new Date(run.startedAt)),
    counts: `수집 ${collected} · 실패 ${failed}`,
    state: stateLines[run.state],
    failed: run.state === "cut",
    failures: Object.entries(run.failures)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([code, count]) => `${collectionFailureReason(code as keyof typeof run.failures)} ${count}건`),
  };
}

// With an active key, a run should start at least once a day. Silence longer than that is the owner's only signal
// that GitHub stopped calling; it never claims the opposite.
export function workerSilence(key: WorkerKeyResponse | null, runs: WorkerRunResponse[], now: number): string | null {
  if (key === null || key.revokedAt !== null) return null;
  const since = Math.max(Date.parse(key.createdAt), ...runs.map((run) => Date.parse(run.startedAt)));
  return now - since > SILENCE_MS
    ? "26시간 넘게 실행 기록이 없어요. GitHub 예약 실행이 늦거나 멈췄을 수 있어요."
    : null;
}
