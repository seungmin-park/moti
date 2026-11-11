import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pickSinglePrice } from "../domain/price";
import { readProductPage } from "./html-reader";

const pageUrl = "https://shop.example/p/item";
const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "../../../../tests/fixtures/pages", `${name}.html`), "utf8");
const read = (name: string) => readProductPage(fixture(name), pageUrl);
const jsonLd = (value: unknown) =>
  `<html><head><title>문서 제목</title><script type="application/ld+json">${JSON.stringify(value)}</script></head></html>`;

describe("상품 페이지 읽기", () => {
  it("Given JSON-LD Offer와 Open Graph When 읽으면 Then 구조화 데이터의 이름·가격과 페이지 기준으로 푼 og:image를 쓴다", () => {
    expect(read("offer")).toEqual({
      title: "무선 헤드폰 블랙",
      prices: [{ amount: "289000", currency: "KRW" }],
      imageUrl: "https://shop.example/images/headphones.jpg",
    });
  });

  it("Given 최저가와 최고가가 같은 AggregateOffer When 읽으면 Then 그 가격과 JSON-LD 첫 이미지를 쓴다", () => {
    expect(read("aggregate-offer")).toEqual({
      title: "책상 조명",
      prices: [{ amount: "59000", currency: "KRW" }],
      imageUrl: "https://shop.example/p/images/lamp-1.jpg",
    });
  });

  it("Given 가격 범위인 AggregateOffer When 읽으면 Then 가격 후보를 만들지 않는다", () => {
    expect(read("aggregate-range")).toEqual({ title: "사무용 의자", prices: [], imageUrl: null });
  });

  it("Given @graph 안의 URL 형식 @type과 priceSpecification When 읽으면 Then 상품을 찾는다", () => {
    expect(read("graph")).toEqual({
      title: "Desk Speaker",
      prices: [{ amount: "19.99", currency: "USD" }],
      imageUrl: "https://cdn.shop.example/speaker.png",
    });
  });

  it("Given 깨진 JSON-LD 블록과 정상 블록 When 읽으면 Then 깨진 블록만 건너뛴다", () => {
    expect(read("broken-json")).toEqual({
      title: "멀쩡한 가방",
      prices: [{ amount: "79,000", currency: "KRW" }],
      imageUrl: null,
    });
  });

  it("Given 이름이 다른 상품 여럿 When 읽으면 Then JSON-LD의 이름과 가격을 버리고 메타 정보만 쓴다", () => {
    expect(read("several-products")).toEqual({
      title: "이번 주 추천 상품",
      prices: [{ amount: "45000", currency: "KRW" }],
      imageUrl: null,
    });
  });

  it("Given 메타 태그만 있음 When 읽으면 Then og:title, og:price와 프로토콜 상대 이미지를 쓴다", () => {
    expect(read("meta-only")).toEqual({
      title: "러닝화 화이트 & 그레이",
      prices: [{ amount: "129000", currency: "KRW" }],
      imageUrl: "https://img.shop.example/shoes.jpg",
    });
  });

  it("Given JSON-LD와 메타 가격이 다름 When 고르면 Then 하나로 정하지 않는다", () => {
    const facts = read("conflict");
    expect(facts.title).toBe("카메라");
    expect(facts.prices).toEqual([
      { amount: "289000", currency: "KRW" },
      { amount: "259000", currency: "KRW" },
    ]);
    expect(pickSinglePrice(facts.prices)).toEqual({ kind: "ambiguous" });
  });

  it("Given 문서 제목만 있음 When 읽으면 Then 엔티티를 풀고 SVG 제목과 http가 아닌 이미지를 무시한다", () => {
    expect(read("title-only")).toEqual({ title: "Tea & Cup 세트", prices: [], imageUrl: null });
  });

  it("Given 빈 og:title과 twitter:title When 읽으면 Then 비어 있지 않은 다음 제목을 쓴다", () => {
    expect(read("twitter-only").title).toBe("트위터 제목만 있는 상품");
  });

  it("Given 상품 정보가 없는 문서 When 읽으면 Then 아무것도 지어내지 않는다", () => {
    expect(read("empty")).toEqual({ title: null, prices: [], imageUrl: null });
    expect(readProductPage("", pageUrl)).toEqual({ title: null, prices: [], imageUrl: null });
  });

  it("Given 여덟 단계보다 깊이 숨은 상품 When 읽으면 Then 찾지 않는다", () => {
    let nested: unknown = { "@type": "Product", name: "깊은 상품", offers: { price: "1000", priceCurrency: "KRW" } };
    for (let index = 0; index < 12; index += 1) nested = { wrapper: nested };
    expect(readProductPage(jsonLd(nested), pageUrl)).toEqual({ title: "문서 제목", prices: [], imageUrl: null });
  });

  it("Given 노드가 매우 많은 JSON-LD When 읽으면 Then 정해진 개수까지만 살핀다", () => {
    const filler = Array.from({ length: 6000 }, (_, index) => ({ "@type": "Thing", name: `n${index}` }));
    const page = jsonLd([...filler, { "@type": "Product", name: "끝의 상품" }]);
    expect(readProductPage(page, pageUrl).title).toBe("문서 제목");
  });

  it("Given 4096자를 넘는 이미지 주소 When 읽으면 Then 이미지를 쓰지 않는다", () => {
    const page = `<meta property="og:image" content="https://cdn.shop.example/${"a".repeat(4100)}.jpg"><title>긴 이미지</title>`;
    expect(readProductPage(page, pageUrl)).toEqual({ title: "긴 이미지", prices: [], imageUrl: null });
  });

  it.each([
    ["사용자와 비밀번호", "//u:p@cdn.shop.example/a.jpg"],
    ["사용자만", "https://u@cdn.shop.example/a.jpg"],
    ["비밀번호만", "https://:p@cdn.shop.example/a.jpg"],
  ])("Given 계정 정보(%s)가 든 og:image When 읽으면 Then 이미지만 버리고 이름과 가격은 쓴다", (_, image) => {
    const page = `<meta property="og:image" content="${image}"><meta property="og:title" content="램프">`
      + `<meta property="product:price:amount" content="59000"><meta property="product:price:currency" content="KRW">`;
    expect(readProductPage(page, pageUrl)).toEqual({
      title: "램프", prices: [{ amount: "59000", currency: "KRW" }], imageUrl: null,
    });
  });

  it("Given 계정 정보가 든 JSON-LD 이미지 When 읽으면 Then 이미지를 쓰지 않는다", () => {
    const page = jsonLd({ "@type": "Product", name: "램프", image: "https://u:p@cdn.shop.example/a.jpg" });
    expect(readProductPage(page, pageUrl)).toEqual({ title: "램프", prices: [], imageUrl: null });
  });
});
