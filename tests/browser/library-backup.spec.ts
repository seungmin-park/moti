import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { toLibraryRestoreCommand, toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Collection, Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { readLibraryBackup, toLibraryBackupDocument } from "../../src/features/library/presentation/library-backup";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { seoulToday } from "../../src/features/wishlist/product-fields";
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
async function saved(title: string, collections: Collection[] = [], url = `https://shop.example/${randomUUID()}`): Promise<Product> {
  const product = (await library().saveLink(toLinkSaveCommand({ url, option: "", collectionIds: collections.map(({ id }) => id) }))).product;
  const jobs = createSupabaseCollectionStore(fixture().owner.client);
  const claim = await jobs.claim({ productId: product.id, generation: 1 });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  const settlement = await jobs.complete(claim.job, { title, price: { amountMinor: 59000, currency: "KRW" }, imageSourceUrl: null }, { outcome: "absent" });
  if (settlement.kind !== "applied") throw new Error("수집 결과를 남기지 못했습니다.");
  return settlement.product;
}

async function rows() {
  const { rows } = await fixture().admin.query(
    `select p.id, p.source_url, p.title, p.owner_title, p.note, p.revision, p.purchase_status, p.purchased_on::text,
       p.purchased_amount_minor::text, p.created_at,
       array(select c.name from moti.product_collections m join moti.collections c on c.id = m.collection_id
             where m.product_id = p.id order by c.name) as collections
     from moti.products p where p.owner_id = $1 order by p.created_at desc`,
    [fixture().owner.id],
  );
  return rows;
}

const cards = (page: Page) => page.getByRole("button", { name: /상세 보기$/ });
const backupDialog = (page: Page) => page.getByRole("dialog", { name: "백업과 복원" });
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text }).locator(".toast");
const visibleButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const analyze = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations;

async function openBackup(page: Page) {
  await visibleButton(page, "백업과 복원").click();
  await expect(backupDialog(page)).toBeVisible();
}

async function choose(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await backupDialog(page).locator('input[type="file"]').setInputFiles(file);
}

test("소유자는 백업을 내려받고 보관함이 바뀐 뒤 그 파일로 복원하면 새로고침과 새 세션에서도 파일의 보관함을 본다", async ({ page, context, browser }, info) => {
  const desk = await library().createCollection({ name: "책상" });
  const lamp = await saved("무선 조명", [desk]);
  await library().changeProduct({ productId: lamp.id, revision: 1, change: { type: "details", title: null, note: "선물용\n사이즈 확인", collectionIds: [desk.id] } });
  const chair = await saved("의자");
  await library().changeProduct({ productId: chair.id, revision: 1, change: { type: "purchase" } });
  await library().changeProduct({ productId: chair.id, revision: 2, change: { type: "purchase.record", date: "2026-11-01", price: { amountMinor: 0, currency: "KRW" } } });
  await signIn(context);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(1);

  await openBackup(page);
  await expectNeutral(visibleButton(page, "백업 만들기"), ["background-color", "color"]);
  await backupDialog(page).getByRole("button", { name: "백업 만들기", exact: true }).click();
  const link = backupDialog(page).getByRole("link", { name: "내려받기" });
  await expect(link).toBeFocused();
  await expect(backupDialog(page)).toContainText("상품 2개 · 컬렉션 1개");
  const downloading = page.waitForEvent("download");
  await link.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^moti-backup-\d{8}-\d{4}\.json$/);
  const file = info.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const reading = readLibraryBackup(JSON.parse(await readFile(file, "utf8")));
  expect(reading).toMatchObject({ ok: true, counts: { products: 2, collections: 1 } });
  await backupDialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(backupDialog(page)).toHaveCount(0);
  const before = await rows();

  await library().restoreLibrary(toLibraryRestoreCommand({ collections: [], products: [] }, seoulToday(new Date())));
  await saved("나중에 담은 상품");
  await page.reload();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("나중에 담은 상품");

  await openBackup(page);
  await choose(page, file);
  const dialog = backupDialog(page);
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeFocused();
  await expect(dialog.locator("dd")).toHaveText(["상품 1개 · 컬렉션 0개", "상품 2개 · 컬렉션 1개"]);
  await expect(dialog).toContainText("백업에 없는 상품 1개는 지워져요.");
  expect(await analyze(page)).toEqual([]);
  const replace = dialog.getByRole("button", { name: "보관함 바꾸기", exact: true });
  await expectNeutral(replace, ["background-color", "color"]);
  await replace.click();

  await expect(toast(page, "보관함을 복원했어요")).toBeVisible();
  await expect(backupDialog(page)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("무선 조명");
  await expect(cards(page)).toContainText("책상");
  await expect(cards(page)).toContainText("₩59,000");
  await visibleButton(page, "구매완료").click();
  await expect(cards(page)).toContainText("의자");
  await expect(cards(page)).toContainText("₩0");
  await expect(cards(page)).toContainText("실구매가 · 2026. 11. 01. 구매");
  const restored = await rows();
  const owned = (row: Record<string, unknown>) => ({ ...row, id: undefined, revision: undefined });
  expect(restored.map(owned)).toEqual(before.map(owned));

  // Restored products are collected after the response; shop.example never answers, so the run fails and keeps the file's values.
  await expect.poll(async () => (await fixture().admin.query(
    "select count(*)::int as waiting from moti.products where owner_id = $1 and metadata_phase in ('queued', 'running')", [fixture().owner.id],
  )).rows[0].waiting, { timeout: 30_000 }).toBe(0);
  expect((await rows()).map(owned)).toEqual(before.map(owned));

  const other = await deviceContext(browser, info);
  try {
    await signIn(other);
    const second = await other.newPage();
    await second.goto("/");
    await expect(cards(second)).toHaveCount(1);
    await expect(cards(second)).toContainText("무선 조명");
    await cards(second).click();
    await expect(second.getByRole("dialog", { name: "담아둔 물건" }).getByLabel("메모")).toHaveValue("선물용\n사이즈 확인");
  } finally {
    await other.close();
  }
});

