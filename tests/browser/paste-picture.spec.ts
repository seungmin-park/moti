import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { expectNeutral } from "../support/neutral";
import { signInCookies } from "../support/session";

const { appUrl } = readDatabaseConfig();
const title = "막힌 쇼핑몰 램프";

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

// A shop that refuses to be read: the link is kept, with the owner's own name and no picture.
async function blocked(): Promise<Product> {
  const { owner } = fixture();
  const library = createSupabaseLibraryStore(owner.client);
  const product = (await library.saveLink(toLinkSaveCommand({ url: `https://blocked.example/${randomUUID()}`, option: "", collectionIds: [] }))).product;
  const jobs = createSupabaseCollectionStore(owner.client);
  const claim = await jobs.claim({ productId: product.id, generation: 1 });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  await jobs.fail(claim.job, "blocked_by_site");
  return library.changeProduct({ productId: product.id, revision: 1, change: { type: "details", title, note: "", collectionIds: [] } });
}

async function pastedColumn(product: Product): Promise<string | null> {
  const { rows } = await fixture().admin.query<{ pasted: string | null }>(
    "select pasted_picture_id::text as pasted from moti.products where id = $1", [product.id],
  );
  return rows[0].pasted;
}

// Generated pictures only: a product-like shape on a neutral ground.
const picture = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#d8d4ce" } })
  .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#4a4a4a"/></svg>`) }]);

// Random pixels do not compress, so this PNG is over the 2 MiB the screen sends as it is.
async function noisyPng(): Promise<Buffer> {
  const width = 1100;
  const height = 1000;
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 2654435761) >>> 24;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

// A real paste event, as the browser fires it for ⌘V, Ctrl+V or iPhone's 붙여넣기: a ClipboardEvent whose DataTransfer
// holds the copied file and, optionally, text around it.
async function pasteInto(target: Locator, file: { bytes: Buffer; type: string } | null, text = "") {
  await target.evaluate((element, { base64, type, text }) => {
    const data = new DataTransfer();
    if (text) data.setData("text/plain", text);
    if (base64 !== null) {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      data.items.add(new File([bytes], "copied", { type }));
    }
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, { base64: file ? file.bytes.toString("base64") : null, type: file?.type ?? "", text });
}

const card = (page: Page) => page.getByRole("button", { name: new RegExp(`^${title}, `) });
const detailDialog = (page: Page) => page.getByRole("dialog", { name: "담아둔 물건" });
const analyze = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations;

async function expectLoaded(image: Locator) {
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
}

async function openDetail(page: Page) {
  await page.goto("/");
  await card(page).click();
  return detailDialog(page);
}

test("소유자는 복사한 상품 사진을 상세에 붙여 넣어 미리 보고 저장하며, 카드·상세·새로고침에서 보이고 지우면 원래대로 돌아간다", async ({ page, context }) => {
  const product = await blocked();
  await signIn(context);
  const detail = await openDetail(page);
  const target = detail.getByRole("textbox", { name: "사진 붙여넣기" });
  await expect(target).toHaveAccessibleDescription(/상품 사진을 복사한 뒤 여기에 붙여 넣어요/);
  await expect(target).toHaveAttribute("contenteditable", "true");
  await expect(target).toHaveAttribute("inputmode", "none");
  await expect(detail.locator(".detail-picture .picture-placeholder")).toHaveText("링크를 담아두었어요");
  await expect(detail.getByRole("button", { name: "붙여 넣은 사진 지우기" })).toHaveCount(0);
  await expectNeutral(target, ["background-color", "color", "border-top-color"]);

  await target.focus();
  await pasteInto(target, { bytes: await picture(900, 700).png().toBuffer(), type: "image/png" }, "램프 상품 페이지");

  const preview = detail.getByRole("img", { name: "붙여 넣을 사진 미리보기" });
  await expectLoaded(preview);
  const save = detail.getByRole("button", { name: "사진 저장" });
  // The preview replaces the target, so the focus moves to 저장 for a keyboard owner to confirm.
  await expect(save).toBeFocused();
  expect(await pastedColumn(product)).toBeNull();
  expect(await analyze(page)).toEqual([]);

  await save.click();
  await expect(detail.getByRole("status").filter({ hasText: "붙여 넣은 사진을 저장했어요" })).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(target).toBeFocused();
  const pasted = await pastedColumn(product);
  expect(pasted).not.toBeNull();
  const detailPhoto = detail.getByRole("img", { name: `${title} 사진` });
  await expectLoaded(detailPhoto);
  await expect(detailPhoto).toHaveAttribute("src", new RegExp(`picture\\?v=${pasted}$`));
  await expect(detail.getByRole("button", { name: "붙여 넣은 사진 지우기" })).toBeVisible();
  expect(await analyze(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  const cardPhoto = card(page).locator("img");
  await expectLoaded(cardPhoto);
  await expect(cardPhoto).toHaveAttribute("src", new RegExp(`picture\\?v=${pasted}$`));

  await page.reload();
  await expectLoaded(card(page).locator("img"));
  await card(page).click();
  const clear = detailDialog(page).getByRole("button", { name: "붙여 넣은 사진 지우기" });
  await clear.click();
  await expect(detailDialog(page).getByRole("status").filter({ hasText: "붙여 넣은 사진을 지웠어요. 가져온 사진이 없어요." })).toBeVisible();
  await expect(clear).toHaveCount(0);
  await expect(detailDialog(page).getByRole("textbox", { name: "사진 붙여넣기" })).toBeFocused();
  await expect(detailDialog(page).locator(".detail-picture .picture-placeholder")).toHaveText("링크를 담아두었어요");
  expect(await pastedColumn(product)).toBeNull();
});

test("사진 없이 글만 붙여 넣으면 알리고, 2 MiB를 넘는 사진은 화면이 JPEG로 줄여 보내며 취소하면 아무것도 보내지 않는다", async ({ page, context }) => {
  const product = await blocked();
  await signIn(context);
  const detail = await openDetail(page);
  const target = detail.getByRole("textbox", { name: "사진 붙여넣기" });
  const sent: { type: string | null; size: number }[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith(`/api/products/${product.id}/picture`)) {
      sent.push({ type: request.headers()["content-type"] ?? null, size: request.postDataBuffer()?.byteLength ?? 0 });
    }
  });

  await target.focus();
  await pasteInto(target, null, "https://blocked.example/lamp");
  await expect(detail.getByRole("alert")).toHaveText("클립보드에 사진이 없어요. 상품 사진을 복사한 뒤 다시 붙여 넣어 주세요.");
  await expect(target).toHaveAttribute("aria-invalid", "true");
  await expect(target).toHaveText("");

  await pasteInto(target, { bytes: await picture(600, 600).png().toBuffer(), type: "image/png" });
  await expect(detail.getByRole("img", { name: "붙여 넣을 사진 미리보기" })).toBeVisible();
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await detail.getByRole("button", { name: "취소", exact: true }).click();
  await expect(detail.getByRole("img", { name: "붙여 넣을 사진 미리보기" })).toHaveCount(0);
  await expect(target).toBeFocused();
  expect(sent).toEqual([]);

  const noisy = await noisyPng();
  expect(noisy.byteLength).toBeGreaterThan(2 * 1024 * 1024);
  await pasteInto(target, { bytes: noisy, type: "image/png" });
  await detail.getByRole("button", { name: "사진 저장" }).click();
  await expect(detail.getByRole("status").filter({ hasText: "붙여 넣은 사진을 저장했어요" })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0].type).toBe("image/jpeg");
  expect(sent[0].size).toBeLessThan(2 * 1024 * 1024);
  expect(await pastedColumn(product)).not.toBeNull();
});

