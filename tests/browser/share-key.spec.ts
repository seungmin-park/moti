import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { expectNeutral } from "../support/neutral";
import { signInCookies } from "../support/session";

const { appUrl } = readDatabaseConfig();
// A loopback address the app's fetch policy refuses: the woken collection settles as failed without leaving the machine.
const blockedLink = "http://127.0.0.1:9/shared";

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

async function signIn(context: BrowserContext) {
  const jar = await signInCookies(fixture().owner);
  await context.addCookies([...jar].map(([name, value]) => ({ name, value, url: appUrl, sameSite: "Lax" as const })));
}

// What the Shortcut sends: a bearer key and one url, no cookie.
function shortcut(secret: string, url = blockedLink) {
  return fetch(new URL("/api/share/links", appUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

const visibleButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const keyPanel = (page: Page) => page.getByRole("region", { name: "저장 키" });
const secretOf = async (page: Page) => {
  const header = (await keyPanel(page).locator(".share-secret").textContent()) ?? "";
  expect(header).toMatch(/^Bearer moti_sk_[A-Za-z0-9_-]{43}$/);
  return header.slice("Bearer ".length);
};
const claimsDone = (page: Page) => page.getByText(/연결됨|연결 완료|설치 완료|설치됨/);
const analyze = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations;

async function openShare(page: Page) {
  await visibleButton(page, "공유 저장").click();
  await expect(page.getByRole("heading", { level: 1, name: "공유 저장" })).toBeVisible();
}

test("소유자는 키를 한 번만 보고, 단축어가 그 키로 담으면 다시 열 때 상품과 마지막으로 담은 때를 본다", async ({ page, context }) => {
  await signIn(context);
  await page.goto("/");
  await openShare(page);

  await expect(keyPanel(page)).toContainText("아직 저장 키가 없어요.");
  await expect(page.getByText(new URL("/api/share/links", appUrl).href, { exact: true })).toBeVisible();
  await expect(claimsDone(page)).toHaveCount(0);
  await keyPanel(page).getByRole("button", { name: "저장 키 만들기", exact: true }).click();
  await expect(keyPanel(page)).toContainText("이 키는 지금 한 번만 보여요.");
  const secret = await secretOf(page);
  await keyPanel(page).getByRole("button", { name: "헤더 값 복사", exact: true }).click();
  await expect(keyPanel(page).getByRole("status")).toContainText(/복사했어요|직접 복사해 주세요/);

  await visibleButton(page, "위시리스트").click();
  await openShare(page);
  await expect(keyPanel(page).locator(".share-secret")).toHaveCount(0);
  await expect(keyPanel(page)).toContainText(`저장 키 ••••${secret.slice(-4)}`);
  await expect(keyPanel(page)).toContainText("아직 이 키를 쓴 적이 없어요.");
  await expect(page.locator("body")).not.toContainText(secret);

  expect((await shortcut(secret)).status).toBe(201);

  await page.reload();
  const card = page.getByRole("button", { name: /상세 보기$/ });
  await expect(card).toHaveCount(1);
  // Nothing collected it at share time; opening the library woke it, and the strict fetch policy then refused the link.
  await expect(card).toContainText("정보를 가져오지 못했어요", { timeout: 20_000 });
  await openShare(page);
  await expect(keyPanel(page)).toContainText("마지막으로 이 키를 쓴 때:");
  await expect(claimsDone(page)).toHaveCount(0);
});

test("안내는 실제 iPhone에서 동작한 구성을 보이고, 쇼핑 앱의 글로 담은 상품은 수집하지 못해도 글 속 이름으로 보인다", async ({ page, context }) => {
  await signIn(context);
  await page.goto("/");
  await openShare(page);
  const guide = page.getByRole("region", { name: "iPhone 공유 단축어 설정" });
  await expect(guide).toContainText("편집기 맨 위에 입력 받기 블록");
  await expect(guide).toContainText("맨 위 블록의 ‘입력이 없는 경우: 계속하기’에서 ‘계속하기’를 눌러 ‘클립보드 가져오기’로");
  await expect(guide).not.toContainText("같은 곳에서");
  await expect(guide).toContainText("요청 본문은 JSON으로 키 url에 ‘단축어 입력’");
  await expect(guide).toContainText("공유 메뉴에 단축어가 없는 앱(예: 네이버 앱)");
  await expect(guide).not.toContainText("목록에서 항목 가져오기");
  await keyPanel(page).getByRole("button", { name: "저장 키 만들기", exact: true }).click();
  const secret = await secretOf(page);

  const response = await fetch(new URL("/api/share/links", appUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ url: `쿠팡을 추천합니다!\n로투스 벨기에 와플 초코\n${blockedLink}` }),
  });
  expect(response.status).toBe(201);

  await page.reload();
  const card = page.getByRole("button", { name: /상세 보기$/ });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAccessibleName("로투스 벨기에 와플 초코, 127.0.0.1 상세 보기");
  // The loopback link fails collection; the shared name stays.
  await expect(card).toContainText("정보를 가져오지 못했어요", { timeout: 20_000 });
  await expect(card).toContainText("로투스 벨기에 와플 초코");
});

test("새 키로 바꾸고 폐기할 때 확인은 취소에 먼저 머물고, 바꾼 뒤 이전 키와 폐기한 키로는 담지 못한다", async ({ page, context }) => {
  await signIn(context);
  await page.goto("/");
  await openShare(page);
  await keyPanel(page).getByRole("button", { name: "저장 키 만들기", exact: true }).click();
  const first = await secretOf(page);
  await keyPanel(page).getByRole("button", { name: "붙여 넣었어요", exact: true }).click();
  await expect(keyPanel(page).locator(".share-secret")).toHaveCount(0);

  await keyPanel(page).getByRole("button", { name: "새 키로 바꾸기", exact: true }).click();
  const confirm = keyPanel(page).getByRole("group", { name: /지금 키\(••••.{4}\)는 바로 폐기돼요/ });
  await expect(confirm.getByRole("button", { name: "취소", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(keyPanel(page).getByRole("button", { name: "새 키로 바꾸기", exact: true })).toBeFocused();
  await keyPanel(page).getByRole("button", { name: "새 키로 바꾸기", exact: true }).click();
  await confirm.getByRole("button", { name: "새 키로 바꾸기", exact: true }).click();
  const second = await secretOf(page);
  expect(second).not.toBe(first);
  expect((await shortcut(first)).status).toBe(401);
  expect((await shortcut(second, "http://127.0.0.1:9/second")).status).toBe(201);
  await keyPanel(page).getByRole("button", { name: "붙여 넣었어요", exact: true }).click();

  await keyPanel(page).getByRole("button", { name: "키 폐기", exact: true }).click();
  const revoke = keyPanel(page).getByRole("group", { name: /더 이상 담을 수 없어요/ });
  await expect(revoke.getByRole("button", { name: "취소", exact: true })).toBeFocused();
  await revoke.getByRole("button", { name: "키 폐기", exact: true }).click();
  await expect(keyPanel(page)).toContainText(`이전 키(••••${second.slice(-4)})는`);
  await expect(keyPanel(page)).toContainText("그 키를 넣은 단축어로는 더 이상 담을 수 없어요.");
  const refused = await shortcut(second, "http://127.0.0.1:9/third");
  expect(refused.status).toBe(401);
  expect(await refused.json()).toMatchObject({ error: "share_key_rejected" });
  await expect(keyPanel(page).getByRole("button", { name: "저장 키 만들기", exact: true })).toBeVisible();
  await expect(claimsDone(page)).toHaveCount(0);
});

test("공유 저장 보기는 키가 없을 때와 보일 때 기본 접근성 검사를 통과하고, 키보드 포커스가 보이며 선택 표시는 중립 색이다", async ({ page, context }, info) => {
  await signIn(context);
  await page.goto("/");
  await openShare(page);
  await expect(keyPanel(page)).toContainText("아직 저장 키가 없어요.");
  expect(await analyze(page)).toEqual([]);
  await expectNeutral(page.locator('[aria-current="page"]').filter({ visible: true }).first(), ["background-color", "color"]);

  const create = keyPanel(page).getByRole("button", { name: "저장 키 만들기", exact: true });
  // WebKit's Tab moves only between form fields unless a system setting says otherwise, so the keyboard ring is checked
  // where Tab reaches buttons; the confirmations' focus on 취소 is checked on both devices.
  if (info.project.name === "desktop-chromium") {
    await create.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(create).toBeFocused();
    expect(await create.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    await expectNeutral(create, ["outline-color"]);
  }
  await expectNeutral(create, ["background-color", "color"]);

  await create.click();
  await expect(keyPanel(page).locator(".share-secret")).toBeVisible();
  expect(await analyze(page)).toEqual([]);
  await expectNeutral(keyPanel(page).locator(".share-secret"), ["background-color", "color"]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
