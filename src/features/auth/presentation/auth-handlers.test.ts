import { describe, expect, it, vi } from "vitest";
import type { GoogleSession } from "../domain/access";
import { createAuthHandlers } from "./auth-handlers";

const origin = "https://moti.test";
const ownerSubject = "google-owner";
const googleAuthorizeUrl = "https://auth.moti.test/authorize?provider=google";

function given(options: { session?: GoogleSession | null; owner?: string | undefined } = {}) {
  const session = options.session ?? null;
  const owner = "owner" in options ? options.owner : ownerSubject;
  const exchangeCode = vi.fn(async (code: string) => {
    void code;
    if (!session) throw new Error("invalid code");
    return session;
  });
  const startGoogleLogin = vi.fn(async (redirectTo: string) => {
    void redirectTo;
    return googleAuthorizeUrl;
  });
  const signOut = vi.fn(async () => {});
  const handlers = createAuthHandlers(async () => ({ ownerSubject: owner, exchangeCode, startGoogleLogin, signOut }));
  return { handlers, exchangeCode, startGoogleLogin, signOut };
}

const location = (response: Response) => response.headers.get("location");
const callback = (query: string) => new Request(`${origin}/auth/callback${query}`);
const ownerSession: GoogleSession = { userId: "user-1", googleSubjects: [ownerSubject] };

describe("GET /auth/login", () => {
  it("Given 소유자 설정 When 로그인을 시작하면 Then 콜백 주소로 Google 인증에 303 이동한다", async () => {
    const { handlers, startGoogleLogin } = given();
    const response = await handlers.login(new Request(`${origin}/auth/login`));
    expect(response.status).toBe(303);
    expect(location(response)).toBe(googleAuthorizeUrl);
    expect(startGoogleLogin).toHaveBeenCalledWith(`${origin}/auth/callback`);
  });

  it("Given 소유자 설정 누락 When 로그인을 시작하면 Then Google로 보내지 않고 안내로 이동한다", async () => {
    const { handlers, startGoogleLogin } = given({ owner: undefined });
    const response = await handlers.login(new Request(`${origin}/auth/login`));
    expect(location(response)).toBe(`${origin}/login?error=unconfigured`);
    expect(startGoogleLogin).not.toHaveBeenCalled();
  });

  it("Given 인증 서버 장애 When 로그인을 시작하면 Then 사용 불가 안내로 이동한다", async () => {
    const { handlers, startGoogleLogin } = given();
    startGoogleLogin.mockRejectedValueOnce(new Error("down"));
    const response = await handlers.login(new Request(`${origin}/auth/login`));
    expect(location(response)).toBe(`${origin}/login?error=unavailable`);
  });
});

