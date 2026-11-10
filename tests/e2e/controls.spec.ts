import { expect, test, type Locator } from "@playwright/test";

function controlTab(browserName: string) {
  return browserName === "webkit" && process.platform === "darwin"
    ? "Alt+Tab"
    : "Tab";
}

async function expectNeutral(locator: Locator, properties: string[]) {
  const colors = await locator.evaluate((element, names) => {
    const style = getComputedStyle(element);
    return names.map((name) => style.getPropertyValue(name));
  }, properties);
  for (const color of colors) {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    expect(channels, color).toHaveLength(3);
    expect(
      Math.max(...channels!) - Math.min(...channels!),
      color,
    ).toBeLessThanOrEqual(1);
  }
}

test("정렬 목록에서 현재 선택을 확인하고 클릭으로 가격순을 바꾼다", async ({ page }) => {
  await test.step("Given 최근 담은 순의 위시 목록", async () => {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "정렬: 최근 담은 순", exact: true }),
    ).toBeVisible();
  });
  await test.step("When 정렬 목록에서 낮은 가격순을 고른다", async () => {
    await page.getByRole("button", { name: /^정렬:/ }).click();
    await expect(page.getByRole("menu", { name: "정렬" })).toBeVisible();
    await expect(
      page.getByRole("menuitemradio", { name: "최근 담은 순" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: "낮은 가격순" }).click();
  });
  await test.step("Then 목록과 버튼이 선택한 가격순을 반영한다", async () => {
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "정렬: 낮은 가격순", exact: true }),
    ).toBeFocused();
    await expect(page.locator(".product-card h2")).toHaveText([
      "데스크 램프",
      "에브리데이 백팩",
      "데일리 러닝 스니커즈",
      "포터블 스피커",
      "패브릭 라운지 체어",
      "무선 헤드폰",
      "미러리스 카메라",
    ]);
    await page.getByRole("button", { name: /^정렬:/ }).click();
    await page.getByRole("searchbox", { name: "상품 검색" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "상품 검색" })).toBeFocused();
  });
});

test("정렬은 키보드 이동, 확정, 취소와 Tab 이동을 지원한다", async ({
  page,
  browserName,
}) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /^정렬:/ });
  await test.step("Given 정렬 버튼에 키보드 초점이 있는 상태", async () => {
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "최근 담은 순" })).toBeFocused();
  });
  await test.step("When 다른 항목으로 이동하고 Escape로 취소한다", async () => {
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitemradio", { name: "높은 가격순" })).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "낮은 가격순" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAccessibleName("정렬: 최근 담은 순");
  });
  await test.step("Then Enter와 Space로 확정하고 Tab으로 메뉴를 벗어날 수 있다", async () => {
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("menuitemradio", { name: "높은 가격순" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAccessibleName("정렬: 높은 가격순");
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Space");
    await page.keyboard.press("Home");
    await page.keyboard.press("Space");
    await expect(trigger).toHaveAccessibleName("정렬: 최근 담은 순");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).not.toBeFocused();
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press(controlTab(browserName));
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^전체/ })).toBeFocused();
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press(`Shift+${controlTab(browserName)}`);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test("링크 추가에서 여러 컬렉션을 고르고 입력 오류 뒤에도 선택을 유지한다", async ({ page }) => {
  await test.step("Given 링크 추가 창의 컬렉션 목록", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "링크 추가", exact: true }).click();
    await page.getByRole("button", { name: /^담을 컬렉션:/ }).click();
    await expect(page.getByRole("dialog").getByRole("checkbox")).toHaveCount(3);
  });
  await test.step("When 컬렉션 두 개를 고르고 잘못된 링크를 제출한다", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: "나를 위한 선물" }).check();
    await dialog.getByRole("checkbox", { name: "가벼운 주말" }).check();
    await dialog.getByLabel("상품 링크").fill("잘못된 링크");
    await dialog.getByRole("button", { name: "위시에 담기", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: /^담을 컬렉션:/ }).click();
    await expect(dialog.getByRole("checkbox", { name: "나를 위한 선물" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "가벼운 주말" })).toBeChecked();
  });
  await test.step("Then 링크를 고쳐 담으면 두 컬렉션에 저장된다", async () => {
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("상품 링크").fill("https://example.com/multiple-collections");
    await dialog.getByRole("button", { name: "위시에 담기", exact: true }).click();
    await expect(dialog.getByLabel("상품 이름")).toHaveValue("새로 담은 상품");
    await expect(dialog.getByRole("checkbox", { name: "나를 위한 선물" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "가벼운 주말" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "집을 더 좋아하게" })).not.toBeChecked();
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await page
      .getByRole("button", { name: "컬렉션", exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole("button", { name: "나를 위한 선물 컬렉션 열기" }).click();
    await expect(page.getByRole("button", { name: "새로 담은 상품 상세 보기" })).toBeVisible();
  });
});

