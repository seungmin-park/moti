import { describe, expect, it } from "vitest";
import { MAX_SHARED_TEXT_LENGTH, MAX_SHARED_TITLE_LENGTH, readSharedText } from "./shared-text";

// What the Coupang app handed the Shortcut on a real iPhone (2026-11-15).
const coupang = "쿠팡을 추천합니다!\n로투스 벨기에 와플 초코\nhttps://link.coupang.com/a/iGa1zKNs4a";

describe("공유한 글 읽기", () => {
  it("쿠팡 앱의 글에서 첫 링크와 그 바로 위 줄의 상품 이름을 읽는다", () => {
    expect(readSharedText(coupang)).toEqual({ url: "https://link.coupang.com/a/iGa1zKNs4a", title: "로투스 벨기에 와플 초코" });
  });

  it.each([
    ["Safari의 페이지 주소", "https://www.musinsa.com/products/7023777"],
    ["무신사 앱의 짧은 링크", "https://musinsa.onelink.me/PvkC/rez5hvvc"],
    ["앞뒤 공백과 줄바꿈", "  https://shop.example/lamp \n"],
  ])("%s는 링크 그대로이고 이름이 없다", (_name, value) => {
    expect(readSharedText(value)).toEqual({ url: value.trim(), title: null });
  });

  it("링크와 같은 줄의 앞 글을 가장 가까운 이름으로 읽는다", () => {
    expect(readSharedText("[무신사] 울 니트 블랙 https://www.musinsa.com/products/1")).toEqual({
      url: "https://www.musinsa.com/products/1",
      title: "[무신사] 울 니트 블랙",
    });
  });

  // Lines above the first link hold no link by definition, so "not itself a link" needs no separate rule.
  it("빈 줄은 건너뛰고 링크가 여럿이면 첫 링크와 그 위의 줄을 읽는다", () => {
    expect(readSharedText("머그컵 화이트\r\n\r\n  \r\nhttp://other.example/a\r\nhttps://shop.example/mug")).toEqual({
      url: "http://other.example/a",
      title: "머그컵 화이트",
    });
  });

  it("링크 뒤의 글은 이름도 링크도 아니다", () => {
    expect(readSharedText("https://shop.example/lamp\n조명 추천")).toEqual({ url: "https://shop.example/lamp", title: null });
    expect(readSharedText("보세요 https://shop.example/lamp 좋아요")).toEqual({ url: "https://shop.example/lamp", title: "보세요" });
  });

  it("문장 부호와 괄호로 끝나는 링크에서 링크에 속하지 않는 끝 글자를 뗀다", () => {
    expect(readSharedText("(https://shop.example/lamp).")?.url).toBe("https://shop.example/lamp");
    expect(readSharedText("“https://shop.example/lamp”")?.url).toBe("https://shop.example/lamp");
    expect(readSharedText("<https://shop.example/lamp>")?.url).toBe("https://shop.example/lamp");
    expect(readSharedText("https://shop.example/wiki/Lamp_(desk)")?.url).toBe("https://shop.example/wiki/Lamp_(desk)");
    expect(readSharedText("HTTPS://shop.example/lamp?x=1,")?.url).toBe("HTTPS://shop.example/lamp?x=1");
  });

  it("이름의 공백을 하나로 줄이고 제어 문자를 지우며 NFC로 맞춘다", () => {
    expect(readSharedText("  로투스\t와플\u0000  초코  \nhttps://shop.example/a")?.title).toBe("로투스 와플 초코");
    expect(readSharedText("한\nhttps://shop.example/a")?.title).toBe("한");
  });

  it(`이름은 ${MAX_SHARED_TITLE_LENGTH}자(code point)에서 자르고 끝 공백을 다시 뗀다`, () => {
    const long = `${"가".repeat(MAX_SHARED_TITLE_LENGTH - 1)} 나다라`;
    expect(readSharedText(`${long}\nhttps://shop.example/a`)?.title).toBe("가".repeat(MAX_SHARED_TITLE_LENGTH - 1));
    expect([...readSharedText(`${"🌱".repeat(200)}\nhttps://shop.example/a`)!.title!]).toHaveLength(MAX_SHARED_TITLE_LENGTH);
  });

  it.each([
    ["링크 없는 글", "쿠팡을 추천합니다!\n로투스 벨기에 와플 초코"],
    ["빈 글", ""],
    ["공백뿐인 글", " \n "],
    ["http(s)가 아닌 링크", "ftp://shop.example/a javascript:alert(1)"],
    ["짝이 없는 대리 문자", "\uD800 https://shop.example/a"],
    [`${MAX_SHARED_TEXT_LENGTH}자를 넘는 글`, `${"가".repeat(MAX_SHARED_TEXT_LENGTH)}\nhttps://shop.example/a`],
  ])("%s는 읽지 않는다", (_name, value) => {
    expect(readSharedText(value)).toBeNull();
  });

  it(`${MAX_SHARED_TEXT_LENGTH}자까지는 읽는다`, () => {
    const url = "https://shop.example/a";
    const text = `${"가".repeat(MAX_SHARED_TEXT_LENGTH - url.length - 1)}\n${url}`;
    expect(readSharedText(text)).toEqual({ url, title: "가".repeat(MAX_SHARED_TITLE_LENGTH) });
  });
});
