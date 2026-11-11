import { isLoginErrorCode, type LoginErrorCode } from "../presentation/login-error";

export type LoginNotice = { title: string; detail: string };

const notices: Record<LoginErrorCode, LoginNotice> = {
  forbidden: {
    title: "이 Google 계정은 사용할 수 없어요",
    detail: "moti는 지정한 계정 하나만 열 수 있어요. 방금 세션은 종료했어요.",
  },
  unconfigured: {
    title: "보관함 소유자 설정이 아직 없어요",
    detail: "운영자가 허용할 계정을 설정한 뒤 로그인할 수 있어요.",
  },
  unavailable: { title: "로그인 서비스에 연결하지 못했어요", detail: "잠시 뒤 다시 시도해 주세요." },
  cancelled: {
    title: "Google 로그인이 완료되지 않았어요",
    detail: "취소했거나 Google이 요청을 거절했어요. 다시 시도할 수 있어요.",
  },
  callback: { title: "로그인을 확인하지 못했어요", detail: "처음부터 다시 로그인해 주세요." },
};

const unknown: LoginNotice = { title: "로그인을 완료하지 못했어요", detail: "다시 시도해 주세요." };

export function loginNotice(value: string | string[] | undefined): LoginNotice | null {
  const code = Array.isArray(value) ? value[0] : value;
  if (code === undefined) return null;
  return isLoginErrorCode(code) ? notices[code] : unknown;
}
