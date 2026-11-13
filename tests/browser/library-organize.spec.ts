import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
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

async function deviceContext(browser: Browser, info: TestInfo): Promise<BrowserContext> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = info.project.use;
  return browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL });
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

async function stored(product: Product) {
  const { rows } = await fixture().admin.query<{
    owner_title: string | null; note: string; purchase_status: string; purchased_on: string | null;
    purchased_amount_minor: string | null; collections: string[];
  }>(
    `select owner_title, note, purchase_status, purchased_on::text, purchased_amount_minor::text,
       array(select c.name from moti.product_collections m join moti.collections c on c.id = m.collection_id
             where m.product_id = p.id order by c.name) as collections
     from moti.products p where id = $1`,
    [product.id],
  );
  return rows[0];
}

const cards = (page: Page) => page.getByRole("button", { name: /상세 보기$/ });
const detailDialog = (page: Page) => page.getByRole("dialog", { name: "담아둔 물건" });
// The status region stays mounted around a fixed-position toast, so the region itself has no box to be visible.
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text }).locator(".toast");
const visibleButton = (page: Page, name: string | RegExp) =>
  page.getByRole("button", typeof name === "string" ? { name, exact: true } : { name }).filter({ visible: true });
const analyze = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations;

async function closeDetail(page: Page) {
  await detailDialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detailDialog(page)).toHaveCount(0);
}

test("소유자는 상세에서 이름·메모·컬렉션을 고치고 새로고침과 새 세션에서도 그대로 본다", async ({ page, context, browser }, info) => {
  const desk = await library().createCollection({ name: "책상" });
  await library().createCollection({ name: "선물" });
  const product = await saved("무선 조명", [desk]);
  await signIn(context);
  await page.goto("/");

  await cards(page).click();
  const detail = detailDialog(page);
  const save = detail.getByRole("button", { name: "변경사항 저장", exact: true });
  await expect(save).toBeDisabled();
  await detail.getByLabel("상품 이름").fill("  책상 조명 ");
  await detail.getByLabel("메모").fill("선물용\n사이즈 확인");
  await detail.getByRole("checkbox", { name: "책상" }).uncheck();
  await detail.getByRole("checkbox", { name: "선물" }).check();
  await save.click();
  await expect(detail.getByRole("status")).toHaveText("변경사항을 저장했어요");
  await expect(detail.getByRole("heading", { name: "책상 조명" })).toBeVisible();
  await closeDetail(page);
  await expect(cards(page)).toContainText("책상 조명");
  await expect(cards(page)).toContainText("선물");
  expect(await stored(product)).toMatchObject({ owner_title: "책상 조명", note: "선물용\n사이즈 확인", collections: ["선물"] });

  const other = await deviceContext(browser, info);
  try {
    await signIn(other);
    const second = await other.newPage();
    await second.goto("/");
    await cards(second).click();
    const reopened = detailDialog(second);
    await expect(reopened.getByLabel("상품 이름")).toHaveValue("책상 조명");
    await expect(reopened.getByLabel("메모")).toHaveValue("선물용\n사이즈 확인");
    await expect(reopened.getByRole("checkbox", { name: "선물" })).toBeChecked();
    await expect(reopened.getByRole("checkbox", { name: "책상" })).not.toBeChecked();
  } finally {
    await other.close();
  }

  await page.reload();
  await expect(cards(page)).toContainText("책상 조명");
});

test("카드에서 구매완료로 옮긴 뒤 실행 취소하면 위시로 돌아오고 메모와 컬렉션은 그대로다", async ({ page, context }) => {
  const desk = await library().createCollection({ name: "책상" });
  const product = await saved("무선 조명", [desk]);
  await library().changeProduct({ productId: product.id, revision: 1, change: { type: "details", title: null, note: "선물용", collectionIds: [desk.id] } });
  await signIn(context);
  await page.goto("/");

  await page.getByRole("button", { name: "무선 조명 구매완료로 이동", exact: true }).click();
  await expect(toast(page, "구매완료 목록으로 옮겼어요")).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "아직 담아둔 물건이 없어요" })).toBeVisible();
  expect(await stored(product)).toMatchObject({ purchase_status: "purchased", note: "선물용", collections: ["책상"] });

  await toast(page, "구매완료 목록으로 옮겼어요").getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(toast(page, "위시리스트로 되돌렸어요")).toBeVisible();
  await expect(cards(page)).toHaveCount(1);
  expect(await stored(product)).toMatchObject({ purchase_status: "wish", note: "선물용", collections: ["책상"] });
  await expectNeutral(page.locator(".toast"), ["background-color", "color"]);

  await page.reload();
  await expect(cards(page)).toContainText("책상");
});

