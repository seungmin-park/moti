import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { expectNeutral } from "../support/neutral";
import { signInCookies } from "../support/session";

const { appUrl } = readDatabaseConfig();

let current: DatabaseFixture | undefined;

function fixture(): DatabaseFixture {
  if (!current) throw new Error("DB fixture가 준비되지 않았습니다.");
  return current;
}

test.beforeEach(async () => {
  current = await createDatabaseFixture({ ownerGoogleSubject: HTTP_OWNER_SUBJECT });
});

test.afterEach(async () => {
  const done = current;
  current = undefined;
  if (!done) return;
  try {
    await done.cleanup();
  } finally {
    await done.close();
  }
});

const library = () => createSupabaseLibraryStore(fixture().owner.client);

async function signIn(context: BrowserContext) {
  const jar = await signInCookies(fixture().owner);
  await context.addCookies([...jar].map(([name, value]) => ({ name, value, url: appUrl, sameSite: "Lax" as const })));
}

async function deviceContext(browser: Browser, info: TestInfo): Promise<BrowserContext> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = info.project.use;
  return browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL });
}

// The Smartstore case: the page's structured data gave the per-unit 300 won while the default option is a 10-pack.
async function switches(): Promise<Product> {
  const product = (await library().saveLink(toLinkSaveCommand({
    url: `https://smartstore.example/${randomUUID()}`, option: "", collectionIds: [],
  }))).product;
  const jobs = createSupabaseCollectionStore(fixture().owner.client);
  const claim = await jobs.claim({ productId: product.id, generation: 1 });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  const settlement = await jobs.complete(claim.job, {
    title: "키보드 스위치", price: { amountMinor: 300, currency: "KRW" }, imageSourceUrl: null,
  }, { outcome: "absent" });
  if (settlement.kind !== "applied") throw new Error("수집 결과를 남기지 못했습니다.");
  return settlement.product;
}

async function stored(product: Product) {
  const { rows } = await fixture().admin.query<{ wish: string | null; collected: string | null }>(
    "select wish_amount_minor::text as wish, last_success_amount_minor::text as collected from moti.products where id = $1",
    [product.id],
  );
  return rows[0];
}

const card = (page: Page) => page.getByRole("button", { name: /키보드 스위치, .* 상세 보기$/ });
const detailDialog = (page: Page) => page.getByRole("dialog", { name: "담아둔 물건" });
const analyze = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations;

async function closeDetail(page: Page) {
  await detailDialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detailDialog(page)).toHaveCount(0);
}

test("소유자는 상세에서 내가 살 가격을 적어 카드와 상세의 주 가격으로 보고, 자동 확인 가격은 참고로 남으며 새로고침과 새 세션에서도 같다", async ({ page, context, browser }, info) => {
  const product = await switches();
  await signIn(context);
  await page.goto("/");
  await expect(card(page)).toContainText("₩300");

  await card(page).click();
  const detail = detailDialog(page);
  const input = detail.getByRole("textbox", { name: "내가 살 가격 원" });
  const save = detail.getByRole("button", { name: "가격 저장", exact: true });
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await expect(save).toBeDisabled();
  await expect(detail.getByRole("button", { name: "직접 입력 지우기" })).toHaveCount(0);

  await input.fill("30,00");
  await save.click();
  await expect(detail.getByRole("alert")).toHaveText("내가 살 가격은 0 이상의 정수로 입력해 주세요.");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  expect(await stored(product)).toEqual({ wish: null, collected: "300" });

  await input.fill("3,000");
  await save.click();
  await expect(detail.getByRole("status")).toHaveText("내가 살 가격을 저장했어요");
  await expect(input).toHaveValue("3,000");
  // 가격 저장 turns disabled once the value is saved, so the focus stays on the price field.
  await expect(input).toBeFocused();
  await expect(detail.locator(".detail-price strong")).toHaveText("₩3,000");
  await expect(detail.locator(".detail-price .price-marker")).toHaveText("직접 입력");
  await expect(detail.locator(".detail-price")).toContainText("자동 확인 가격 ₩300 · 마지막 확인");
  await expectNeutral(detail.locator(".detail-price .price-marker"), ["color", "border-top-color"]);
  expect(await stored(product)).toEqual({ wish: "3000", collected: "300" });
  expect(await analyze(page)).toEqual([]);

  await closeDetail(page);
  await expect(card(page).locator(".price-value")).toHaveText("₩3,000");
  await expect(card(page).locator(".price-marker")).toHaveText("직접 입력");
  await expect(card(page).locator(".price-label")).toHaveText("자동 확인 ₩300");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.reload();
  await expect(card(page).locator(".price-value")).toHaveText("₩3,000");
  const fresh = await deviceContext(browser, info);
  try {
    await signIn(fresh);
    const second = await fresh.newPage();
    await second.goto("/");
    await expect(card(second).locator(".price-value")).toHaveText("₩3,000");
    await expect(card(second).locator(".price-label")).toHaveText("자동 확인 ₩300");
  } finally {
    await fresh.close();
  }
});

test("소유자는 직접 입력한 가격을 지워 자동 확인 가격으로 돌아가고 키보드로도 저장한다", async ({ page, context }) => {
  const product = await switches();
  await library().changeProduct({ productId: product.id, revision: 1, change: { type: "wish.price", price: { amountMinor: 3000, currency: "KRW" } } });
  await signIn(context);
  await page.goto("/");
  await expect(card(page).locator(".price-value")).toHaveText("₩3,000");

  await card(page).click();
  const detail = detailDialog(page);
  const clear = detail.getByRole("button", { name: "직접 입력 지우기" });
  await clear.click();
  await expect(detail.getByRole("status")).toHaveText("직접 입력한 가격을 지우고 자동 확인 가격을 보여줘요");
  await expect(detail.locator(".detail-price strong")).toHaveText("₩300");
  await expect(detail.locator(".detail-price .price-marker")).toHaveCount(0);
  await expect(clear).toHaveCount(0);
  expect(await stored(product)).toEqual({ wish: null, collected: "300" });

  // The pressed button is gone, so the focus moves to the price field instead of falling to the page.
  const input = detail.getByRole("textbox", { name: "내가 살 가격 원" });
  await expect(input).toBeFocused();
  await page.keyboard.type("2900");
  await page.keyboard.press("Enter");
  await expect(detail.getByRole("status")).toHaveText("내가 살 가격을 저장했어요");
  await expect(input).toHaveValue("2,900");
  await expect(input).toBeFocused();
  expect(await stored(product)).toEqual({ wish: "2900", collected: "300" });
  await closeDetail(page);
  await expect(card(page).locator(".price-value")).toHaveText("₩2,900");
});
