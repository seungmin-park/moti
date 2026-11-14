import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Collection, Product } from "../../src/features/library/domain/library";
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

// A product whose collection already settled, so the screen has nothing to poll for.
async function saved(title: string, collections: Collection[] = []): Promise<Product> {
  const product = (await library().saveLink(toLinkSaveCommand({
    url: `https://shop.example/${randomUUID()}`, option: "", collectionIds: collections.map(({ id }) => id),
  }))).product;
  const jobs = createSupabaseCollectionStore(fixture().owner.client);
  const claim = await jobs.claim({ productId: product.id, generation: 1 });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  const settlement = await jobs.complete(claim.job, { title, price: { amountMinor: 59000, currency: "KRW" }, imageSourceUrl: null }, { outcome: "absent" });
  if (settlement.kind !== "applied") throw new Error("수집 결과를 남기지 못했습니다.");
  return settlement.product;
}

async function stored(product: Product): Promise<number> {
  const { rows } = await fixture().admin.query<{ count: string }>("select count(*) from moti.products where id = $1", [product.id]);
  return Number(rows[0].count);
}

const cards = (page: Page) => page.getByRole("button", { name: /상세 보기$/ });
const card = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title}, .+ 상세 보기$`) });
const detailDialog = (page: Page) => page.getByRole("dialog", { name: "담아둔 물건" });
const confirmation = (page: Page) => detailDialog(page).getByRole("group", { name: /이 상품을 삭제할까요\?/ });
const deleteButton = (page: Page) => detailDialog(page).getByRole("button", { name: "삭제", exact: true });
const confirmButton = (page: Page) => confirmation(page).getByRole("button", { name: "삭제하기", exact: true });
// The status region stays mounted around a fixed-position toast, so the region itself has no box to be visible.
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text }).locator(".toast");
const visibleButton = (page: Page, name: RegExp) => page.getByRole("button", { name }).filter({ visible: true });
const analyze = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations;

test("소유자는 상세 안에서 확인한 뒤 상품을 삭제하고 목록과 컬렉션 개수에서 바로 사라지며 새로고침해도 없다", async ({ page, context }) => {
  const desk = await library().createCollection({ name: "책상" });
  const doomed = await saved("겹친 조명", [desk]);
  await saved("남길 의자", [desk]);
  await signIn(context);
  await page.goto("/");
  await expect(visibleButton(page, /^책상 2$/)).toBeVisible();

  await card(page, "겹친 조명").click();
  await deleteButton(page).click();
  await expect(confirmation(page)).toContainText("되돌릴 수 없어요");
  await expect(confirmation(page).getByRole("button", { name: "취소", exact: true })).toBeFocused();
  expect(await analyze(page)).toEqual([]);
  await expectNeutral(confirmButton(page), ["background-color", "color"]);
  await expectNeutral(confirmation(page), ["border-top-color"]);

  await page.keyboard.press("Escape");
  await expect(confirmation(page)).toHaveCount(0);
  await expect(detailDialog(page)).toBeVisible();
  await expect(deleteButton(page)).toBeFocused();
  expect(await stored(doomed)).toBe(1);

  await page.keyboard.press("Enter");
  await expect(confirmation(page).getByRole("button", { name: "취소", exact: true })).toBeFocused();
  await confirmButton(page).focus();
  await page.keyboard.press("Enter");

  await expect(detailDialog(page)).toHaveCount(0);
  await expect(toast(page, "상품을 삭제했어요")).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, "남길 의자")).toBeVisible();
  await expect(visibleButton(page, /^책상 1$/)).toBeVisible();
  expect(await stored(doomed)).toBe(0);

  await page.reload();
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, "겹친 조명")).toHaveCount(0);
  await expect(visibleButton(page, /^책상 1$/)).toBeVisible();
});

test("다른 곳에서 먼저 바뀐 상품을 삭제하면 상세에서 충돌을 알리고 남겨 두며, 최신 내용을 본 뒤에는 삭제한다", async ({ page, context }) => {
  const product = await saved("무선 조명");
  await signIn(context);
  await page.goto("/");

  await cards(page).click();
  await deleteButton(page).click();
  await library().changeProduct({ productId: product.id, revision: 1, change: { type: "details", title: "다른 곳의 이름", note: "", collectionIds: [] } });
  await confirmButton(page).click();

  await expect(detailDialog(page).getByRole("alert")).toHaveText("다른 곳에서 먼저 바뀌었어요. 최신 내용을 불러왔어요. 확인 후 다시 삭제해 주세요.");
  await expect(detailDialog(page).getByRole("heading", { name: "다른 곳의 이름" })).toBeVisible();
  await expect(confirmation(page)).toHaveCount(0);
  expect(await stored(product)).toBe(1);
  const alertColor = await detailDialog(page).getByRole("alert").evaluate((element) => getComputedStyle(element).color);
  expect(alertColor).toBe("rgb(162, 57, 32)");

  await deleteButton(page).click();
  await confirmButton(page).click();
  await expect(detailDialog(page)).toHaveCount(0);
  await expect(toast(page, "상품을 삭제했어요")).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  expect(await stored(product)).toBe(0);
});

test("다른 곳에서 이미 지운 상품을 삭제하면 상세를 닫고 찾을 수 없다고 알린 뒤 목록에서 뺀다", async ({ page, context }) => {
  const product = await saved("무선 조명");
  await saved("남길 의자");
  await signIn(context);
  await page.goto("/");

  await card(page, "무선 조명").click();
  await deleteButton(page).click();
  await library().deleteProduct({ productId: product.id, revision: 1 });
  await confirmButton(page).click();

  await expect(detailDialog(page)).toHaveCount(0);
  await expect(toast(page, "상품을 찾을 수 없어요. 목록을 새로 불러왔어요.")).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, "남길 의자")).toBeVisible();
});
