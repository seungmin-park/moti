import type { ShareKeyResponse } from "../../share/presentation/share-dto";
import type { KeyConfirm } from "./key-panel-state";

const day = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" });
const moment = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const masked = (hint: string) => `••••${hint}`;

// The screen cannot know whether the Shortcut is installed, so it never says so. The time the key was last used (an
// add or an already-saved link) is the only evidence it shows, and it is labelled as exactly that.
export function shareKeyView(key: ShareKeyResponse | null): { title: string; detail: string } {
  if (key === null) {
    return { title: "아직 저장 키가 없어요.", detail: "단축어를 먼저 만들고, 마지막에 키를 만들어 붙여 넣으세요." };
  }
  if (key.revokedAt !== null) {
    return {
      title: `이전 키(${masked(key.hint)})는 ${day.format(new Date(key.revokedAt))}에 폐기했어요.`,
      detail: "그 키를 넣은 단축어로는 더 이상 담을 수 없어요.",
    };
  }
  return {
    title: `저장 키 ${masked(key.hint)} · ${day.format(new Date(key.createdAt))} 만듦`,
    detail: key.lastUsedAt === null
      ? "아직 이 키를 쓴 적이 없어요."
      : `마지막으로 이 키를 쓴 때: ${moment.format(new Date(key.lastUsedAt))}`,
  };
}

export function shareConfirmView(confirm: KeyConfirm, key: ShareKeyResponse): { message: string; action: string } {
  return confirm === "rotate"
    ? { message: `새 키를 만들면 지금 키(${masked(key.hint)})는 바로 폐기돼요. 단축어에도 새 키를 넣어야 해요.`, action: "새 키로 바꾸기" }
    : { message: "키를 폐기하면 이 키를 넣은 단축어로는 더 이상 담을 수 없어요.", action: "키 폐기" };
}
