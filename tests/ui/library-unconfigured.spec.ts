import { expect, test } from "@playwright/test";
import { seenText, watchForText } from "../support/text-watch";

const demoText = ["무선 헤드폰", "패브릭 라운지 체어", "SOUND ROOM", "집을 더 좋아하게", "예시 가격", "새로고침하면 처음으로"];

test("소유자 설정이 없는 서버에서 보관함을 열면 예시 상품 없이 설정 누락 안내로 간다", async ({ page }) => {
  await watchForText(page, demoText);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?error=unconfigured$/);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("보관함 소유자 설정이 아직 없어요");
  expect(await seenText(page)).toEqual([]);
});