test("클립보드에서 가져오기 버튼은 읽은 사진을 미리 보이고, 읽기를 허용하지 않으면 길게 눌러 붙여 넣으라고 알린다", async ({ page, context, browserName }) => {
  const product = await blocked();
  const png = await picture(500, 400).png().toBuffer();
  if (browserName === "chromium") {
    // Chromium lets a test grant the permission and put a real picture on the system clipboard.
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(appUrl).origin });
  } else {
    // WebKit has no permission to grant here, so the page's clipboard answers with the picture: a stub of the
    // browser API, not iPhone's clipboard.
    await page.addInitScript((base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: "image/png" });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { read: async () => [{ types: ["text/plain", "image/png"], getType: async () => blob }] },
      });
    }, png.toString("base64"));
  }
  await signIn(context);
  const detail = await openDetail(page);
  if (browserName === "chromium") {
    await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
    }, png.toString("base64"));
  }

  await detail.getByRole("button", { name: "클립보드에서 가져오기" }).click();
  await expectLoaded(detail.getByRole("img", { name: "붙여 넣을 사진 미리보기" }));
  await detail.getByRole("button", { name: "사진 저장" }).click();
  await expect(detail.getByRole("status").filter({ hasText: "붙여 넣은 사진을 저장했어요" })).toBeVisible();
  expect(await pastedColumn(product)).not.toBeNull();

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: async () => { throw new DOMException("denied", "NotAllowedError"); } },
    });
  });
  await detail.getByRole("button", { name: "클립보드에서 가져오기" }).click();
  await expect(detail.getByRole("alert"))
    .toHaveText("클립보드를 읽도록 허용되지 않았어요. 붙여넣기 칸을 길게 누르거나 ⌘V·Ctrl+V로 붙여 넣어 주세요.");
});
