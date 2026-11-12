import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import type { CollectionJob } from "../../src/features/metadata/application/collection";
import type { ImageCopy } from "../../src/features/metadata/application/picture-copy";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { HTTP_OWNER_SUBJECT, readDatabaseConfig } from "../support/database-config";
import { expectNeutral } from "../support/neutral";
import { signInCookies } from "../support/session";

const config = readDatabaseConfig();
const shopImage = "https://cdn.shop.example/products/lamp.jpg";

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
  await context.addCookies([...jar].map(([name, value]) => ({ name, value, url: config.appUrl, sameSite: "Lax" as const })));
}

// Seeds what a collection run leaves behind: the owner's token uploads to the name claim reserved, then settles.
async function collected(title: string, image: ImageCopy): Promise<{ product: Product; job: CollectionJob }> {
  const { owner } = fixture();
  const product = (await createSupabaseLibraryStore(owner.client)
    .saveLink(toLinkSaveCommand({ url: `https://shop.example/${encodeURIComponent(title)}`, option: "", collectionIds: [] }))).product;
  const jobs = createSupabaseCollectionStore(owner.client);
  const claim = await jobs.claim({ productId: product.id, generation: 1 });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  if (image.outcome === "copied") {
    const webp = await sharp({ create: { width: 600, height: 450, channels: 3, background: "#7a6a5a" } }).webp().toBuffer();
    const upload = await owner.client.storage.from(PICTURE_BUCKET).upload(claim.job.picture, webp, { contentType: "image/webp" });
    if (upload.error) throw new Error(`사진을 올리지 못했습니다: ${upload.error.message}`);
  }
  await jobs.complete(claim.job, { title, price: { amountMinor: 59000, currency: "KRW" }, imageSourceUrl: shopImage }, image);
  return { product, job: claim.job };
}

const card = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title}, `) });
const detailDialog = (page: Page) => page.getByRole("dialog", { name: "담아둔 물건" });

async function expectLoaded(image: Locator) {
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBeGreaterThan(0);
}

test("담아둔 상품의 비공개 사진 사본을 카드와 상세에 보이고 쇼핑몰 주소로는 요청하지 않는다", async ({ page, context }) => {
  const { product, job } = await collected("사진 있는 조명", { outcome: "copied" });
  await collected("사진 없는 의자", { outcome: "failed", code: "blocked_by_site" });
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await signIn(context);

  await page.goto("/");

  const photo = card(page, "사진 있는 조명").locator("img");
  await expect.poll(async () => new URL((await photo.getAttribute("src"))!, config.appUrl).href)
    .toBe(new URL(`/api/products/${product.id}/picture?v=${job.id}`, config.appUrl).href);
  await expect(photo).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(photo).toHaveAttribute("alt", "");
  await expectLoaded(photo);
  const placeholder = card(page, "사진 없는 의자").locator(".picture-placeholder");
  await expect(placeholder).toHaveText("사진을 가져오지 못했어요");
  await expect(card(page, "사진 없는 의자").locator("img")).toHaveCount(0);
  await expectNeutral(placeholder, ["background-color", "color"]);

  await card(page, "사진 있는 조명").click();
  const detailPhoto = detailDialog(page).getByRole("img", { name: "사진 있는 조명 사진" });
  await expectLoaded(detailPhoto);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await detailDialog(page).getByRole("button", { name: "닫기", exact: true }).click();

  await card(page, "사진 없는 의자").click();
  const detail = detailDialog(page);
  await expect(detail.getByText("사진을 가져오지 못했어요", { exact: true }).first()).toBeVisible();
  await expect(detail.getByText("쇼핑몰이 사진 요청을 막았어요. 이름과 가격은 가져왔어요.")).toBeVisible();
  await expect(detail.getByRole("heading", { name: "사진 없는 의자" })).toBeVisible();
  await expect(detail.getByText("₩59,000")).toBeVisible();
  await expect(detail.getByRole("button", { name: "다시 가져오기", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);

  expect(requested.filter((url) => url.includes("cdn.shop.example"))).toEqual([]);
  expect(requested.some((url) => new URL(url).pathname.startsWith(`/storage/v1/object/sign/${PICTURE_BUCKET}/`))).toBe(true);
  expect(requested.filter((url) => url.includes("/storage/v1/object/public/"))).toEqual([]);
});

test("사본이 저장소에서 사라지면 깨진 이미지 대신 중립 자리표시를 보인다", async ({ page, context }) => {
  const { job } = await collected("사라진 사진의 조명", { outcome: "copied" });
  const administration = createClient(config.apiUrl, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const removed = await administration.storage.from(PICTURE_BUCKET).remove([job.picture]);
  expect(removed.error).toBeNull();
  await signIn(context);

  await page.goto("/");

  const placeholder = card(page, "사라진 사진의 조명").locator(".picture-placeholder");
  await expect(placeholder).toHaveText("사진을 불러오지 못했어요");
  await expect(card(page, "사라진 사진의 조명").locator("img")).toHaveCount(0);
  await expectNeutral(placeholder, ["background-color", "color"]);
});
