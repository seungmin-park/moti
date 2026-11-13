import { describe, expect, it } from "vitest";
import { ShareError, type ShareSecret } from "../domain/share-key";
import { toShareLinkAddCommand } from "./commands";

const secret = `moti_sk_${"A".repeat(43)}` as ShareSecret;

describe("공유한 링크 명령", () => {
  it("공유 메뉴의 링크를 소유자 저장과 같은 규칙으로 다듬고 옵션은 비운다", () => {
    expect(toShareLinkAddCommand(secret, "  https://www.shop.example/lamp?utm_source=share&b=2&a=1#white \n")).toEqual({
      secret,
      link: {
        sourceUrl: "https://www.shop.example/lamp?utm_source=share&b=2&a=1#white",
        identityUrl: "https://www.shop.example/lamp?a=1&b=2#white",
        option: "",
        shop: "shop.example",
      },
    });
  });

  it.each([
    ["javascript 링크", "javascript:alert(1)"],
    ["계정이 든 링크", "https://name:secret@shop.example/lamp"],
    ["링크가 아닌 글", "이 상품 어때요"],
    ["빈 글", ""],
    ["너무 긴 링크", `https://shop.example/${"x".repeat(4096)}`],
    ["문자열이 아닌 값", 42],
  ])("%s: invalid_input으로 거절한다", (_name, url) => {
    expect(() => toShareLinkAddCommand(secret, url)).toThrow(ShareError);
    try {
      toShareLinkAddCommand(secret, url);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });
});
