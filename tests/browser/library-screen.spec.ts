import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { expectNeutral } from "../support/neutral";
import { cookieHeader, signInCookies, type CookieJar } from "../support/session";
import { seenText, watchForText } from "../support/text-watch";

const { appUrl } = readDatabaseConfig();
const origin = new URL(appUrl).origin;

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

async function signIn(context: BrowserContext, user: DatabaseFixture["owner"]): Promise<CookieJar> {
  const jar = await signInCookies(user);
  await context.addCookies([...jar].map(([name, value]) => ({ name, value, url: appUrl, sameSite: "Lax" as const })));
  return jar;
}

async function deviceContext(browser: Browser, info: TestInfo): Promise<BrowserContext> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = info.project.use;
  return browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL });
}

async function storedProducts(): Promise<number> {
  const { rows } = await fixture().admin.query<{ count: number }>(
    "select count(*)::int as count from moti.products where owner_id = $1",
    [fixture().owner.id],
  );
  return rows[0].count;
}

const cards = (page: Page) => page.getByRole("button", { name: /상세 보기$/ });
const addDialog = (page: Page) => page.getByRole("dialog", { name: "마음에 든 물건을 담아두세요" });
const detailDialog = (page: Page) => page.getByRole("dialog", { name: "담아둔 물건" });

async function openAdd(page: Page, url: string) {
  await page.getByRole("button", { name: "링크 추가", exact: true }).click();
  await addDialog(page).getByLabel("상품 링크").fill(url);
}

async function submitAndExpect(page: Page, arrival: string) {
  await addDialog(page).getByRole("button", { name: "위시에 담기", exact: true }).click();
  await expect(detailDialog(page).getByRole("status")).toHaveText(arrival);
}

async function closeDetail(page: Page) {
  await detailDialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(detailDialog(page)).toHaveCount(0);
}

test("소유자는 빈 보관함에 컬렉션과 함께 링크를 담고, 다시 불러오거나 새 세션으로 열어도 같은 보관함을 본다", async ({ page, context, browser }, info) => {
  await watchForText(context, ["예시"]);
  await signIn(context, fixture().owner);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "아직 담아둔 물건이 없어요" })).toBeVisible();

  await openAdd(page, "https://shop.example/desk-lamp?utm_source=moti");
  const add = addDialog(page);
  await add.getByLabel("옵션 선택", { exact: true }).fill("화이트");
  await add.getByRole("button", { name: /^담을 컬렉션:/ }).click();
  await add.getByRole("textbox", { name: "컬렉션 검색 또는 새 이름" }).fill("책상");
  await add.getByRole("button", { name: "책상 컬렉션 만들고 선택", exact: true }).click();
  await expect(add.getByRole("checkbox", { name: "책상" })).toBeChecked();
  await submitAndExpect(page, "위시에 담았어요");

  const detail = detailDialog(page);
  await expect(detail).toContainText("정보 수집 대기");
  await expect(detail).toContainText("상품 정보는 아직 가져오지 않았어요. 원본 링크는 보관했어요.");
  await expect(detail).toContainText("가격 확인 전");
  await expect(detail.getByRole("link", { name: "원본 링크 열기" }))
    .toHaveAttribute("href", "https://shop.example/desk-lamp?utm_source=moti");
  await closeDetail(page);

  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("책상");
  await expect(cards(page)).toContainText("화이트");
  expect(await storedProducts()).toBe(1);

  await page.reload();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("책상");
  expect(await seenText(page)).toEqual([]);

  const other = await deviceContext(browser, info);
  try {
    await watchForText(other, ["예시"]);
    await signIn(other, fixture().owner);
    const second = await other.newPage();
    await second.goto("/");
    await expect(cards(second)).toHaveCount(1);
    await expect(cards(second)).toContainText("책상");
    await expect(second.getByRole("button", { name: /^책상 1$/ }).filter({ visible: true })).toBeVisible();
    expect(await seenText(second)).toEqual([]);
  } finally {
    await other.close();
  }
});

test("같은 링크를 다시 담으면 이미 담았다고 알리고 저장은 하나로 유지한다", async ({ page, context }) => {
  await signIn(context, fixture().owner);
  await page.goto("/");
  await openAdd(page, "https://shop.example/chair?utm_source=a");
  await submitAndExpect(page, "위시에 담았어요");
  await closeDetail(page);

  await openAdd(page, "https://shop.example/chair?utm_source=b");
  await submitAndExpect(page, "이미 담아둔 상품이에요");
  await closeDetail(page);

  await expect(cards(page)).toHaveCount(1);
  expect(await storedProducts()).toBe(1);
});

