import { describe, expect, it } from "vitest";
import { pageSnapshotHtml, snapshotMatchesLink, type PageSnapshot } from "./page-snapshot";

const snapshot = (overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: "https://shop.example/p/1",
  title: "램프",
  canonical: "",
  metas: [],
  jsonLd: [],
  ...overrides,
});

describe("받은 페이지 요약으로 만든 HTML", () => {
  it("Given 제목·메타·JSON-LD When 문서를 만들면 Then 받은 순서대로 head의 같은 자리에 둔다", () => {
    const html = pageSnapshotHtml(snapshot({
      canonical: "https://shop.example/p/1",
      metas: [["og:title", "첫 이름"], ["og:title", "둘째 이름"], ["product:price:amount", "1000"]],
      jsonLd: ["{\"@type\":\"Product\",\"name\":\"램프\"}"],
    }));

    expect(html).toBe([
      "<!doctype html><html><head>",
      "<title>램프</title>",
      "<link rel=\"canonical\" href=\"https://shop.example/p/1\">",
      "<meta property=\"og:title\" content=\"첫 이름\">",
      "<meta property=\"og:title\" content=\"둘째 이름\">",
      "<meta property=\"product:price:amount\" content=\"1000\">",
      "<script type=\"application/ld+json\">{\"@type\":\"Product\",\"name\":\"램프\"}</script>",
      "</head><body></body></html>",
    ].join(""));
  });

  it("Given 태그를 닫으려는 값 When 문서를 만들면 Then 모든 글자를 이스케이프해 받은 값이 새 요소를 만들지 못한다", () => {
    const html = pageSnapshotHtml(snapshot({
      title: "</title><script>alert(1)</script>&amp;",
      canonical: "\"><img src=x onerror=alert(1)>",
      metas: [["og:title\" content=\"x", "a\"b'c<d>e&f"]],
      jsonLd: ["{\"name\":\"</script><script>alert(1)</script>\",\"x\":\"<!--\"}"],
    }));

    expect(html).toContain("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;amp;</title>");
    expect(html).toContain("href=\"&quot;&gt;&lt;img src=x onerror=alert(1)&gt;\"");
    expect(html).toContain("<meta property=\"og:title&quot; content=&quot;x\" content=\"a&quot;b&#39;c&lt;d&gt;e&amp;f\">");
    // Inside a script only `<` can end it; JSON allows `<` only in strings, where \u003c means the same character.
    expect(html).toContain("<script type=\"application/ld+json\">{\"name\":\"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>\",\"x\":\"\\u003c!--\"}</script>");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<meta /g)).toHaveLength(1);
  });

  it("Given 비어 있는 요약 When 문서를 만들면 Then 제목만 있는 빈 head다", () => {
    expect(pageSnapshotHtml(snapshot({ title: "" }))).toBe("<!doctype html><html><head><title></title></head><body></body></html>");
  });
});

describe("요약한 페이지와 공유한 링크", () => {
  it.each([
    ["같은 주소", "https://www.coupang.com/vp/products/1", "https://www.coupang.com/vp/products/1"],
    ["경로와 query가 다른 같은 호스트", "https://www.coupang.com/vp/products/1?itemId=2", "https://www.coupang.com/vp/products/1"],
    ["대소문자만 다른 호스트", "https://WWW.Coupang.com/vp/products/1", "https://www.coupang.com/vp/products/1"],
    ["http와 https", "http://shop.example/p/1", "https://shop.example/p/1"],
  ])("%s는 같은 페이지로 본다", (_name, page, link) => {
    expect(snapshotMatchesLink(page, link)).toBe(true);
  });

  it.each([
    ["다른 호스트", "https://evil.example/p/1", "https://shop.example/p/1"],
    ["하위 도메인", "https://m.shop.example/p/1", "https://shop.example/p/1"],
    ["상위 도메인", "https://shop.example/p/1", "https://m.shop.example/p/1"],
    ["계정 정보로 꾸민 주소", "https://shop.example@evil.example/p/1", "https://shop.example/p/1"],
    ["http(s)가 아닌 주소", "javascript:alert(1)//shop.example", "https://shop.example/p/1"],
    ["빈 주소", "", "https://shop.example/p/1"],
    ["주소가 아닌 글", "shop.example", "https://shop.example/p/1"],
  ])("%s는 다른 페이지로 본다", (_name, page, link) => {
    expect(snapshotMatchesLink(page, link)).toBe(false);
  });
});
