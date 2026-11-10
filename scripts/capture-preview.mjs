import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const browser = await chromium.launch();
const baseURL = process.argv[2] ?? "http://127.0.0.1:3100";
const output = new URL("../docs/evidence/", import.meta.url);
await mkdir(output, { recursive: true });
const results = [];
try {
  for (const [name, width, height] of [["desktop", 1440, 1000], ["tablet", 900, 1000], ["mobile", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "나의 위시리스트", exact: true }).waitFor();
    const layout = await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(img => img.decode().catch(() => {})));
      return {
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        font: getComputedStyle(document.body).fontFamily,
        loadedFonts: [...document.fonts].filter(font => font.status === "loaded").map(font => font.family),
        brokenImages: [...document.images].filter(img => !img.naturalWidth).map(img => img.src),
      };
    });
    if (layout.overflow || layout.brokenImages.length || errors.length || !layout.loadedFonts.some(font => font.toLowerCase() === "pretendard")) throw new Error(JSON.stringify({ name, layout, errors }));
    await page.screenshot({ path: new URL(`${name}.png`, output).pathname, fullPage: true });
    if (name === "desktop") {
      await page.getByRole("button", { name: "무선 헤드폰 상세 보기" }).click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("dialog").locator("img").evaluateAll(images => Promise.all(images.map(img => img.decode())));
      await page.screenshot({ path: new URL("detail.png", output).pathname });
    }
    results.push({ name, ...layout, errors });
    await page.close();
  }
} finally {
  await browser.close();
}
await writeFile(new URL("layout.json", output), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results));
