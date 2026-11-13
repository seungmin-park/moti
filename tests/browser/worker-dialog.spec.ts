import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { expectNeutral } from "../support/neutral";
import { signInCookies } from "../support/session";

const { appUrl } = readDatabaseConfig();
// A loopback link the app's fetch policy refuses: the scheduled run settles it as failed without leaving the machine.
const blockedLink = "http://127.0.0.1:9/scheduled";

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

// What GitHub sends: a bearer key and nothing else.
const scheduled = (secret: string) =>
  fetch(new URL("/api/scheduled-runs", appUrl), { method: "POST", headers: { authorization: `Bearer ${secret}` } });

const visibleButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "자동 확인" });
const keyPanel = (page: Page) => dialog(page).getByRole("region", { name: "작업 키" });
const record = (page: Page) => dialog(page).getByRole("region", { name: "최근 실행" });
const secretOf = async (page: Page) => {
  const secret = (await keyPanel(page).locator(".share-secret").textContent()) ?? "";
  expect(secret).toMatch(/^moti_wk_[A-Za-z0-9_-]{43}$/);
  return secret;
};
const claimsDone = (page: Page) => page.getByText(/연결됨|연결 완료|설치 완료|설치됨/);
const analyze = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations;

async function openWorker(page: Page) {
  await visibleButton(page, "자동 확인").click();
  await expect(dialog(page)).toBeVisible();
}

async function closeWorker(page: Page) {
  await dialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}

test("소유자는 작업 키를 한 번만 보고, GitHub처럼 실행하면 다시 열 때 실행 기록과 이 키로 실행을 시작한 때를 본다", async ({ page, context }) => {
  await createSupabaseLibraryStore(fixture().owner.client).saveLink(toLinkSaveCommand({ url: blockedLink, option: "", collectionIds: [] }));
  await fixture().admin.query("update moti.metadata_jobs set attempts = 1 where owner_id = $1", [fixture().owner.id]);
  await signIn(context);
  await page.goto("/");
  await openWorker(page);

  await expect(keyPanel(page)).toContainText("아직 작업 키가 없어요.");
  await expect(dialog(page)).toContainText("MOTI_WORKER_TOKEN");
  await expect(dialog(page)).toContainText("MOTI_WORKER_URL");
  await expect(dialog(page).getByText(new URL(appUrl).origin, { exact: true })).toBeVisible();
  await expect(record(page)).toContainText("아직 실행 기록이 없어요.");
  await expect(claimsDone(page)).toHaveCount(0);
  await keyPanel(page).getByRole("button", { name: "작업 키 만들기", exact: true }).click();
  await expect(keyPanel(page)).toContainText("이 키는 지금 한 번만 보여요.");
  const secret = await secretOf(page);
  await expect(keyPanel(page).getByRole("button", { name: "키 복사", exact: true })).toBeFocused();

  await closeWorker(page);
  await openWorker(page);
  await expect(keyPanel(page).locator(".share-secret")).toHaveCount(0);
  await expect(keyPanel(page)).toContainText(`작업 키 ••••${secret.slice(-4)}`);
  await expect(keyPanel(page)).toContainText("아직 이 키로 실행한 적이 없어요.");
  await expect(page.locator("body")).not.toContainText(secret);

  const run = await scheduled(secret);
  expect(run.status).toBe(200);
  expect(await run.json()).toMatchObject({ stop: "done", collections: { collected: 0, failed: 1 } });

  await closeWorker(page);
  await openWorker(page);
  await expect(keyPanel(page)).toContainText("마지막으로 이 키로 실행을 시작한 때:");
  await expect(record(page)).toContainText("수집 0 · 실패 1");
  await expect(record(page)).toContainText("할 일을 모두 마쳤어요.");
  await expect(record(page)).toContainText("1건 · 안전을 위해 열지 않는 주소예요.");
  await expect(claimsDone(page)).toHaveCount(0);
});

