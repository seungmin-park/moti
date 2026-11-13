import { describe, expect, it } from "vitest";
import { parseShareSecret, readShareSecret } from "./share-key";

const body = "AbcdEfghIjklMnopQrstUvwxYz0123456789-_AbCdE";
const secret = `moti_sk_${body}`;

describe("저장 키 형식", () => {
  it("moti_sk_ 뒤에 base64url 43자인 값만 키로 받는다", () => {
    expect(body).toHaveLength(43);
    expect(parseShareSecret(secret)).toBe(secret);
  });

  it.each([
    ["42자", `moti_sk_${body.slice(1)}`],
    ["44자", `moti_sk_${body}A`],
    ["+ 문자", `moti_sk_${body.slice(1)}+`],
    ["/ 문자", `moti_sk_${body.slice(1)}/`],
    ["= 채움", `moti_sk_${body.slice(1)}=`],
    ["앞 공백", ` ${secret}`],
    ["뒤 줄바꿈", `${secret}\n`],
    ["다른 접두사", `moti_pk_${body}`],
    ["대문자 접두사", `MOTI_SK_${body}`],
    ["빈 값", ""],
    ["숫자", 51],
    ["null", null],
    ["객체", { secret }],
  ])("%s: 키가 아니다", (_name, value) => {
    expect(parseShareSecret(value)).toBeNull();
  });
});

describe("Authorization 헤더", () => {
  it.each([`Bearer ${secret}`, `bearer ${secret}`, `BEARER ${secret}`])("%s 하나만 받는다", (header) => {
    expect(readShareSecret(header)).toBe(secret);
  });

  it.each([
    ["헤더 없음", null],
    ["Basic", `Basic ${secret}`],
    ["값 없는 Bearer", "Bearer "],
    ["Bearer만", "Bearer"],
    ["두 칸 띄움", `Bearer  ${secret}`],
    ["탭", `Bearer\t${secret}`],
    ["뒤에 붙은 값", `Bearer ${secret} extra`],
    ["쉼표로 이어진 두 헤더", `Bearer ${secret}, Bearer ${secret}`],
    ["쉼표로 이어진 값", `Bearer ${secret},x`],
    ["JWT", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"],
    ["쿠키 모양", `sb-auth-token=${secret}`],
    ["키만", secret],
  ])("%s: 거절한다", (_name, header) => {
    expect(readShareSecret(header)).toBeNull();
  });
});
