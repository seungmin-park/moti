import { describe, expect, it } from "vitest";
import { parseCollectionName } from "./collection-name";

describe("컬렉션 이름 규칙", () => {
  it("trim과 NFC 정규화를 적용한다", () => {
    expect(parseCollectionName(" 가방 ")).toEqual({ ok: true, name: "가방" });
    expect(parseCollectionName("é")).toEqual({ ok: true, name: "é" });
  });

  it("Unicode code point 40자까지 허용한다", () => {
    expect(parseCollectionName("🌱".repeat(40))).toEqual({ ok: true, name: "🌱".repeat(40) });
  });

  it.each([" ", "", "가".repeat(41)])("길이가 맞지 않는 이름 %j를 거절한다", (input) => {
    expect(parseCollectionName(input)).toEqual({ ok: false, message: "컬렉션 이름은 1~40자로 입력해 주세요." });
  });

  it.each([null, 1, "가\u0000", "가\uD800"])("문자열이 아니거나 깨진 이름 %j를 거절한다", (input) => {
    expect(parseCollectionName(input)).toEqual({ ok: false, message: "컬렉션 이름을 확인해 주세요." });
  });
});
