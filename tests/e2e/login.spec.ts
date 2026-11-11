import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNeutral } from "../support/neutral";

const signIn = "Google 계정으로 계속하기";

test("로그인 오류 코드마다 원인에 맞는 안내를 보여준다", async ({ page }) => {
  for (const [code, title] of [
    ["forbidden", "이 Google 계정은 사용할 수 없어요"],
    ["unconfigured", "보관함 소유자 설정이 아직 없어요"],
    ["unavailable", "로그인 서비스에 연결하지 못했어요"],
    ["cancelled", "Google 로그인이 완료되지 않았어요"],
    ["callback", "로그인을 확인하지 못했어요"],
    ["token_expired", "로그인을 완료하지 못했어요"],
  ]) {
    await test.step(code, async () => {
      await page.goto(`/login?error=${code}`);
      await expect(page.getByRole("main").getByRole("alert")).toContainText(title);
      await expect(page.getByRole("link", { name: signIn })).toBeVisible();
    });
  }
});

test("오류 없이 열면 안내 없이 Google 로그인과 목업 둘러보기를 제공한다", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("link", { name: signIn })).toHaveAttribute("href", "/auth/login");
  await expect(page.getByRole("link", { name: "예시 데이터로 둘러보기" })).toHaveAttribute("href", "/demo");
});

test("Google 로그인을 누르면 실제 로그인 경로를 거쳐 설정 누락 안내로 돌아온다", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: signIn }).click();
  await expect(page).toHaveURL(/\/login\?error=unconfigured$/);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("보관함 소유자 설정이 아직 없어요");
});

test("로그인 화면은 기본 접근성 검사에 통과하고 중립 색만 쓴다", async ({ page }) => {
  await page.goto("/login?error=forbidden");
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  const button = page.getByRole("link", { name: signIn });
  await button.focus();
  await expectNeutral(button, ["background-color", "border-top-color", "color", "outline-color"]);
  await expectNeutral(page.locator("body"), ["background-color", "color"]);
});
