import { describe, expect, it } from "vitest";
import { collectionFieldKey } from "./collection-field-keys";

const key = (key: string, rest: { isComposing?: boolean; keyCode?: number } = {}) => ({ key, isComposing: false, keyCode: 0, ...rest });

describe("상세의 새 컬렉션 이름 칸 키", () => {
  it("Given 만들 수 있는 이름 칸 When Enter·Esc를 누르면 Then 만들고 닫는다", () => {
    expect(collectionFieldKey(key("Enter", { keyCode: 13 }), true)).toBe("create");
    expect(collectionFieldKey(key("Escape", { keyCode: 27 }), true)).toBe("cancel");
  });

  it("Given 만들기 버튼이 꺼진 이름 칸 When Enter를 누르면 Then 양식 제출만 막고 만들지 않는다", () => {
    expect(collectionFieldKey(key("Enter", { keyCode: 13 }), false)).toBe("hold");
    expect(collectionFieldKey(key("Escape", { keyCode: 27 }), false)).toBe("cancel");
  });

  it.each([
    ["isComposing", { isComposing: true, keyCode: 13 }],
    ["keyCode 229", { keyCode: 229 }],
  ])("Given 한글 조합 중(%s) When Enter·Esc를 누르면 Then 입력기에 맡긴다", (_, rest) => {
    for (const name of ["Enter", "Escape"]) expect(collectionFieldKey(key(name, rest), true)).toBeNull();
  });

  it("Given 이름 칸 When 다른 키를 누르면 Then 입력에 맡긴다", () => {
    expect(collectionFieldKey(key("a"), true)).toBeNull();
  });
});