test("구매완료 보기에서 구매일과 0원을 기록하고 지울 수 있으며 위시로 되돌려도 메모와 컬렉션이 남는다", async ({ page, context }) => {
  const desk = await library().createCollection({ name: "책상" });
  const product = await saved("무선 조명", [desk]);
  await library().changeProduct({ productId: product.id, revision: 1, change: { type: "details", title: null, note: "선물용", collectionIds: [desk.id] } });
  await signIn(context);
  await page.goto("/");

  await cards(page).click();
  await detailDialog(page).getByRole("button", { name: "구매완료로 이동", exact: true }).click();
  await expect(detailDialog(page)).toHaveCount(0);
  await expect(toast(page, "구매완료 목록으로 옮겼어요")).toBeVisible();
  await visibleButton(page, "구매완료").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("함께하게 된 물건들");
  await expect(cards(page)).toContainText("실구매가 미입력");
  await expectNeutral(page.locator('[aria-current="page"]').filter({ visible: true }).first(), ["background-color", "color"]);

  await cards(page).click();
  const detail = detailDialog(page);
  expect(await analyze(page)).toEqual([]);
  await detail.getByLabel("구매일").fill("2026-11-01");
  await detail.getByLabel("실구매가").fill("0");
  await detail.getByRole("button", { name: "구매 정보 저장", exact: true }).click();
  await expect(detail.getByRole("status")).toHaveText("구매 정보를 저장했어요");
  await closeDetail(page);
  await expect(cards(page)).toContainText("₩0");
  await expect(cards(page)).toContainText("실구매가 · 2026. 11. 01. 구매");
  expect(await stored(product)).toMatchObject({ purchased_on: "2026-11-01", purchased_amount_minor: "0" });

  await page.reload();
  await visibleButton(page, "구매완료").click();
  await expect(cards(page)).toContainText("₩0");
  await cards(page).click();
  await expect(detail.getByLabel("실구매가")).toHaveValue("0");
  await detail.getByLabel("실구매가").fill("");
  await detail.getByRole("button", { name: "구매 정보 저장", exact: true }).click();
  await expect(detail.getByRole("status")).toHaveText("구매 정보를 저장했어요");
  expect(await stored(product)).toMatchObject({ purchased_on: "2026-11-01", purchased_amount_minor: null });

  await detail.getByRole("button", { name: "위시로 되돌리기", exact: true }).click();
  await expect(detailDialog(page)).toHaveCount(0);
  await expect(toast(page, "위시리스트로 되돌렸어요")).toBeVisible();
  await expect(page.getByRole("heading", { name: "아직 구매한 물건이 없어요" })).toBeVisible();
  await visibleButton(page, "위시리스트").click();
  await expect(cards(page)).toContainText("책상");
  expect(await stored(product)).toMatchObject({
    purchase_status: "wish", purchased_on: null, purchased_amount_minor: null, note: "선물용", collections: ["책상"],
  });
});

test("컬렉션 이름을 바꾸면 소속 상품과 함께 새 이름이 남고 다른 컬렉션과 같은 이름은 거절한다", async ({ page, context }) => {
  const desk = await library().createCollection({ name: "책상" });
  await library().createCollection({ name: "방" });
  await saved("무선 조명", [desk]);
  await signIn(context);
  await page.goto("/");

  await visibleButton(page, /^책상 1$/).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("책상");
  await page.getByRole("button", { name: "컬렉션 이름 바꾸기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "컬렉션 이름 바꾸기" });
  await expect(dialog.getByLabel("컬렉션 이름")).toHaveValue("책상");
  await dialog.getByLabel("컬렉션 이름").fill("방");
  await dialog.getByRole("button", { name: "이름 저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("같은 이름의 컬렉션이 이미 있어요.");
  expect(await analyze(page)).toEqual([]);

  await dialog.getByLabel("컬렉션 이름").fill(" 작업 공간 ");
  await dialog.getByRole("button", { name: "이름 저장", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("작업 공간");
  await expect(toast(page, "컬렉션 이름을 바꿨어요")).toBeVisible();
  await expect(cards(page)).toHaveCount(1);

  await page.reload();
  await visibleButton(page, /^작업 공간 1$/).click();
  await expect(cards(page)).toContainText("작업 공간");
  const { rows } = await fixture().admin.query<{ name: string; revision: number }>(
    "select name, revision from moti.collections where owner_id = $1 order by created_at", [fixture().owner.id],
  );
  expect(rows).toEqual([{ name: "작업 공간", revision: 2 }, { name: "방", revision: 1 }]);
});

test("다른 곳에서 먼저 바뀐 상품을 저장하면 충돌을 알리고 입력한 메모를 지킨 뒤 다시 저장할 수 있다", async ({ page, context }) => {
  const product = await saved("무선 조명");
  await signIn(context);
  await page.goto("/");

  await cards(page).click();
  const detail = detailDialog(page);
  await detail.getByLabel("메모").fill("내가 쓴 메모");
  await library().changeProduct({
    productId: product.id, revision: 1, change: { type: "details", title: "다른 곳의 이름", note: "다른 곳의 메모", collectionIds: [] },
  });
  const save = detail.getByRole("button", { name: "변경사항 저장", exact: true });
  await save.click();

  await expect(detail.getByRole("alert")).toHaveText("다른 곳에서 먼저 바뀌었어요. 최신 내용을 불러왔어요. 확인 후 다시 저장해 주세요.");
  await expect(detail.getByLabel("상품 이름")).toHaveValue("다른 곳의 이름");
  await expect(detail.getByLabel("메모")).toHaveValue("내가 쓴 메모");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(detail.getByRole("status")).toHaveText("변경사항을 저장했어요");
  expect(await stored(product)).toMatchObject({ owner_title: "다른 곳의 이름", note: "내가 쓴 메모" });
  const { rows } = await fixture().admin.query<{ revision: number }>("select revision from moti.products where id = $1", [product.id]);
  expect(rows).toEqual([{ revision: 3 }]);
});