test("손상되었거나 바뀐 파일과 서버가 거절한 파일은 오류를 보이고 보관함을 바꾸지 않는다", async ({ page, context }) => {
  const product = await saved("무선 조명");
  const file = toLibraryBackupDocument(await library().exportLibrary(), new Date());
  const before = await rows();
  await signIn(context);
  await page.goto("/");
  await openBackup(page);
  const dialog = backupDialog(page);

  await choose(page, { name: "notes.json", mimeType: "application/json", buffer: Buffer.from("{ not json") });
  await expect(dialog.getByRole("alert")).toHaveText("moti 백업 파일이 아니에요.");

  const tampered = { ...file, products: [...file.products, { ...file.products[0] }] };
  await choose(page, { name: "moti-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(tampered)) });
  await expect(dialog.getByRole("alert")).toHaveText("백업 파일이 손상되었거나 바뀌었어요. 보관함은 바뀌지 않았어요.");
  await expect(dialog.getByRole("button", { name: "보관함 바꾸기" })).toHaveCount(0);
  await expectNeutral(dialog.getByRole("button", { name: "백업 파일 선택", exact: true }), ["background-color", "color"]);

  const future = { ...file, products: [{ ...file.products[0], purchase: { status: "purchased" as const, date: "2999-01-01", price: null } }] };
  await choose(page, { name: "moti-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(future)) });
  await dialog.getByRole("button", { name: "보관함 바꾸기", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("구매일은 오늘까지 입력할 수 있어요. 보관함은 바뀌지 않았어요.");
  expect(await analyze(page)).toEqual([]);

  expect(await rows()).toEqual(before);
  await page.reload();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("무선 조명");
  await expect(cards(page)).toHaveAccessibleName(`무선 조명, ${product.shop} 상세 보기`);
});

test("복원하는 동안에는 대화상자를 닫을 수 없고, 링크가 같은 상품은 그대로 남아 파일의 메모로 돌아간다", async ({ page, context }, info) => {
  const product = await saved("무선 조명");
  const file = info.outputPath("moti-backup.json");
  await writeFile(file, JSON.stringify(toLibraryBackupDocument(await library().exportLibrary(), new Date())));
  await library().changeProduct({ productId: product.id, revision: 1, change: { type: "details", title: null, note: "바꾼 메모", collectionIds: [] } });
  await signIn(context);
  await page.goto("/");
  await openBackup(page);
  await choose(page, file);
  const dialog = backupDialog(page);
  await expect(dialog).toContainText("상품 1개 · 컬렉션 0개");

  const connection = await fixture().admin.connect();
  try {
    await connection.query("begin");
    await connection.query("select 1 from moti.products where id = $1 for update", [product.id]);
    await dialog.getByRole("button", { name: "보관함 바꾸기", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("보관함을 바꾸는 중이에요…");
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveText("보관함을 바꾸는 중이에요…");
    await connection.query("commit");
  } finally {
    await connection.query("rollback").catch(() => undefined);
    connection.release();
  }

  await expect(toast(page, "보관함을 복원했어요")).toBeVisible();
  await cards(page).click();
  await expect(page.getByRole("dialog", { name: "담아둔 물건" }).getByLabel("메모")).toHaveValue("");
  expect((await rows()).map(({ id, revision, note }) => ({ id, revision, note }))).toEqual([{ id: product.id, revision: 3, note: "" }]);
});
