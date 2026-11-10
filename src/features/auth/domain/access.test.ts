import { describe, expect, it } from "vitest";
import { decideAccess, type GoogleSession } from "./access";

const owner: GoogleSession = { userId: "user-1", googleSubjects: ["google-123"] };

describe("Google 소유자 판정", () => {
  it("설정한 Google subject로 로그인한 사용자를 허용한다", () => {
    expect(decideAccess(owner, "google-123")).toEqual({ kind: "allowed", userId: "user-1" });
  });

  it("Google identity가 여러 개여도 소유자 subject가 있으면 허용한다", () => {
    expect(decideAccess({ ...owner, googleSubjects: ["google-999", "google-123"] }, "google-123"))
      .toEqual({ kind: "allowed", userId: "user-1" });
  });

  it("다른 Google 계정은 거절한다", () => {
    expect(decideAccess({ ...owner, googleSubjects: ["google-999"] }, "google-123")).toEqual({ kind: "forbidden" });
  });

  it("Google identity가 없는 사용자는 거절한다", () => {
    expect(decideAccess({ ...owner, googleSubjects: [] }, "google-123")).toEqual({ kind: "forbidden" });
  });

  it("subject의 앞뒤 공백이나 대소문자 차이를 같은 계정으로 보지 않는다", () => {
    expect(decideAccess({ ...owner, googleSubjects: ["Google-123"] }, "google-123")).toEqual({ kind: "forbidden" });
    expect(decideAccess({ ...owner, googleSubjects: [" google-123"] }, "google-123")).toEqual({ kind: "forbidden" });
  });

  it.each([undefined, "", "   "])("소유자 설정이 %j이면 로그인한 사용자도 허용하지 않는다", (subject) => {
    expect(decideAccess(owner, subject)).toEqual({ kind: "unconfigured" });
  });

  it("소유자 설정이 없으면 세션이 없어도 설정 누락으로 판정한다", () => {
    expect(decideAccess(null, undefined)).toEqual({ kind: "unconfigured" });
  });

  it("세션이 없으면 로그인 필요로 판정한다", () => {
    expect(decideAccess(null, "google-123")).toEqual({ kind: "signed_out" });
  });
});