test("현재 컬렉션을 기본 선택하되 모두 해제해서 담을 수도 있다", async ({ page }) => {
  await test.step("Given 컬렉션 안에서 링크 추가 창을 연 상태", async () => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "컬렉션", exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole("button", { name: "집을 더 좋아하게 컬렉션 열기" }).click();
    await page.getByRole("button", { name: "링크 추가", exact: true }).click();
    await page.getByRole("button", { name: /^담을 컬렉션:/ }).click();
    await expect(page.getByRole("checkbox", { name: "집을 더 좋아하게" })).toBeChecked();
  });
  await test.step("When 기본 선택을 해제하고 링크를 담는다", async () => {
    await page.getByRole("checkbox", { name: "집을 더 좋아하게" }).uncheck();
    await page.getByLabel("상품 링크").fill("https://example.com/no-collection");
    await page.getByRole("button", { name: "위시에 담기", exact: true }).click();
  });
  await test.step("Then 상품은 컬렉션 미분류 상태로 저장된다", async () => {
    await expect(page.getByLabel("상품 이름")).toHaveValue("새로 담은 상품");
    await expect(
      page.getByRole("dialog").locator('input[type="checkbox"]:checked'),
    ).toHaveCount(0);
  });
});

test("UI 팔레트와 입력 포커스는 중립 색상이며 키보드 위치를 표시한다", async ({
  page,
  browserName,
}) => {
  await page.goto("/");
  await test.step("Given 중립 색상의 브랜드, 버튼과 탐색 메뉴", async () => {
    await expectNeutral(page.locator(".brand-mark").first(), [
      "color",
      "background-color",
    ]);
    await expectNeutral(
      page.getByRole("button", { name: "링크 추가", exact: true }),
      ["color", "background-color"],
    );
    await expectNeutral(
      page.getByRole("button", { name: "위시리스트", exact: true }).filter({ visible: true }),
      ["color", "background-color"],
    );
  });
  await test.step("When 검색창과 링크 입력창을 클릭한다", async () => {
    const search = page.getByRole("searchbox", { name: "상품 검색" });
    await search.click();
    await expectNeutral(page.locator(".search-field"), [
      "background-color",
      "border-top-color",
      "outline-color",
    ]);
    await expect(search).toHaveCSS("outline-style", "none");
    await page.getByRole("button", { name: "링크 추가", exact: true }).click();
    const input = page.getByLabel("상품 링크");
    await input.click();
    await expect(input).toHaveCSS("outline-style", "none");
    await expectNeutral(input, ["background-color", "border-bottom-color"]);
    await page.getByRole("button", { name: /^담을 컬렉션:/ }).click();
    const checkbox = page.getByRole("checkbox", { name: "나를 위한 선물" });
    await checkbox.check();
    await expectNeutral(checkbox, ["accent-color"]);
    await page.getByRole("button", { name: "닫기", exact: true }).click();
  });
  await test.step("Then Tab으로 정렬 버튼에 도달하면 중립 초점 표시가 보인다", async () => {
    await page.getByRole("searchbox", { name: "상품 검색" }).focus();
    await page.keyboard.press(controlTab(browserName));
    const trigger = page.getByRole("button", { name: /^정렬:/ });
    await expect(trigger).toBeFocused();
    await expect(trigger).not.toHaveCSS("outline-style", "none");
    await expectNeutral(trigger, ["outline-color"]);
  });
});
