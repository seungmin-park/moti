import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function openPurchased(page: Page) {
  await page
    .getByRole("button", { name: "구매완료", exact: true })
    .filter({ visible: true })
    .click();
}

async function recordPrice(page: Page, title: string, price: string) {
  await page
    .getByRole("button", { name: `${title} 상세 보기`, exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("실구매가", { exact: false }).fill(price);
  await dialog.getByRole("button", { name: "구매 정보 저장" }).click();
  await expect(dialog.getByText("구매 정보를 저장했어요")).toBeVisible();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
}

test("구매 뒤 컬렉션 이름 변경 알림은 이전 구매의 실행 취소를 제공하지 않는다", async ({
  page,
}) => {
  await test.step("Given 상품을 구매완료로 옮긴 상태", async () => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "무선 헤드폰 구매완료로 이동", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "실행 취소", exact: true }),
    ).toBeVisible();
  });
  await test.step("When 컬렉션 이름을 바꾼다", async () => {
    await page
      .getByRole("button", { name: "컬렉션", exact: true })
      .filter({ visible: true })
      .click();
    await page
      .getByRole("button", { name: "나를 위한 선물 컬렉션 열기" })
      .click();
    await page.getByRole("button", { name: "컬렉션 이름 변경" }).click();
    await page
      .getByRole("textbox", { name: "컬렉션 이름", exact: true })
      .fill("이번 생일");
    await page.getByRole("button", { name: "이름 저장", exact: true }).click();
  });
  await test.step("Then 컬렉션 변경 알림에는 구매 실행 취소가 없고 구매 상태는 남는다", async () => {
    await expect(page.getByRole("status")).toContainText(
      "컬렉션 이름을 바꿨어요",
    );
    await expect(
      page.getByRole("button", { name: "실행 취소", exact: true }),
    ).toHaveCount(0);
    await openPurchased(page);
    await expect(
      page.getByRole("button", { name: "무선 헤드폰 상세 보기" }),
    ).toBeVisible();
  });
});

test("실구매가 미입력과 0원을 구매완료 카드에서 구분한다", async ({ page }) => {
  await test.step("Given 구매완료 상품의 가격이 미입력된 상태", async () => {
    await page.goto("/");
    await openPurchased(page);
  });
  await test.step("When 다른 상품의 실구매가로 0원을 기록한다", async () => {
    await recordPrice(page, "작업실 스탠드", "0");
  });
  await test.step("Then 미입력 상품에는 예시 가격을 구매액으로 표시하지 않는다", async () => {
    await expect(
      page
        .getByRole("button", { name: "작업실 스탠드 상세 보기" })
        .getByText("0원", { exact: true }),
    ).toBeVisible();
    const unknown = page.getByRole("button", { name: "여행용 백팩 상세 보기" });
    await expect(unknown).toContainText("실구매가 미입력");
    await expect(unknown).not.toContainText("99,000원");
  });
});

test("구매완료 가격 정렬은 카드에 보이는 실구매가를 따른다", async ({
  page,
}) => {
  await test.step("Given 예시 가격과 순서가 다른 실구매가를 기록한 상태", async () => {
    await page.goto("/");
    await openPurchased(page);
    await recordPrice(page, "작업실 스탠드", "1000000");
    await recordPrice(page, "여행용 백팩", "20000");
  });
  await test.step("When 낮은 가격순을 선택한다", async () => {
    await page.getByRole("button", { name: /^정렬:/ }).click();
    await page.getByRole("menuitemradio", { name: "낮은 가격순" }).click();
  });
  await test.step("Then 2만원 상품이 100만원 상품 앞에 나오고 높은 가격순은 반대다", async () => {
    await expect(page.locator(".product-card h2")).toHaveText([
      "여행용 백팩",
      "작업실 스탠드",
    ]);
    await page.getByRole("button", { name: /^정렬:/ }).click();
    await page.getByRole("menuitemradio", { name: "높은 가격순" }).click();
    await expect(page.locator(".product-card h2")).toHaveText([
      "작업실 스탠드",
      "여행용 백팩",
    ]);
  });
});

test("허용 길이의 공백 없는 상품 정보가 모바일 화면을 넘지 않는다", async ({
  page,
}) => {
  const title = "W".repeat(120);
  const collection = "C".repeat(40);
  await test.step("Given 375px 화면에서 긴 이름의 빈 컬렉션을 만든 상태", async () => {
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto("/");
    await page
      .getByRole("button", { name: "컬렉션", exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole("button", { name: "새 컬렉션", exact: true }).click();
    await page
      .getByRole("textbox", { name: "컬렉션 이름", exact: true })
      .fill(collection);
    await page.getByRole("button", { name: "만들기", exact: true }).click();
    await page
      .getByRole("button", { name: `${collection} 컬렉션 열기` })
      .click();
  });
  await test.step("When 긴 상품 이름, 옵션과 쇼핑몰 주소를 보관한다", async () => {
    await page.getByRole("button", { name: "링크 추가", exact: true }).click();
    await page
      .getByLabel("상품 링크")
      .fill(`https://${"a".repeat(63)}.example.com/item`);
    await page.getByLabel("옵션", { exact: false }).fill("O".repeat(120));
    await page
      .getByRole("button", { name: "위시에 담기", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("상품 이름").fill(title);
    await dialog.getByRole("button", { name: "변경사항 저장" }).click();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  });
  await test.step("Then 카드와 컬렉션 제목이 화면 폭 안에서 줄바꿈된다", async () => {
    await expect(
      page.getByRole("button", { name: `${title} 상세 보기` }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(375);
    await page
      .getByRole("button", { name: "위시리스트", exact: true })
      .filter({ visible: true })
      .click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(375);
  });
});

test("위시 목록과 상세는 기본 접근성 검사에 통과한다", async ({ page }) => {
  await page.goto("/");
  for (const view of ["wishlist", "detail"]) {
    await test.step(view, async () => {
      if (view === "detail")
        await page
          .getByRole("button", { name: "무선 헤드폰 상세 보기" })
          .click();
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(result.violations).toEqual([]);
    });
  }
});
