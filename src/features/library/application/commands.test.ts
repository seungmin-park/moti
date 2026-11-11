import { describe, expect, it } from "vitest";
import { toCollectionCreateCommand, toLinkSaveCommand } from "./commands";

const collectionId = "ca47b10d-e052-4910-bdba-75ae5eb99620";
const validLink = {
  url: "https://example.com/item?size=M&utm_source=one#blue",
  option: " 가 ",
  collectionIds: [collectionId],
};

describe("저장 명령", () => {
  it("원문, 중복 판별 URL, NFC 옵션과 컬렉션을 한 명령에 담는다", () => {
    expect(toLinkSaveCommand(validLink)).toEqual({
      sourceUrl: "https://example.com/item?size=M&utm_source=one#blue",
      identityUrl: "https://example.com/item?size=M#blue",
      shop: "example.com",
      option: "가",
      collectionIds: [collectionId],
    });
  });

  it("같은 UUID의 대소문자와 반복 선택을 하나의 컬렉션으로 취급한다", () => {
    expect(toLinkSaveCommand({
      ...validLink,
      collectionIds: [collectionId.toUpperCase(), collectionId],
    }).collectionIds).toEqual([collectionId]);
  });

  it.each([null, [], "link", 1].map((input) => [input]))("객체가 아닌 입력 %s는 거절한다", (input) => {
    expect(() => toLinkSaveCommand(input)).toThrowError(
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
    expect(() => toLinkSaveCommand({ ...validLink, ...input })).toThrowError(
      expect.objectContaining({ code: "invalid_input", field }),
    );
  });

  it("컬렉션 없이 저장하는 명령을 허용한다", () => {
    expect(toLinkSaveCommand({ ...validLink, collectionIds: [] }).collectionIds)
      .toEqual([]);
  });
});

describe("컬렉션 생성 명령", () => {
  it("이름 규칙이 정리한 이름으로 명령을 만든다", () => {
    expect(toCollectionCreateCommand(" 가방 ")).toEqual({ name: "가방" });
  });

  it("이름 규칙이 거절한 입력은 컬렉션 필드의 입력 오류로 바꾼다", () => {
    expect(() => toCollectionCreateCommand(null)).toThrowError(
      expect.objectContaining({ code: "invalid_input", field: "collection", message: "컬렉션 이름을 확인해 주세요." }),
    );
    expect(() => toCollectionCreateCommand("가".repeat(41))).toThrowError(
      expect.objectContaining({ code: "invalid_input", field: "collection", message: "컬렉션 이름은 1~40자로 입력해 주세요." }),
    );
  });
});
