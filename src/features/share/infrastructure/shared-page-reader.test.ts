import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotTextOf } from "../../../../tests/support/page-snapshot-dom";
import { decideOutcome } from "../../metadata/application/collection";
import { readProductPage } from "../../metadata/infrastructure/html-reader";
import type { PageSnapshot } from "../domain/page-snapshot";
import { createSharedPageReader } from "./shared-page-reader";

const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, "../../../../tests/fixtures/pages", `${name}.html`), "utf8");
// The script's JSON text as the route hands it on (the contract check is in the script's own test).
const snapshotOf = (html: string, href: string) => JSON.parse(snapshotTextOf(html, href)) as PageSnapshot;
const readShared = createSharedPageReader(readProductPage);
const href = "https://www.market.example/vp/products/7001?itemId=9001";

describe("Safari 단축어의 페이지 요약 읽기", () => {
  it("Given 상품 페이지의 요약 When 같은 호스트의 링크로 읽으면 Then 이름·하나뿐인 가격·사진 주소를 수집과 같은 규칙으로 얻는다", () => {
    expect(readShared(snapshotOf(fixture("safari-product"), href), "https://www.market.example/vp/products/7001")).toEqual({
      title: "로투스 비스코프 와플 초코 300g",
      price: { amountMinor: 12900, currency: "KRW" },
      imageSourceUrl: "https://img.market.example/thumbnails/7001/main.jpg",
    });
  });

  it.each(["offer", "aggregate-offer", "aggregate-range", "conflict", "graph", "meta-only", "several-products", "title-only", "twitter-only"])(
    "Given 수집 고정 페이지 %s When 요약해 읽으면 Then 서버가 그 페이지를 읽은 결과와 같다",
    (name) => {
      const pageUrl = "https://shop.example/p/item";
      const collected = decideOutcome(readProductPage(fixture(name), pageUrl));
      const shared = readShared(snapshotOf(fixture(name), pageUrl), pageUrl);
      expect(shared).toEqual(collected.kind === "complete" ? collected.page : null);
    },
  );

  it.each([
    ["다른 호스트의 페이지", "https://www.market.example/vp/products/7001", "https://evil.example/vp/products/7001"],
    ["하위 도메인이 다른 페이지", "https://www.market.example/vp/products/7001", "https://market.example/vp/products/7001"],
    ["너무 길어 주소를 비운 요약", "", "https://www.market.example/vp/products/7001"],
  ])("Given %s When 읽으면 Then 요약을 쓰지 않는다", (_name, pageUrl, link) => {
    const snapshot: PageSnapshot = { ...snapshotOf(fixture("safari-product"), href), url: pageUrl };
    expect(readShared(snapshot, link)).toBeNull();
  });

  it("Given 상품 정보가 없는 요약 When 읽으면 Then 쓰지 않아 서버 수집으로 넘어간다", () => {
    expect(readShared(snapshotOf(fixture("empty"), href), href)).toBeNull();
    expect(readShared({ url: href, title: "", canonical: "", metas: [], jsonLd: [] }, href)).toBeNull();
  });

  it("Given 받은 값이 태그를 닫으려 해도 When 읽으면 Then 글자 그대로의 이름으로만 읽는다", () => {
    const snapshot: PageSnapshot = {
      url: href,
      title: "제목",
      canonical: "",
      metas: [["og:title", "램프 \"</title><meta property=og:image content=https://evil.example/x.jpg>"]],
      jsonLd: [],
    };
    expect(readShared(snapshot, href)).toEqual({
      title: "램프 \"</title><meta property=og:image content=https://evil.example/x.jpg>",
      price: null,
      imageSourceUrl: null,
    });
  });
});