describe("GET /auth/callback", () => {
  it("Given 소유자 Google 계정 When 콜백을 받으면 Then 세션을 유지하고 보관함으로 이동한다", async () => {
    const { handlers, exchangeCode, signOut } = given({ session: ownerSession });
    const response = await handlers.callback(callback("?code=valid-code"));
    expect(response.status).toBe(303);
    expect(location(response)).toBe(`${origin}/`);
    expect(exchangeCode).toHaveBeenCalledWith("valid-code");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("Given 다른 Google 계정 When 콜백을 받으면 Then 방금 만든 세션을 종료하고 거절 안내로 이동한다", async () => {
    const { handlers, signOut } = given({ session: { userId: "user-2", googleSubjects: ["google-stranger"] } });
    const response = await handlers.callback(callback("?code=valid-code"));
    expect(location(response)).toBe(`${origin}/login?error=forbidden`);
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("Given Google identity가 없는 세션 When 콜백을 받으면 Then 세션을 종료하고 거절한다", async () => {
    const { handlers, signOut } = given({ session: { userId: "user-3", googleSubjects: [] } });
    const response = await handlers.callback(callback("?code=valid-code"));
    expect(location(response)).toBe(`${origin}/login?error=forbidden`);
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("Given 소유자 설정 누락 When 소유자 계정의 콜백을 받아도 Then 세션을 종료하고 설정 누락 안내로 이동한다", async () => {
    const { handlers, signOut } = given({ session: ownerSession, owner: "" });
    const response = await handlers.callback(callback("?code=valid-code"));
    expect(location(response)).toBe(`${origin}/login?error=unconfigured`);
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("Given code 없음 When 콜백을 받으면 Then 교환하지 않고 실패 안내로 이동한다", async () => {
    const { handlers, exchangeCode } = given({ session: ownerSession });
    const response = await handlers.callback(callback(""));
    expect(location(response)).toBe(`${origin}/login?error=callback`);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("Given 사용자가 Google 동의를 취소 When 콜백을 받으면 Then 교환하지 않고 취소 안내로 이동한다", async () => {
    const { handlers, exchangeCode } = given({ session: ownerSession });
    const response = await handlers.callback(callback("?error=access_denied&error_description=denied"));
    expect(location(response)).toBe(`${origin}/login?error=cancelled`);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("Given 만료되거나 위조된 code When 콜백을 받으면 Then 실패 안내로 이동한다", async () => {
    const { handlers, signOut } = given({ session: null });
    const response = await handlers.callback(callback("?code=forged"));
    expect(location(response)).toBe(`${origin}/login?error=callback`);
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("POST /auth/logout", () => {
  const logout = (headers: Record<string, string>) =>
    new Request(`${origin}/auth/logout`, { method: "POST", headers });

  it("Given 같은 출처 When 로그아웃하면 Then 세션을 종료하고 로그인 화면으로 이동한다", async () => {
    const { handlers, signOut } = given();
    const response = await handlers.logout(logout({ origin }));
    expect(response.status).toBe(303);
    expect(location(response)).toBe(`${origin}/login`);
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("Given 다른 출처 When 로그아웃을 요청하면 Then 403이고 세션을 종료하지 않는다", async () => {
    const { handlers, signOut } = given();
    const response = await handlers.logout(logout({ origin: "https://evil.test" }));
    expect(response.status).toBe(403);
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("POST /auth/logout 실패", () => {
  it("Given 인증 서버가 세션 폐기에 실패 When 로그아웃하면 Then 그래도 로그인 화면으로 이동한다", async () => {
    const { handlers, signOut } = given();
    signOut.mockRejectedValueOnce(new Error("auth down"));
    const response = await handlers.logout(new Request(`${origin}/auth/logout`, { method: "POST", headers: { origin } }));
    expect(response.status).toBe(303);
    expect(location(response)).toBe(`${origin}/login`);
  });
});

describe("배포 환경의 이동 주소", () => {
  it("Given 프록시가 공개 Host와 https를 전달 When 로그인을 시작하면 Then 공개 주소의 콜백으로 Google 인증을 요청한다", async () => {
    const { handlers, startGoogleLogin } = given();
    await handlers.login(new Request("http://localhost:3000/auth/login", {
      headers: { host: "localhost:3000", "x-forwarded-host": "moti.example.com", "x-forwarded-proto": "https" },
    }));
    expect(startGoogleLogin).toHaveBeenCalledWith("https://moti.example.com/auth/callback");
  });

  it("Given 서버 내부 URL과 브라우저 Host가 다름 When 콜백이 실패하면 Then 브라우저 Host로 이동한다", async () => {
    const { handlers } = given();
    const response = await handlers.callback(new Request("http://localhost:3000/auth/callback", {
      headers: { host: "127.0.0.1:3000" },
    }));
    expect(location(response)).toBe("http://127.0.0.1:3000/login?error=callback");
  });
});

describe("콜백의 세션 종료 실패", () => {
  it("Given 다른 Google 계정이고 세션 종료가 실패 When 콜백을 받으면 Then 그래도 거절 안내로 이동한다", async () => {
    const { handlers, signOut } = given({ session: { userId: "user-2", googleSubjects: ["google-stranger"] } });
    signOut.mockRejectedValueOnce(new Error("auth down"));
    const response = await handlers.callback(callback("?code=valid-code"));
    expect(location(response)).toBe(`${origin}/login?error=forbidden`);
  });
});
