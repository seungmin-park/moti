import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const browser = await chromium.launch();
const baseURL = process.argv[2] ?? "http://127.0.0.1:3100";
const failures = [];
const checks = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(baseURL, { waitUntil: "networkidle" });
    for (const view of ["wishlist", "detail"]) {
      if (view === "detail") await page.getByRole("button", { name: "무선 헤드폰 상세 보기" }).click();
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      checks.push({ width, view, violations: result.violations.length });
      failures.push(...result.violations.map(violation => ({ width, view, id: violation.id, impact: violation.impact, elements: violation.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })));
    }
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ checks, failures }, null, 2));
if (failures.length) process.exitCode = 1;
