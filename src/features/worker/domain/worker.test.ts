import { describe, expect, it } from "vitest";
import { parseWorkerSecret, readWorkerSecret } from "./worker";

const body = "AbcdEfghIjklMnopQrstUvwxYz0123456789-_AbCdE";
const secret = `moti_wk_${body}`;

describe("작업 키 형식", () => {
  it("moti_wk_ 뒤에 base64url 43자인 값만 키로 받는다", () => {
    expect(body).toHaveLength(43);
    expect(parseWorkerSecret(secret)).toBe(secret);
  });

  it.each([
    ["공유 키", `moti_sk_${body}`],
    ["42자", `moti_wk_${body.slice(1)}`],
    ["44자", `moti_wk_${body}A`],
    ["+ 문자", `moti_wk_${body.slice(1)}+`],
    ["= 채움", `moti_wk_${body.slice(1)}=`],
    ["앞 공백", ` ${secret}`],
    ["뒤 줄바꿈", `${secret}\n`],
    ["대문자 접두사", `MOTI_WK_${body}`],
    ["빈 값", ""],
    ["숫자", 51],
    ["null", null],
  ])("%s: 작업 키가 아니다", (_name, value) => {
    expect(parseWorkerSecret(value)).toBeNull();
  });
});

describe("작업 경로의 Authorization 헤더", () => {
  it.each([`Bearer ${secret}`, `bearer ${secret}`])("%s 하나만 받는다", (header) => {
    expect(readWorkerSecret(header)).toBe(secret);
  });

  it.each([
    ["헤더 없음", null],
    ["공유 키", `Bearer moti_sk_${body}`],
    ["Basic", `Basic ${secret}`],
    ["값 없는 Bearer", "Bearer "],
    ["접두사 없음", secret],
    ["두 값을 쉼표로 이음", `Bearer ${secret}, Bearer ${secret}`],
    ["키 뒤의 공백과 다른 값", `Bearer ${secret} extra`],
    ["Bearer 뒤 두 칸", `Bearer  ${secret}`],
  ])("%s: 거절한다", (_name, header) => {
    expect(readWorkerSecret(header)).toBeNull();
  });
});
