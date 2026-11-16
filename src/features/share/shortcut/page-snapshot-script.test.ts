import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pageDocument, runPageSnapshotScript } from "../../../../tests/support/page-snapshot-dom";
import { PAGE_SNAPSHOT_LIMITS } from "../domain/page-snapshot";
import { toPageSnapshot } from "../presentation/share-dto";
import { PAGE_SNAPSHOT_SCRIPT } from "./page-snapshot-script";

function runOn(html: string, href: string) {
  const results = runPageSnapshotScript(pageDocument(html), href);
  expect(results).toHaveLength(1);
  expect(typeof results[0]).toBe("string");
  return { text: results[0] as string, snapshot: JSON.parse(results[0] as string) };
}

const productPage = readFileSync(resolve(import.meta.dirname, "../../../../tests/fixtures/pages/safari-product.html"), "utf8");
const href = "https://www.market.example/vp/products/7001?itemId=9001&vendorItemId=8001";
const utf8 = (text: string) => new TextEncoder().encode(text).length;

describe("Safari 단축어의 페이지 요약 스크립트", () => {
  it("Given 상품 페이지 When 실행하면 Then 주소·제목·대표 주소·상품 메타·JSON-LD만 JSON 글로 한 번 돌려준다", () => {
    const { snapshot } = runOn(productPage, href);

    expect(Object.keys(snapshot)).toEqual(["url", "title", "canonical", "metas", "jsonLd"]);
    expect(snapshot.url).toBe(href);
    expect(snapshot.title).toBe("로투스 비스코프 와플 초코 300g | 예시마켓");
    expect(snapshot.canonical).toBe("https://www.market.example/vp/products/7001?itemId=9001");
    expect(snapshot.metas).toEqual([
      ["og:type", "product"],
      ["og:title", "로투스 비스코프 와플 초코 300g"],
      ["og:image", "//img.market.example/thumbnails/7001/main.jpg"],
      ["og:url", "https://www.market.example/vp/products/7001"],
      ["twitter:card", "summary_large_image"],
      ["name", "로투스 비스코프 와플 초코 300g"],
    ]);
    // The Product block first, then the others in page order; the type may carry parameters.
    expect(snapshot.jsonLd).toHaveLength(3);
    expect(JSON.parse(snapshot.jsonLd[0])).toMatchObject({ "@type": "Product", offers: { price: "12900", priceCurrency: "KRW" } });
    expect(snapshot.jsonLd.slice(1).map((block: string) => JSON.parse(block)["@type"])).toEqual(["BreadcrumbList", "Organization"]);
    expect(toPageSnapshot(snapshot)).toEqual(snapshot);
  });

  it("Given 세션 값이 든 페이지 When 실행하면 Then 본문·일반 스크립트·토큰 메타·폼 값은 보내지 않는다", () => {
    const { text } = runOn(productPage, href);

    for (const secret of ["fixture-session", "fixture-not-a-secret", "fixture-form-token", "csrf", "12,900원", "description"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("Given 아주 큰 페이지 When 실행하면 Then 칸마다 한도를 지키고 전체를 64KiB 안에 두며 상품 JSON-LD를 먼저 남긴다", () => {
    const product = JSON.stringify({ "@type": "Product", name: "큰 상품", offers: { price: "1000", priceCurrency: "KRW" } });
    const filler = (index: number) => JSON.stringify({ "@type": "WebPage", text: `${index}`.padEnd(30_000, "가") });
    const metas = Array.from({ length: 300 }, (_, index) => `<meta property="og:x${index}" content="${"값".repeat(50)}">`).join("");
    const html = [
      `<title>${"😀".repeat(800)}</title>`,
      `<link rel="canonical" href="https://shop.example/${"c".repeat(5000)}">`,
      `<meta property="og:title" content="${"이".repeat(5000)}">`,
      `<meta property="og:${"k".repeat(300)}" content="긴 키">`,
      metas,
      ...[0, 1, 2].map((index) => `<script type="application/ld+json">${filler(index)}</script>`),
      `<script type="application/ld+json">${"x".repeat(70_000)}</script>`,
      `<script type="application/ld+json">${product}</script>`,
    ].join("");

    const { text, snapshot } = runOn(html, `https://shop.example/p/1?${"q".repeat(5000)}`);

    expect(utf8(text)).toBeLessThanOrEqual(PAGE_SNAPSHOT_LIMITS.bytes);
    // An address cut short would name another page, so a too long one is dropped whole.
    expect(snapshot.url).toBe("");
    expect(snapshot.canonical).toBe("");
    // 800 emoji are 1,600 UTF-16 units; the cut keeps whole characters only.
    expect(snapshot.title).toBe("😀".repeat(500));
    expect(snapshot.metas.length).toBeLessThanOrEqual(PAGE_SNAPSHOT_LIMITS.metas);
    expect(snapshot.metas[0]).toEqual(["og:title", "이".repeat(PAGE_SNAPSHOT_LIMITS.metaContent)]);
    expect(snapshot.metas.some(([key]: [string]) => key.length > PAGE_SNAPSHOT_LIMITS.metaKey)).toBe(false);
    expect(snapshot.jsonLd[0]).toBe(product);
    expect(snapshot.jsonLd.every((block: string) => block.length <= PAGE_SNAPSHOT_LIMITS.jsonLdBlock)).toBe(true);
    expect(snapshot.jsonLd).not.toContain("x".repeat(70_000));
    expect(toPageSnapshot(snapshot)).toEqual(snapshot);
  });

  it("Given 읽을 것이 없는 페이지 When 실행하면 Then 빈 요약을 돌려준다", () => {
    expect(runOn("<p>hello</p>", "https://shop.example/").snapshot).toEqual({
      url: "https://shop.example/", title: "", canonical: "", metas: [], jsonLd: [],
    });
  });

  it("Given 문서가 예상과 달라 실행 중 오류가 나도 When 실행하면 Then 단축어가 멈추지 않도록 빈 요약으로 끝낸다", () => {
    const broken = { title: "x", getElementsByTagName: () => { throw new Error("no DOM"); } };
    expect(runPageSnapshotScript(broken, "https://shop.example/")).toEqual([JSON.stringify({ url: "", title: "", canonical: "", metas: [], jsonLd: [] })]);
  });

  it("스크립트는 페이지를 읽기만 하고 쿠키·저장소·네트워크에 닿지 않는다", () => {
    for (const reach of ["cookie", "localStorage", "sessionStorage", "indexedDB", "fetch", "XMLHttpRequest", "sendBeacon", "innerHTML", "outerHTML", "body"]) {
      expect(PAGE_SNAPSHOT_SCRIPT).not.toContain(reach);
    }
    // Pasted into the Shortcuts editor by hand: plain ASCII.
    expect(PAGE_SNAPSHOT_SCRIPT).toMatch(/^[\x20-\x7e\n]*$/);
    expect(PAGE_SNAPSHOT_SCRIPT.match(/completion\(/g)).toHaveLength(1);
  });
});
