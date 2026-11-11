import { expect, test } from "@playwright/test";

test("컬렉션 드롭다운에서 검색하고 새 컬렉션을 만들어 함께 담는다", async ({ page }) => {
  await test.step("Given 링크와 옵션을 입력한 추가 창", async () => {
    await page.goto("/demo");
    await page.getByRole("button", { name: "링크 추가", exact: true }).click();
    await page.getByLabel("상품 링크").fill("https://example.com/inline-collection");
    await page.getByLabel("옵션 선택", { exact: true }).fill("크림 · 250mm");
    await expect(page.getByRole("dialog").getByRole("checkbox")).toHaveCount(0);
  });
  await test.step("When 기존 컬렉션을 고르고 없는 이름을 만든다", async () => {
    await page.getByRole("button", { name: /^담을 컬렉션:/ }).click();
    await page.getByRole("checkbox", { name: "나를 위한 선물" }).check();
    const search = page.getByRole("textbox", { name: "컬렉션 검색 또는 새 이름" });
    await search.fill("여름 여행");
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await page.getByRole("button", { name: "여름 여행 컬렉션 만들고 선택", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "여름 여행" })).toBeChecked();
    await expect(page.getByLabel("상품 링크")).toHaveValue("https://example.com/inline-collection");
    await expect(page.getByLabel("옵션 선택", { exact: true })).toHaveValue("크림 · 250mm");
    await search.fill("");
    await expect(page.getByRole("checkbox", { name: "나를 위한 선물" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "여름 여행" })).toBeChecked();
  });
  await test.step("Then 새 컬렉션과 기존 컬렉션에 같은 상품을 담는다", async () => {
    await page.getByRole("button", { name: "위시에 담기", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("상품 이름")).toHaveValue("새로 담은 상품");
    await expect(dialog.getByRole("checkbox", { name: "나를 위한 선물" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "여름 여행" })).toBeChecked();
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await page.getByRole("button", { name: "컬렉션", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "여름 여행 컬렉션 열기" }).click();
    await expect(page.getByRole("button", { name: "새로 담은 상품 상세 보기" })).toBeVisible();
  });
});

test("검색 Enter와 IME는 링크를 제출하지 않고 Escape는 드롭다운부터 닫는다", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "링크 추가", exact: true }).click();
  await page.getByLabel("상품 링크").fill("https://example.com/picker-keyboard");
  const trigger = page.getByRole("button", { name: /^담을 컬렉션:/ });
  await trigger.click();
  const search = page.getByRole("textbox", { name: "컬렉션 검색 또는 새 이름" });
  await expect(search).toBeFocused();
  await search.fill("책상 정리");
  for (const key of ["Enter", "Escape"]) {
    const cancelled = await search.evaluate((element, key) => {
      const event = new KeyboardEvent("keydown", {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, key);
    expect(cancelled).toBe(false);
    await expect(search).toBeVisible();
  }
  await expect(page.getByRole("checkbox", { name: "책상 정리" })).toHaveCount(0);
  await expect(page.getByLabel("상품 링크")).toBeVisible();
  await search.press("Enter");
  await expect(page.getByRole("checkbox", { name: "책상 정리" })).toBeChecked();
  await expect(page.getByLabel("상품 링크")).toHaveValue("https://example.com/picker-keyboard");
  await search.press("Enter");
  await expect(page.getByRole("checkbox", { name: "책상 정리" })).toHaveCount(1);
  await expect(page.getByLabel("상품 링크")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("dialog")).toBeVisible();
  await trigger.click();
  await page.getByLabel("상품 링크").focus();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("이름의 공백·중복·길이를 처리하고 바깥 클릭 후에도 선택을 유지한다", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "링크 추가", exact: true }).click();
  const trigger = page.getByRole("button", { name: /^담을 컬렉션:/ });
  await trigger.click();
  const search = page.getByRole("textbox", { name: "컬렉션 검색 또는 새 이름" });
  await search.fill("   ");
  await search.press("Enter");
  await expect(page.getByRole("button", { name: /컬렉션 만들고 선택$/ })).toHaveCount(0);
  await search.fill(" 나를 위한 선물 ");
  await expect(page.getByRole("checkbox", { name: "나를 위한 선물" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /컬렉션 만들고 선택$/ })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "나를 위한 선물" }).check();
  await search.fill("가".repeat(41));
  await expect(page.getByText("컬렉션 이름은 1~40자로 입력해 주세요.", { exact: true })).toBeVisible();
  await search.press("Enter");
  await search.fill("");
  await expect(page.getByRole("checkbox")).toHaveCount(3);
  await expect(page.getByRole("checkbox", { name: "나를 위한 선물" })).toBeChecked();
  await page.getByLabel("상품 링크").click();
  await expect(search).toHaveCount(0);
  await expect(page.getByLabel("상품 링크")).toBeFocused();
  await expect(trigger).toContainText("나를 위한 선물");
  await trigger.click();
  await expect(page.getByRole("checkbox", { name: "나를 위한 선물" })).toBeChecked();
});

test("많은 컬렉션과 긴 이름도 좁은 추가 창 안에서 선택할 수 있다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo");
  await page.getByRole("button", { name: "링크 추가", exact: true }).click();
  const trigger = page.getByRole("button", { name: /^담을 컬렉션:/ });
  await trigger.click();
  const search = page.getByRole("textbox", { name: "컬렉션 검색 또는 새 이름" });
  const longName = "공백없는컬렉션이름".repeat(4);
  for (const name of [longName, "여행 준비", "작업 공간", "운동", "읽을 책"]) {
    await search.fill(name);
    await page.getByRole("button", { name: `${name} 컬렉션 만들고 선택`, exact: true }).click();
    await expect(page.getByRole("checkbox", { name, exact: true })).toBeChecked();
  }
  await search.fill("");
  const options = page.getByRole("group", { name: "컬렉션 목록", exact: true });
  await expect(page.getByRole("checkbox")).toHaveCount(8);
  await expect.poll(() => options.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.getByRole("checkbox", { name: "읽을 책", exact: true }).uncheck();
  await search.press("Escape");
  await expect(trigger).toContainText(longName);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
