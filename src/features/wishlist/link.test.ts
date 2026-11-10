import { describe, expect, it } from "vitest";
import { reduceSession, type Session } from "./model";

const empty = (): Session => ({
  products: [],
  collections: [],
  nextId: 1,
  revision: 0,
  feedback: null,
  undo: null,
});

const save = (url: string, option = "", session = empty()) =>
  reduceSession(session, {
    type: "link.add",
    url,
    option,
    collectionIds: [],
    at: "2026-11-11T06:00:00.000Z",
  });

describe("공유 링크 규칙", () => {
  it("원문을 보존하고 추적 query만 중복 판별에서 제거한다", () => {
    const source =
      "https://WWW.Example.com/item?size=M&UTM_source=one&gclid=a&fbclid=b&msclkid=c#blue";
    const state = save(`  ${source}  `, "  가  ");

    expect(state.products[0]).toMatchObject({
      sourceUrl: source,
      identityUrl: "https://www.example.com/item?size=M#blue",
      option: "가",
      shop: "example.com",
    });
  });

  it("의미있는 fragment, 반복 옵션 query와 query 값을 보존한다", () => {
    const original = save(
      "https://example.com/item?variant=red&variant=blue&size=M#photo-2",
    );
    expect(original.products[0].identityUrl).toBe(
      "https://example.com/item?size=M&variant=red&variant=blue#photo-2",
    );
    const other = save(
      "https://example.com/item?variant=red&variant=blue&size=M#photo-3",
      "",
      original,
    );
    expect(other.products).toHaveLength(2);
  });

  it("NFC 옵션과 query 순서가 같은 재요청은 기존 원문을 보존한다", () => {
    const original = save("https://example.com/item?b=2&a=1&utm_source=x", "가");
    const duplicate = save("https://example.com/item?a=1&b=2", " 가 ", original);

    expect(duplicate.feedback?.kind).toBe("duplicate");
    expect(duplicate.products).toEqual(original.products);
  });

  it("정규화한 옵션 120자까지 저장하고 121자는 거절한다", () => {
    expect(save("https://example.com/item", ` ${"가".repeat(120)} `).products)
      .toHaveLength(1);

    const rejected = save("https://example.com/item", "가".repeat(121));
    expect(rejected.products).toEqual([]);
    expect(rejected.feedback).toMatchObject({ kind: "invalid", field: "option" });
  });

  it("Unicode code point 기준으로 옵션의 상한을 센다", () => {
    expect(save("https://example.com/item", "🌱".repeat(120)).products)
      .toHaveLength(1);
    expect(save("https://example.com/item", "🌱".repeat(121)).products)
      .toEqual([]);
  });

  it("원문 URL 4096자까지 저장하고 4097자는 거절한다", () => {
    const prefix = "https://example.com/";
    const boundary = `${prefix}${"x".repeat(4096 - prefix.length)}`;
    expect(save(boundary).products).toHaveLength(1);
    expect(save(`${boundary}x`).products).toEqual([]);
  });

  it.each([
    "https://example.com/line\nbreak",
    "https://example.com/null\u0000",
    "https://example.com/invalid\uD800",
  ])(
    "URL 내부 제어문자는 원문과 실제 URL의 불일치를 만들지 않게 거절한다: %s",
    (url) => {
      const state = save(url);
      expect(state.products).toEqual([]);
      expect(state.feedback).toMatchObject({ kind: "invalid", field: "url" });
    },
  );

  it.each(["블랙\u0000", "블랙\uD800"])(
    "PostgreSQL이 저장할 수 없는 옵션을 거절한다: %s",
    (option) => {
      const state = save("https://example.com/item", option);
      expect(state.products).toEqual([]);
      expect(state.feedback).toMatchObject({ kind: "invalid", field: "option" });
    },
  );
});
