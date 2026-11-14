import { describe, expect, it } from "vitest";
import type { ShareKeyResponse } from "../../share/presentation/share-dto";
import { shareConfirmView, shareKeyView, shareWithoutShortcuts, shortcutSteps } from "./share-view";

describe("단축어 만들기 안내", () => {
  it("Given 실제 iPhone에서 동작한 구성 When 안내를 보이면 Then 받을 항목·입력이 없을 때·요청 하나·알림을 그 순서로 말한다", () => {
    expect(shortcutSteps).toHaveLength(5);
    const [receive, fallback, request, notify, key] = shortcutSteps;
    for (const item of ["맨 위", "입력 받기", "URL", "Safari 웹 페이지", "텍스트", "ⓘ", "‘공유 시트에서 보기’"]) expect(receive).toContain(item);
    // iOS keeps the input types and the no-input choice in the editor's top receive block, not in the ⓘ details.
    for (const item of ["맨 위", "‘입력이 없는 경우: 계속하기’", "‘계속하기’", "‘클립보드 가져오기’"]) expect(fallback).toContain(item);
    expect(fallback).not.toContain("같은 곳");
    for (const item of ["‘URL 콘텐츠 가져오기’", "POST", "Authorization", "JSON", "url", "‘단축어 입력’"]) expect(request).toContain(item);
    expect(notify).toContain("‘사전 값 가져오기’");
    expect(notify).toContain("message");
    expect(notify).toContain("‘알림 보기’");
    expect(key).toContain("저장 키");
  });

  it("Given 기기에서 빈 값을 보낸 동작 When 안내를 보이면 Then 그 동작을 넣으라고 하지 않는다", () => {
    const all = shortcutSteps.join("\n");
    expect(all).not.toContain("‘목록에서 항목 가져오기’");
    expect(all).not.toMatch(/‘입력에서 URL 가져오기’를 넣/);
  });

  it("Given 공유 메뉴에 단축어가 없는 앱 When 안내를 보이면 Then 링크를 복사하고 홈 화면이나 위젯에서 실행하라고 한다", () => {
    for (const item of ["네이버 앱", "복사", "홈 화면", "위젯", "‘moti에 담기’"]) expect(shareWithoutShortcuts).toContain(item);
  });
});

const key: ShareKeyResponse = {
  id: "55555555-5555-4555-8555-555555555555",
  hint: "a1B2",
  createdAt: "2026-11-13T05:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};
const forbidden = /연결됨|연결 완료|설치 완료|설치됨/;

describe("저장 키 표시", () => {
  it("Given 키 없음 When 보이면 Then 단축어를 먼저 만들고 키는 마지막에 만들라고 안내한다", () => {
    expect(shareKeyView(null)).toEqual({
      title: "아직 저장 키가 없어요.",
      detail: "단축어를 먼저 만들고, 마지막에 키를 만들어 붙여 넣으세요.",
    });
  });

  it("Given 아직 쓰지 않은 활성 키 When 보이면 Then 끝 네 글자와 만든 날, 아직 쓴 적이 없다는 것만 보여준다", () => {
    expect(shareKeyView(key)).toEqual({ title: "저장 키 ••••a1B2 · 11월 13일 만듦", detail: "아직 이 키를 쓴 적이 없어요." });
  });

  it("Given 단축어가 쓴 키 When 보이면 Then 서울 시각으로 마지막으로 쓴 때를 보여준다", () => {
    expect(shareKeyView({ ...key, lastUsedAt: "2026-11-13T05:04:00.000Z" }).detail).toBe("마지막으로 이 키를 쓴 때: 11월 13일 오후 2:04");
  });

  it("Given 폐기한 키 When 보이면 Then 언제 폐기했고 그 키로는 담을 수 없다고 알린다", () => {
    expect(shareKeyView({ ...key, revokedAt: "2026-11-14T15:30:00.000Z" })).toEqual({
      title: "이전 키(••••a1B2)는 11월 15일에 폐기했어요.",
      detail: "그 키를 넣은 단축어로는 더 이상 담을 수 없어요.",
    });
  });

  it("Given 바꾸기와 폐기 확인 When 보이면 Then 무엇이 폐기되는지 말한다", () => {
    expect(shareConfirmView("rotate", key)).toEqual({
      message: "새 키를 만들면 지금 키(••••a1B2)는 바로 폐기돼요. 단축어에도 새 키를 넣어야 해요.",
      action: "새 키로 바꾸기",
    });
    expect(shareConfirmView("revoke", key)).toEqual({
      message: "키를 폐기하면 이 키를 넣은 단축어로는 더 이상 담을 수 없어요.",
      action: "키 폐기",
    });
  });

  it("Given 모든 키 상태 When 보이면 Then 연결이나 설치가 끝났다고 말하지 않는다", () => {
    const states = [null, key, { ...key, lastUsedAt: "2026-11-13T05:04:00.000Z" }, { ...key, revokedAt: "2026-11-13T06:00:00.000Z" }];
    for (const state of states) {
      const { title, detail } = shareKeyView(state);
      expect(`${title} ${detail}`).not.toMatch(forbidden);
    }
    for (const confirm of ["rotate", "revoke"] as const) expect(shareConfirmView(confirm, key).message).not.toMatch(forbidden);
  });
});