test("고른 컬렉션이 다른 곳에서 지워지면 안내 후 목록을 새로 불러오고 입력한 링크로 다시 담는다", async ({ page, context }) => {
  const { rows } = await fixture().admin.query<{ id: string }>(
    "insert into moti.collections (owner_id, name) values ($1, '책상') returning id",
    [fixture().owner.id],
  );
  await signIn(context, fixture().owner);
  await page.goto("/");
  const url = "https://shop.example/monitor-arm";
  await openAdd(page, url);
  const add = addDialog(page);
  await add.getByRole("button", { name: /^담을 컬렉션:/ }).click();
  await add.getByRole("checkbox", { name: "책상" }).check();
  await add.getByRole("button", { name: "담을 컬렉션: 책상", exact: true }).click();

  await fixture().admin.query("delete from moti.collections where id = $1", [rows[0].id]);
  await add.getByRole("button", { name: "위시에 담기", exact: true }).click();

  await expect(add.getByRole("alert")).toHaveText("선택한 컬렉션을 찾을 수 없어요. 목록을 새로 불러왔어요.");
  await expect(add.getByRole("button", { name: "담을 컬렉션: 컬렉션 선택", exact: true })).toBeVisible();
  await add.getByRole("button", { name: /^담을 컬렉션:/ }).click();
  await expect(add.getByRole("checkbox", { name: "책상" })).toHaveCount(0);
  await expect(add.getByLabel("상품 링크")).toHaveValue(url);
  expect(await storedProducts()).toBe(0);

  await submitAndExpect(page, "위시에 담았어요");
  expect(await storedProducts()).toBe(1);
});

test("대화상자에서 만든 컬렉션으로 바로 거르고 다시 불러와도 컬렉션이 남는다", async ({ page, context }) => {
  await signIn(context, fixture().owner);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("나의 위시리스트");

  await page.getByRole("button", { name: "컬렉션 만들기", exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole("dialog", { name: "새로운 컬렉션" });
  await dialog.getByLabel("컬렉션 이름").fill(" 주방 ");
  await dialog.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("주방");

  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("나의 위시리스트");
  await page.getByRole("button", { name: /^주방 0$/ }).filter({ visible: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("주방");
  const { rows } = await fixture().admin.query<{ name: string }>(
    "select name from moti.collections where owner_id = $1",
    [fixture().owner.id],
  );
  expect(rows).toEqual([{ name: "주방" }]);
});

test("로그아웃하면 안내 없는 로그인 화면으로 가고 보관함을 다시 열어도 로그인으로 돌아간다", async ({ page, context }) => {
  await signIn(context, fixture().owner);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("나의 위시리스트");

  await page.getByRole("button", { name: "로그아웃", exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(`${origin}/login`);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);

  await page.goto("/");
  await expect(page).toHaveURL(`${origin}/login`);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("허용하지 않은 Google 계정은 거절 안내로 가고 인증 쿠키가 지워진다", async ({ page, context }) => {
  const jar = await signIn(context, fixture().stranger);
  await page.goto("/");
  await expect(page).toHaveURL(`${origin}/login?error=forbidden`);
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("이 Google 계정은 사용할 수 없어요");
  await expect(alert).toContainText("방금 세션은 종료했어요.");
  expect((await context.cookies()).filter((cookie) => jar.has(cookie.name))).toEqual([]);
});

test("보관함, 링크 추가와 상세는 기본 접근성 검사에 통과하고 선택 표시는 중립 색이다", async ({ page, context }) => {
  const jar = await signIn(context, fixture().owner);
  const saved = await fetch(new URL("/api/links", appUrl), {
    method: "POST",
    headers: { cookie: cookieHeader(jar), origin, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://shop.example/a11y", option: "블랙", collectionIds: [] }),
  });
  expect(saved.status).toBe(201);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(1);

  const analyze = async () => (await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze()).violations;

  expect(await analyze()).toEqual([]);
  await expectNeutral(page.locator('[aria-current="page"], [aria-pressed="true"]').filter({ visible: true }).first(),
    ["background-color", "color"]);
  await expectNeutral(page.getByRole("button", { name: "링크 추가", exact: true }), ["background-color", "color"]);

  await page.getByRole("button", { name: "링크 추가", exact: true }).click();
  await expect(addDialog(page)).toBeVisible();
  expect(await analyze()).toEqual([]);
  await addDialog(page).getByRole("button", { name: "닫기", exact: true }).click();

  await cards(page).click();
  await expect(detailDialog(page)).toBeVisible();
  expect(await analyze()).toEqual([]);
});
