import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Collection, Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
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

async function saved(collections: Collection[] = []): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({
    url: `https://shop.example/${randomUUID()}`, option: "", collectionIds: collections.map(({ id }) => id),
  }))).product;
}

// Every collection the owner has, each with the products in it.
async function storedCollections(): Promise<{ name: string; products: string[] }[]> {
  const { rows } = await fixture().admin.query<{ name: string; products: string[] }>(
    `select c.name, array(select m.product_id::text from moti.product_collections m where m.collection_id = c.id) as products
     from moti.collections c where c.owner_id = $1 order by c.name`,
    [fixture().owner.id],
  );
  return rows;
}

const detailDialog = (page: Page) => page.getByRole("dialog", { name: "담아둔 물건" });
const opener = (page: Page) => detailDialog(page).getByRole("button", { name: "새 컬렉션", exact: true });
const nameField = (page: Page) => detailDialog(page).getByRole("textbox", { name: "새 컬렉션 이름" });
// The sidebar on a wide screen, the chip row on a narrow one: both read "<name> <count>".
const counted = (page: Page, name: string, count: number) =>
  page.getByRole("button", { name: new RegExp(`^${name}\\s?${count}$`) }).filter({ visible: true }).first();

async function openDetail(page: Page) {
  await page.getByRole("button", { name: /상세 보기$/ }).click();
  await expect(detailDialog(page)).toBeVisible();
}

test("상세에서 새 컬렉션을 키보드로 만들면 고른 채로 나타나고 변경사항 저장으로 상품을 담는다", async ({ page, context }) => {
  const desk = await library().createCollection({ name: "책상" });
  const product = await saved([desk]);
  await signIn(context);
  await page.goto("/");
  await openDetail(page);
  const detail = detailDialog(page);

  await opener(page).focus();
  await page.keyboard.press("Enter");
  await expect(nameField(page)).toBeFocused();
  await expectNeutral(nameField(page), ["background-color", "box-shadow"]);
  expect((await new AxeBuilder({ page }).include(".detail-dialog").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations)
    .toEqual([]);
  await nameField(page).fill(" 주방 ");
  await nameField(page).press("Enter");

  const kitchen = detail.getByRole("checkbox", { name: "주방", exact: true });
  await expect(kitchen).toBeChecked();
  await expect(kitchen).toBeFocused();
  await expect(nameField(page)).toHaveCount(0);
  await expect(detail.getByRole("checkbox", { name: "책상", exact: true })).toBeChecked();
  await expect(detail).toBeVisible();
  await expect(counted(page, "주방", 0)).toBeVisible();
  expect(await storedCollections()).toEqual([
    { name: "주방", products: [] },
    { name: "책상", products: [product.id] },
  ]);

  await detail.getByRole("button", { name: "변경사항 저장", exact: true }).click();
  await expect(detail.getByRole("status")).toHaveText("변경사항을 저장했어요");
  await expect(counted(page, "주방", 1)).toBeVisible();
  expect(await storedCollections()).toEqual([
    { name: "주방", products: [product.id] },
    { name: "책상", products: [product.id] },
  ]);

  await page.reload();
  await openDetail(page);
  await expect(detailDialog(page).getByRole("checkbox", { name: "주방", exact: true })).toBeChecked();
});

test("Esc는 이름 칸만 닫고 초점을 새 컬렉션으로 돌리며, 만든 뒤 저장하지 않고 닫으면 빈 컬렉션만 남는다", async ({ page, context }) => {
  await saved();
  await signIn(context);
  await page.goto("/");
  await openDetail(page);
  const detail = detailDialog(page);
  await expect(detail.getByText("아직 만든 컬렉션이 없어요.")).toBeVisible();

  await opener(page).click();
  await nameField(page).fill("여행");
  await nameField(page).press("Escape");
  await expect(nameField(page)).toHaveCount(0);
  await expect(detail).toBeVisible();
  await expect(opener(page)).toBeFocused();
  expect(await storedCollections()).toEqual([]);

  await opener(page).click();
  await expect(nameField(page)).toHaveValue("");
  await nameField(page).fill("여행");
  await detail.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(detail.getByRole("checkbox", { name: "여행", exact: true })).toBeChecked();
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(counted(page, "여행", 0)).toBeVisible();
  expect(await storedCollections()).toEqual([{ name: "여행", products: [] }]);

  await openDetail(page);
  await expect(detailDialog(page).getByRole("checkbox", { name: "여행", exact: true })).not.toBeChecked();
});

test("이미 있는 이름이나 빈 이름은 만들지 않고 이름 칸에 알리며 상품 저장은 일어나지 않는다", async ({ page, context }) => {
  await library().createCollection({ name: "책상" });
  await saved();
  await signIn(context);
  await page.goto("/");
  await openDetail(page);
  const detail = detailDialog(page);

  await opener(page).click();
  await nameField(page).press("Enter");
  await expect(detail.getByRole("alert")).toHaveText("컬렉션 이름은 1~40자로 입력해 주세요.");
  await nameField(page).fill("  책상 ");
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await nameField(page).press("Enter");
  await expect(detail.getByRole("alert")).toHaveText("같은 이름의 컬렉션이 이미 있어요.");
  await expect(nameField(page)).toHaveAttribute("aria-invalid", "true");
  await expect(nameField(page)).toHaveValue("  책상 ");
  await expect(detail.getByRole("checkbox")).toHaveCount(1);
  await expect(detail.getByRole("button", { name: "변경사항 저장", exact: true })).toBeDisabled();
  await expect(detail.getByRole("status")).toHaveCount(0);
  expect(await storedCollections()).toEqual([{ name: "책상", products: [] }]);
});
