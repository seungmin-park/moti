import { expect, test } from "@playwright/test";

test("검색, 필터, 빈 목록과 초기화", async ({ page }) => {
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: "나의 위시리스트", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("예시 데이터", { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "상품 검색" }).fill("헤드폰");
  await expect(
    page.getByRole("button", { name: "무선 헤드폰 상세 보기" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "패브릭 라운지 체어 상세 보기" }),
  ).toHaveCount(0);
  await page.getByRole("searchbox", { name: "상품 검색" }).fill("없는상품");
  await expect(page.getByText("찾는 물건이 없어요")).toBeVisible();
  await page.getByRole("button", { name: "검색·필터 초기화" }).click();
  await expect(
    page.getByRole("button", { name: "패브릭 라운지 체어 상세 보기" }),
  ).toBeVisible();
});

test("링크 저장 실패에도 원본 링크를 보존하고 중복을 방지한다", async ({
  page,
}) => {
  await page.goto("/demo");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.com"))
      requests.push(request.url());
  });
  await page.getByRole("button", { name: "링크 추가", exact: true }).click();
  await page
    .getByLabel("상품 링크")
    .fill("https://example.com/new?size=M&utm_source=test");
  await page.getByRole("button", { name: "위시에 담기", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("정보 수집 중", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "실패 결과 보기" }).click();
  await expect(dialog.getByText("상품 정보를 가져오지 못했어요")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "원본 링크 열기" }),
  ).toHaveAttribute("href", "https://example.com/new?size=M&utm_source=test");
  await dialog.getByLabel("상품 이름").fill("나만의 상품");
  await dialog.getByRole("button", { name: "변경사항 저장" }).click();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "링크 추가", exact: true }).click();
  await page
    .getByLabel("상품 링크")
    .fill("https://example.com/new?utm_medium=another&size=M");
  await page.getByRole("button", { name: "위시에 담기", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("이미 담아둔 상품이에요"),
  ).toBeVisible();
  await expect(page.getByLabel("상품 이름")).toHaveValue("나만의 상품");
  expect(requests).toEqual([]);
});

test("메모와 컬렉션을 유지하며 구매완료와 실행 취소를 한다", async ({
  page,
}) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "무선 헤드폰 상세 보기" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("메모").fill("다음 생일에 꼭");
  await dialog.getByLabel("나를 위한 선물").check();
  await dialog.getByRole("button", { name: "변경사항 저장" }).click();
  await dialog.getByRole("button", { name: "구매완료로 이동" }).click();
  await expect(page.getByRole("status")).toContainText("구매완료");
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await page.getByRole("button", { name: "무선 헤드폰 상세 보기" }).click();
  await expect(dialog.getByLabel("메모")).toHaveValue("다음 생일에 꼭");
  await expect(dialog.getByLabel("나를 위한 선물")).toBeChecked();
  await dialog.getByRole("button", { name: "구매완료로 이동" }).click();
  await page
    .getByRole("button", { name: "구매완료", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "무선 헤드폰 상세 보기" }).click();
  await dialog.getByLabel("실구매가", { exact: false }).fill("0");
  await dialog.getByRole("button", { name: "구매 정보 저장" }).click();
  await expect(dialog.getByText("구매 정보를 저장했어요")).toBeVisible();
  await dialog.getByRole("button", { name: "위시로 되돌리기" }).click();
  await page
    .getByRole("button", { name: "위시리스트", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "무선 헤드폰 상세 보기" }).click();
  await expect(dialog.getByLabel("메모")).toHaveValue("다음 생일에 꼭");
});

test("컬렉션 생성, 이름 변경, 빈 상태와 상품 묶기", async ({ page }) => {
  await page.goto("/demo");
  await page
    .getByRole("button", { name: "컬렉션", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "새 컬렉션", exact: true }).click();
  await page
    .getByRole("textbox", { name: "컬렉션 이름", exact: true })
    .fill("겨울 준비");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await page.getByRole("button", { name: "겨울 준비 컬렉션 열기" }).click();
  await expect(page.getByText("아직 담아둔 물건이 없어요")).toBeVisible();
  await page.getByRole("button", { name: "컬렉션 이름 변경" }).click();
  await page
    .getByRole("textbox", { name: "컬렉션 이름", exact: true })
    .fill("겨울 선물");
  await page.getByRole("button", { name: "이름 저장" }).click();
  await expect(
    page.getByRole("heading", { name: "겨울 선물", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "위시리스트", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "무선 헤드폰 상세 보기" }).click();
  await page.getByLabel("겨울 선물", { exact: true }).check();
  await page.getByRole("button", { name: "변경사항 저장" }).click();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "컬렉션", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "겨울 선물 컬렉션 열기" }).click();
  await expect(
    page.getByRole("button", { name: "무선 헤드폰 상세 보기" }),
  ).toBeVisible();
});

test("공유 저장 안내와 세 가지 결과는 예시임을 표시한다", async ({ page }) => {
  await page.goto("/demo");
  await page
    .getByRole("button", { name: "공유 저장", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByText("iPhone에서 바로 담기")).toBeVisible();
  await page.getByRole("button", { name: "공유 저장 체험하기" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("위시에 담았어요", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "중복 예시" }).click();
  await expect(
    dialog.getByText("이미 담아둔 상품이에요", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "실패 예시" }).click();
  await expect(
    dialog.getByText("링크는 안전하게 담았어요", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("실제 저장이나 단축어 연결은 하지 않는 예시 화면이에요."),
  ).toBeVisible();
});

test("대화상자를 키보드로 닫으면 초점이 돌아오고 가로 넘침이 없다", async ({
  page,
}) => {
  await page.goto("/demo");
  const add = page.getByRole("button", { name: "링크 추가", exact: true });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
