import { describe, expect, it } from "vitest";
import { parseCollectionName, prepareSaveLink } from "./domain";

const collectionId = "ca47b10d-e052-4910-bdba-75ae5eb99620";
const validLink = {
  url: "https://example.com/item?size=M&utm_source=one#blue",
  option: " 가 ",
  collectionIds: [collectionId],
};

describe("저장 명령", () => {
  it("원문, 중복 판별 URL, NFC 옵션과 컬렉션을 한 명령에 담는다", () => {
    expect(prepareSaveLink(validLink)).toEqual({
      sourceUrl: "https://example.com/item?size=M&utm_source=one#blue",
      identityUrl: "https://example.com/item?size=M#blue",
      shop: "example.com",
      option: "가",
      collectionIds: [collectionId],
    });
  });

  it("같은 UUID의 대소문자와 반복 선택을 하나의 컬렉션으로 취급한다", () => {
    expect(prepareSaveLink({
      ...validLink,
      collectionIds: [collectionId.toUpperCase(), collectionId],
    }).collectionIds).toEqual([collectionId]);
  });

  it.each([null, [], "link", 1].map((input) => [input]))("객체가 아닌 입력 %s는 거절한다", (input) => {
    expect(() => prepareSaveLink(input)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it.each([
    { url: null, field: "url" },
    { url: "javascript:alert(1)", field: "url" },
    { option: 1, field: "option" },
    { option: "x".repeat(121), field: "option" },
    { collectionIds: "invalid", field: "collection" },
    { collectionIds: ["not-a-uuid"], field: "collection" },
    { collectionIds: [null], field: "collection" },
    { collectionIds: Array.from({ length: 101 }, () => collectionId), field: "collection" },
  ])("잘못된 $field 입력은 저장 전에 거절한다", ({ field, ...input }) => {
    expect(() => prepareSaveLink({ ...validLink, ...input })).toThrowError(
      expect.objectContaining({ code: "invalid_input", field }),
    );
  });

  it("컬렉션 없이 저장하는 명령을 허용한다", () => {
    expect(prepareSaveLink({ ...validLink, collectionIds: [] }).collectionIds)
      .toEqual([]);
  });
});

describe("컬렉션 이름", () => {
  it("trim과 NFC 정규화를 적용한다", () => {
    expect(parseCollectionName(" 가방 ")).toBe("가방");
  });

  it("Unicode code point 40자까지 허용한다", () => {
    expect(parseCollectionName("🌱".repeat(40))).toBe("🌱".repeat(40));
  });

  it.each([null, 1, " ", "가".repeat(41), "가\u0000", "가\uD800"])(
    "유효하지 않은 이름 %s를 거절한다",
    (input) => {
      expect(() => parseCollectionName(input)).toThrowError(
        expect.objectContaining({ code: "invalid_input", field: "collection" }),
      );
    },
  );
});
