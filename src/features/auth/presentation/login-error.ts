export const loginErrorCodes = ["unconfigured", "unavailable", "cancelled", "callback", "forbidden"] as const;
export type LoginErrorCode = (typeof loginErrorCodes)[number];

export function isLoginErrorCode(value: string): value is LoginErrorCode {
  return (loginErrorCodes as readonly string[]).includes(value);
}

export function loginPath(code?: LoginErrorCode): string {
  return code ? `/login?error=${code}` : "/login";
}