test("새 키로 바꾸고 폐기할 때 확인은 취소에 먼저 머물고, 바꾼 뒤 이전 키와 폐기한 키로는 실행하지 못한다", async ({ page, context }) => {
  await signIn(context);
  await page.goto("/");
  await openWorker(page);
  await keyPanel(page).getByRole("button", { name: "작업 키 만들기", exact: true }).click();
  const first = await secretOf(page);
  await keyPanel(page).getByRole("button", { name: "붙여 넣었어요", exact: true }).click();
  await expect(keyPanel(page).locator(".share-secret")).toHaveCount(0);

  await keyPanel(page).getByRole("button", { name: "새 키로 바꾸기", exact: true }).click();
  const confirm = keyPanel(page).getByRole("group", { name: /진행 중인 실행도 멈춰요\. GitHub 비밀값도/ });
  await expect(confirm.getByRole("button", { name: "취소", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
  await expect(keyPanel(page).getByRole("button", { name: "새 키로 바꾸기", exact: true })).toBeFocused();
  await keyPanel(page).getByRole("button", { name: "새 키로 바꾸기", exact: true }).click();
  await confirm.getByRole("button", { name: "새 키로 바꾸기", exact: true }).click();
  const second = await secretOf(page);
  expect(second).not.toBe(first);
  expect((await scheduled(first)).status).toBe(401);
  expect((await scheduled(second)).status).toBe(200);
  await keyPanel(page).getByRole("button", { name: "붙여 넣었어요", exact: true }).click();

  await keyPanel(page).getByRole("button", { name: "키 폐기", exact: true }).click();
  const revoke = keyPanel(page).getByRole("group", { name: /예약 실행이 더 이상 moti에 들어오지 못하고/ });
  await expect(revoke.getByRole("button", { name: "취소", exact: true })).toBeFocused();
  await revoke.getByRole("button", { name: "키 폐기", exact: true }).click();
  await expect(keyPanel(page)).toContainText(`이전 키(••••${second.slice(-4)})는`);
  await expect(keyPanel(page)).toContainText("그 키로는 더 이상 실행할 수 없어요.");
  const refused = await scheduled(second);
  expect(refused.status).toBe(401);
  expect(await refused.json()).toMatchObject({ error: "worker_key_rejected" });
  await expect(keyPanel(page).getByRole("button", { name: "작업 키 만들기", exact: true })).toBeVisible();
  await expect(claimsDone(page)).toHaveCount(0);
});

test("자동 확인은 키가 없을 때와 보일 때 접근성 검사를 통과하고 중립 색이며, 끊긴 실행만 빨간색이고 오래 실행이 없으면 알린다", async ({ page, context }, info) => {
  await signIn(context);
  await page.goto("/");
  await openWorker(page);
  await expect(keyPanel(page)).toContainText("아직 작업 키가 없어요.");
  expect(await analyze(page)).toEqual([]);
  const create = keyPanel(page).getByRole("button", { name: "작업 키 만들기", exact: true });
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
  await keyPanel(page).getByRole("button", { name: "붙여 넣었어요", exact: true }).click();

  const { rows } = await fixture().admin.query<{ id: string }>("select id from moti.worker_keys where owner_id = $1", [fixture().owner.id]);
  await fixture().admin.query("update moti.worker_keys set created_at = now() - interval '30 hours' where id = $1", [rows[0].id]);
  await fixture().admin.query(
    `insert into moti.worker_runs (owner_id, key_id, started_at, finished_at, stop_reason, collected)
     values ($1, $2, now() - interval '28 hours', now() - interval '28 hours' + interval '90 seconds', 'cut', 2),
            ($1, $2, now() - interval '29 hours', now() - interval '29 hours' + interval '40 seconds', 'done', 1)`,
    [fixture().owner.id, rows[0].id],
  );
  await closeWorker(page);
  await openWorker(page);
  await expect(record(page)).toContainText("26시간 넘게 실행 기록이 없어요.");
  const cut = record(page).locator(".worker-run-state.cut");
  await expect(cut).toHaveText("끝까지 실행되지 못했어요.");
  const done = record(page).locator(".worker-run-state").filter({ hasText: "할 일을 모두 마쳤어요." });
  await expectNeutral(done, ["color"]);
  const red = await cut.evaluate((element) => getComputedStyle(element).color.match(/[\d.]+/g)!.slice(0, 3).map(Number));
  expect(red[0] - Math.max(red[1], red[2])).toBeGreaterThan(40);
  expect(await analyze(page)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(claimsDone(page)).toHaveCount(0);
});
