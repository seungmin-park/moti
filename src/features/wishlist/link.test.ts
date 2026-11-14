import { describe, expect, it } from "vitest";
import { parseLink } from "./link";
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

describe("앱 공유 링크의 추적 query", () => {
  const identityOf = (url: string) => {
    const parsed = parseLink(url, "");
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.link;
  };

  // The shape of the Musinsa app's short link after its redirect; the ids are made up.
  const appsFlyer =
    "https://www.musinsa.com/products/5016455?af_referrer_customer_id=AAA111&source_caller=sdk&af_force_deeplink=true" +
    "&shortlink=abc12345&af_dp=musinsa%3A%2F%2Fproducts&is_retargeting=true&af_channel=mobile_share&pid=af_app_invites" +
    "&af_referrer_uid=0000-1111&onelink_id=Xy12&af_siteid=999";

  it("무신사 앱 링크의 AppsFlyer query를 판별에서 빼서 Safari 주소와 같은 상품으로 본다", () => {
    const link = identityOf(appsFlyer);
    expect(link.sourceUrl).toBe(appsFlyer);
    expect(link.identityUrl).toBe("https://www.musinsa.com/products/5016455");
    expect(link.identityUrl).toBe(identityOf("https://www.musinsa.com/products/5016455").identityUrl);
  });

  it("네이버 스마트스토어의 검색 추적 query와 utm_*을 판별에서 빼고 상품 query는 남긴다", () => {
    const link = identityOf(
      "https://m.smartstore.naver.com/whatkey/products/13459235684?nl-query=%EC%A7%80%EC%98%A8&nl-au=0123abcd&NL-Query=x&utm_campaign=y&optionId=7",
    );
    expect(link.identityUrl).toBe("https://m.smartstore.naver.com/whatkey/products/13459235684?optionId=7");
  });

  it("pid는 AppsFlyer query와 함께 올 때만 추적 값으로 보고, 혼자 오면 상품을 가르는 값으로 남긴다", () => {
    expect(identityOf("https://shop.example/item?pid=af_app_invites&af_channel=share").identityUrl).toBe("https://shop.example/item");
    expect(identityOf("https://shop.example/item?pid=1234").identityUrl).toBe("https://shop.example/item?pid=1234");
    expect(identityOf("https://shop.example/item?pid=1234").identityUrl)
      .not.toBe(identityOf("https://shop.example/item?pid=5678").identityUrl);
  });

  it("추적 이름과 비슷하지만 다른 query는 남긴다", () => {
    expect(identityOf("https://shop.example/item?after=1&shortlinks=2&sourcecaller=3&nl=4").identityUrl)
      .toBe("https://shop.example/item?after=1&nl=4&shortlinks=2&sourcecaller=3");
  });

  it("화면에서 담을 때도 같은 판별을 써서 추적 query만 다른 링크를 이미 담은 상품으로 본다", () => {
    const original = save("https://www.musinsa.com/products/5016455");
    const again = save(appsFlyer, "", original);
    expect(again.feedback?.kind).toBe("duplicate");
    expect(again.products).toEqual(original.products);
  });
});
