import { describe, expect, it } from "vitest";
import { cleanTitle, MAX_TITLE_LENGTH } from "./title";

describe("상품 이름 정리", () => {
  it("Given 줄바꿈과 겹친 공백 When 정리하면 Then 한 칸 공백의 한 줄 이름이 된다", () => {
    expect(cleanTitle("  무선\n\t 헤드폰   블랙 ")).toBe("무선 헤드폰 블랙");
  });

  it("Given 조합형 한글 When 정리하면 Then NFC로 저장한다", () => {
    const decomposed = "가방".normalize("NFD");
    expect(cleanTitle(decomposed)).toBe("가방");
    expect(cleanTitle(decomposed)!.length).toBe(2);
  });

  it("Given 제어 문자 When 정리하면 Then 제어 문자를 지운다", () => {
    expect(cleanTitle("램프\u0000\u0007 조명\u007f")).toBe("램프 조명");
  });

  it("Given 120자를 넘는 이름 When 정리하면 Then 코드 포인트 기준 120자로 자른다", () => {
    const emoji = "😀".repeat(130);
    const cleaned = cleanTitle(emoji)!;
    expect([...cleaned]).toHaveLength(MAX_TITLE_LENGTH);
    expect(cleaned.isWellFormed()).toBe(true);
  });

  it("Given 자른 끝이 공백 When 정리하면 Then 끝 공백을 남기지 않는다", () => {
    expect(cleanTitle(`${"가".repeat(119)} 나`)).toBe("가".repeat(119));
  });

  it.each(["", "   ", "\u0000\n"])("Given 비어 있는 이름 %j When 정리하면 Then 이름이 없다", (value) => {
    expect(cleanTitle(value)).toBeNull();
  });
});
