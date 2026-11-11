import { describe, expect, it } from "vitest";
import { loginErrorCodes } from "../presentation/login-error";
import { loginNotice } from "./login-notice";

describe("로그인 안내", () => {
  it.each([
    ["forbidden", "이 Google 계정은 사용할 수 없어요", "moti는 지정한 계정 하나만 열 수 있어요. 방금 세션은 종료했어요."],
    ["unconfigured", "보관함 소유자 설정이 아직 없어요", "운영자가 허용할 계정을 설정한 뒤 로그인할 수 있어요."],
    ["unavailable", "로그인 서비스에 연결하지 못했어요", "잠시 뒤 다시 시도해 주세요."],
    ["cancelled", "Google 로그인이 완료되지 않았어요", "취소했거나 Google이 요청을 거절했어요. 다시 시도할 수 있어요."],
    ["callback", "로그인을 확인하지 못했어요", "처음부터 다시 로그인해 주세요."],
  ])("Given ?error=%s When 안내를 고르면 Then 원인에 맞는 제목과 설명을 보여준다", (code, title, detail) => {
    expect(loginNotice(code)).toEqual({ title, detail });
  });

  it("Given 모든 로그인 오류 코드 When 안내를 고르면 Then 각 코드가 서로 다른 안내를 가진다", () => {
    const titles = loginErrorCodes.map((code) => loginNotice(code)?.title);
    expect(new Set(titles).size).toBe(loginErrorCodes.length);
  });

  it("Given 알 수 없는 코드 When 안내를 고르면 Then 일반 실패 안내를 보여준다", () => {
    expect(loginNotice("token_expired")).toEqual({ title: "로그인을 완료하지 못했어요", detail: "다시 시도해 주세요." });
  });

  it("Given 오류 파라미터 없음 When 안내를 고르면 Then 안내가 없다", () => {
    expect(loginNotice(undefined)).toBeNull();
  });

  it("Given 같은 파라미터가 여러 번 When 안내를 고르면 Then 첫 값을 따른다", () => {
    expect(loginNotice(["forbidden", "cancelled"])?.title).toBe("이 Google 계정은 사용할 수 없어요");
  });

  it("Given 스크립트를 담은 값 When 안내를 고르면 Then 받은 값을 화면 문구에 옮기지 않는다", () => {
    const notice = loginNotice("<script>alert(1)</script>");
    expect(notice).not.toBeNull();
    expect(JSON.stringify(notice)).not.toContain("script");
  });
});
