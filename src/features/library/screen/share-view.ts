import type { ShareKeyResponse } from "../../share/presentation/share-dto";
import type { KeyConfirm } from "./key-panel-state";

const day = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" });
const moment = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const masked = (hint: string) => `••••${hint}`;

// The Shortcut that worked on a real iPhone (2026-11-15). Shortcut Input goes to the server as is: the "Get URLs from
// Input → Get Item from List" chain sent empty values there, and the server finds the link in shared text itself.
export const shortcutSteps: readonly string[] = [
  "새 단축어 이름을 “moti에 담기”로 정하고, 세부 사항에서 ‘공유 시트에서 보기’를 켜요. 받을 항목은 URL, Safari 웹 페이지, 텍스트로 골라요.",
  "같은 곳에서 ‘입력이 없는 경우’를 ‘클립보드 가져오기’로 정해요. 복사해 둔 링크를 보낼 때 쓰여요.",
  "‘URL 콘텐츠 가져오기’ 하나만 넣고 아래 주소를 적어요. 방법은 POST, 헤더는 Authorization, 요청 본문은 JSON으로 키 url에 ‘단축어 입력’을 넣어요. ‘입력에서 URL 가져오기’는 넣지 않아요. 쇼핑 앱이 보낸 글에서 링크는 moti가 찾아요.",
  "‘사전 값 가져오기’로 message 값을 꺼내 ‘알림 보기’로 보여 줘요.",
  "마지막으로 오른쪽(휴대폰에서는 아래)의 저장 키를 만들어 Authorization 헤더 값에 붙여 넣어요.",
];
export const shareWithoutShortcuts =
  "공유 메뉴에 단축어가 없는 앱(예: 네이버 앱)에서는 링크를 복사한 뒤 홈 화면이나 위젯에서 ‘moti에 담기’를 실행해요.";

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
