import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand, toLibraryRestoreCommand, type LibraryRestoreInput } from "../../src/features/library/application/commands";
import type { LibraryBackup, Product } from "../../src/features/library/domain/library";
import { PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import type { CollectionJob } from "../../src/features/metadata/application/collection";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { seoulToday } from "../../src/features/wishlist/product-fields";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const library = (client: SupabaseClient = fixture.owner.client) => createSupabaseLibraryStore(client);
const jobs = () => createSupabaseCollectionStore(fixture.owner.client);
// A 1×1 lossless WebP.
const webp = Buffer.from("524946461a000000574542505650384c0d0000002f0000001007101111888808", "hex");
const today = () => seoulToday(new Date());

const restore = (file: LibraryRestoreInput, client?: SupabaseClient) =>
  library(client).restoreLibrary(toLibraryRestoreCommand(file, today()));

// The file as the backup reader hands it over, without format, version and export time.
function asFile(backup: LibraryBackup): LibraryRestoreInput {
  return {
    collections: backup.collections,
    products: backup.products.map((product) => ({
      sourceUrl: product.sourceUrl,
      option: product.option,
      collectedTitle: product.collectedTitle,
      ownerTitle: product.ownerTitle,
      note: product.note,
      collections: product.collectionNames,
      addedAt: product.addedAt,
      purchase: product.purchase,
      lastSuccessfulPrice: product.lastSuccessfulPrice,
    })),
  };
}

const file: LibraryRestoreInput = {
  collections: [
    { name: "거실", createdAt: "2026-10-02T03:00:00.123Z" },
    { name: "Desk", createdAt: "2026-10-03T03:00:00.000Z" },
  ],
  products: [
    {
      sourceUrl: "https://shop.example/lamp?utm_source=x",
      option: "",
      collectedTitle: "무드등",
      ownerTitle: null,
      note: "",
      collections: [],
      addedAt: "2026-10-06T01:00:00.000Z",
      purchase: { status: "wish" },
      lastSuccessfulPrice: { amountMinor: 129000, currency: "KRW", checkedAt: "2026-11-01T00:00:00.000Z" },
    },
    {
      sourceUrl: "https://www.shop.example/table",
      option: "블랙 / M",
      collectedTitle: "오크 사이드 테이블",
      ownerTitle: "내 테이블",
      note: "  선물용\n사이즈 확인  ",
      collections: ["거실", "Desk"],
      addedAt: "2026-10-05T01:00:00.456Z",
      purchase: { status: "purchased", date: null, price: { amountMinor: 0, currency: "KRW" } },
      lastSuccessfulPrice: null,
    },
    {
      sourceUrl: "https://shop.example/chair",
      option: "",
      collectedTitle: "새로 담은 상품",
      ownerTitle: null,
      note: "",
      collections: ["Desk"],
      addedAt: "2026-10-04T01:00:00.000Z",
      purchase: { status: "purchased", date: "2026-11-01", price: null },
      lastSuccessfulPrice: null,
    },
  ],
};

async function saved(url = `https://shop.example/${randomUUID()}`, collectionIds: string[] = []): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({ url, option: "", collectionIds }))).product;
}

async function claimed(product: Product): Promise<CollectionJob> {
  const claim = await jobs().claim({ productId: product.id, generation: product.metadata.generation });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  return claim.job;
}

async function withPicture(product: Product, title: string): Promise<string> {
  const job = await claimed(product);
  const uploaded = await fixture.owner.client.storage.from(PICTURE_BUCKET).upload(job.picture, webp, { contentType: "image/webp", upsert: false });
  expect(uploaded.error).toBeNull();
  const price = { amountMinor: 59000, currency: "KRW" };
  expect(await jobs().complete(job, { title, price, imageSourceUrl: "https://cdn.shop.example/a.jpg" }, { outcome: "copied" }))
    .toMatchObject({ kind: "applied" });
  return job.picture;
}

// Every stored row of the owner, so an atomicity check sees ids, revisions, jobs and picture columns at once.
async function stored(owner = fixture.owner.id) {
  const query = async (sql: string) => (await fixture.admin.query(sql, [owner])).rows;
  return {
    products: await query("select * from moti.products where owner_id = $1 order by id"),
    collections: await query("select * from moti.collections where owner_id = $1 order by id"),
    memberships: await query("select * from moti.product_collections where owner_id = $1 order by product_id, collection_id"),
    jobs: await query("select * from moti.metadata_jobs where owner_id = $1 order by id"),
  };
}

describe("보관함 복원", () => {
  it("빈 보관함에 복원하면 파일과 같은 보관함이 되고 상품마다 새 수집이 기다린다", async () => {
    const result = await restore(file);

    expect(asFile(await library().exportLibrary())).toEqual(file);
    expect(result.replacedPictures).toEqual([]);
    expect(result.library).toEqual(await library().snapshot());
    expect(result.library.collections.map(({ name, revision, createdAt }) => ({ name, revision, createdAt }))).toEqual([
      { name: "거실", revision: 1, createdAt: "2026-10-02T03:00:00.123Z" },
      { name: "Desk", revision: 1, createdAt: "2026-10-03T03:00:00.000Z" },
    ]);
    const [lamp, table, chair] = result.library.products;
    expect(lamp).toMatchObject({
      title: "무드등", revision: 1, addedAt: "2026-10-06T01:00:00.000Z", picture: null,
      metadata: { phase: "queued", generation: 1, attempts: 0 },
      lastSuccessfulPrice: { amountMinor: 129000, currency: "KRW", checkedAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(table).toMatchObject({ title: "내 테이블", note: "  선물용\n사이즈 확인  ", shop: "shop.example", identityUrl: "https://www.shop.example/table" });
    expect(table.collectionIds.toSorted()).toEqual(result.library.collections.map(({ id }) => id).toSorted());
    expect(chair.purchase).toEqual({ status: "purchased", date: "2026-11-01", price: null });
    expect((await stored()).jobs.map(({ product_id, generation, status }) => ({ product_id, generation, status })).toSorted((a, b) => a.product_id.localeCompare(b.product_id)))
      .toEqual([lamp, table, chair].map(({ id }) => ({ product_id: id, generation: 1, status: "queued" })).toSorted((a, b) => a.product_id.localeCompare(b.product_id)));
  });

  it("같은 보관함에 복원하면 링크가 같은 상품은 id·사진·수집 값을 지키고 소유자 값만 파일로 돌리며 revision을 올린다", async () => {
    const living = await library().createCollection({ name: "거실" });
    const desk = await library().createCollection({ name: "Desk" });
    const headphones = await saved("https://shop.example/headphones", [living.id]);
    const kept = await saved("https://shop.example/kept");
    const picture = await withPicture(headphones, "무선 헤드폰");
    await library().changeProduct({ productId: headphones.id, revision: 1, change: { type: "details", title: "내 헤드폰", note: "처음 메모", collectionIds: [living.id, desk.id] } });
    const backup = await library().exportLibrary();
    const before = await library().snapshot();

    await library().changeProduct({ productId: headphones.id, revision: 2, change: { type: "details", title: "바꾼 이름", note: "바꾼 메모", collectionIds: [] } });
    await library().changeProduct({ productId: kept.id, revision: 1, change: { type: "purchase" } });
    await library().renameCollection({ collectionId: desk.id, revision: 1, name: "Work" });
    const temporary = await library().createCollection({ name: "임시" });
    const added = await saved("https://shop.example/added", [temporary.id]);
    const addedPicture = await withPicture(added, "나중에 담은 상품");
    const changed = await library().snapshot();

    const result = await restore(asFile(backup));

    expect(await library().exportLibrary()).toEqual(backup);
    expect(result.replacedPictures).toEqual([addedPicture]);
    const restored = result.library;
    expect(restored.products.map(({ id }) => id)).toEqual([kept.id, headphones.id]);
    const shown = (id: string) => restored.products.find((product) => product.id === id)!;
    const was = (id: string) => changed.products.find((product) => product.id === id)!;
    expect(shown(headphones.id)).toMatchObject({
      title: "내 헤드폰", note: "처음 메모", revision: was(headphones.id).revision + 1,
      picture: before.products.find(({ id }) => id === headphones.id)!.picture,
      metadata: { phase: "ready", generation: 1 },
      lastSuccessfulPrice: was(headphones.id).lastSuccessfulPrice,
    });
    expect(shown(kept.id)).toMatchObject({ purchase: { status: "wish" }, revision: was(kept.id).revision + 1 });
    expect(Date.parse(shown(kept.id).updatedAt)).toBeGreaterThan(Date.parse(was(kept.id).updatedAt));
    expect(restored.collections.map(({ id, name, revision }) => ({ id, name, revision }))).toEqual([
      { id: living.id, name: "거실", revision: 2 },
      { id: expect.not.stringMatching(desk.id), name: "Desk", revision: 1 },
    ]);
    const { rows } = await fixture.admin.query("select title, owner_title from moti.products where id = $1", [headphones.id]);
    expect(rows).toEqual([{ title: "무선 헤드폰", owner_title: "내 헤드폰" }]);
    expect(picture).toMatch(new RegExp(`^${fixture.owner.id}/${headphones.id}/`));
  });

  it("파일에 없는 상품의 사진 사본은 소유자만 지울 수 있고 남은 상품의 사본은 지울 수 없다", async () => {
    const shown = await saved("https://shop.example/shown");
    const removed = await saved("https://shop.example/removed");
    const shownPicture = await withPicture(shown, "남는 상품");
    const removedPicture = await withPicture(removed, "지울 상품");
    const backup = await library().exportLibrary();

    const result = await restore({ ...asFile(backup), products: asFile(backup).products.filter(({ sourceUrl }) => sourceUrl.endsWith("/shown")) });

    expect(result.replacedPictures).toEqual([removedPicture]);
    const bucket = (client: SupabaseClient) => client.storage.from(PICTURE_BUCKET);
    for (const client of [fixture.stranger.client, fixture.anonymous]) {
      expect((await bucket(client).remove([removedPicture])).data ?? []).toEqual([]);
    }
    expect((await bucket(fixture.owner.client).remove([shownPicture])).data ?? []).toEqual([]);
    expect((await bucket(fixture.owner.client).remove([removedPicture])).data?.map(({ name }) => name)).toEqual([removedPicture]);
    const { rows } = await fixture.admin.query<{ name: string }>(
      "select name from storage.objects where bucket_id = $1 and starts_with(name, $2) order by name", [PICTURE_BUCKET, fixture.owner.id],
    );
    expect(rows.map(({ name }) => name)).toEqual([shownPicture]);
  });

  const productAt = (index: number) => file.products[index];
  it.each<[string, (input: LibraryRestoreInput) => LibraryRestoreInput]>([
    ["마지막 상품의 빈 이름", (input) => ({ ...input, products: [...input.products.slice(0, -1), { ...productAt(2), collectedTitle: " " }] })],
    ["마지막 상품의 없는 컬렉션 소속", (input) => ({ ...input, products: [...input.products.slice(0, -1), { ...productAt(2), collections: ["부엌"] }] })],
    ["같은 링크 두 번", (input) => ({ ...input, products: [...input.products, { ...productAt(0), sourceUrl: "https://shop.example/lamp" }] })],
    ["대소문자만 다른 컬렉션 이름", (input) => ({ ...input, collections: [...input.collections, { name: "desk", createdAt: "2026-10-03T03:00:00.000Z" }] })],
    ["앞으로 올 담은 시각", (input) => ({ ...input, products: [...input.products.slice(0, -1), { ...productAt(2), addedAt: new Date(Date.now() + 86_400_000).toISOString() }] })],
    ["마지막 상품의 0원 마지막 확인 가격", (input) => ({
      ...input, products: [...input.products.slice(0, -1), { ...productAt(2), lastSuccessfulPrice: { amountMinor: 0, currency: "KRW", checkedAt: "2026-11-01T00:00:00.000Z" } }],
    })],
    ["마지막 상품의 원화가 아닌 실구매가", (input) => ({
      ...input, products: [...input.products.slice(0, -1), { ...productAt(2), purchase: { status: "purchased", date: null, price: { amountMinor: 1, currency: "USD" } } }],
    })],
  ])("%s이 있으면 M0002이고 지금 보관함의 행을 하나도 바꾸지 않는다", async (_, broken) => {
    await restore(file);
    const extra = await saved();
    await withPicture(extra, "사진 있는 상품");
    const before = await stored();

    await expect(restore(broken(file))).rejects.toMatchObject({ code: "invalid_input" });

    expect(await stored()).toEqual(before);
  });

  it("명령을 거치지 않은 입력도 DB가 전체를 먼저 검사해 거절한다", async () => {
    await restore(file);
    const before = await stored();
    const valid = {
      source_url: "https://shop.example/raw", identity_url: "https://shop.example/raw", option: "", shop: "shop.example",
      title: "이름", owner_title: null, note: "", collection_names: [], created_at: "2026-10-01T00:00:00.000Z",
      purchase_status: "wish", purchased_on: null, purchased_amount_minor: null, purchased_currency: null,
      last_success_amount_minor: null, last_success_currency: null, last_success_at: null,
    };
    const tomorrow = new Date(Date.now() + 9 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
    for (const override of [
      { purchase_status: "purchased", purchased_on: tomorrow },
      { purchase_status: "wish", purchased_amount_minor: 1, purchased_currency: "KRW" },
      { last_success_amount_minor: 1, last_success_currency: "KRW" },
      { option: "M " },
      { identity_url: "javascript:alert(1)" },
      { collection_names: ["없는 컬렉션"] },
      { collection_names: "거실" },
      { created_at: "not a time" },
      { purchased_amount_minor: 1.5 },
    ]) {
      const { error } = await fixture.owner.client.rpc("moti_restore_library", {
        p_collections: [{ name: "거실", created_at: "2026-10-02T03:00:00.123Z" }],
        p_products: [valid, { ...valid, source_url: "https://shop.example/raw2", identity_url: "https://shop.example/raw2", ...override }],
      });
      expect(error?.code, JSON.stringify(override)).toBe("M0002");
    }
    for (const parameters of [
      { p_collections: null, p_products: [] },
      { p_collections: [], p_products: { products: [] } },
      { p_collections: [{ name: " 거실", created_at: "2026-10-02T03:00:00.123Z" }], p_products: [] },
      { p_collections: [{ name: "거실", created_at: "2026-10-02T03:00:00.123Z" }, { name: "거실", created_at: "2026-10-02T03:00:00.123Z" }], p_products: [] },
    ]) {
      expect((await fixture.owner.client.rpc("moti_restore_library", parameters)).error?.code, JSON.stringify(parameters)).toBe("M0002");
    }
    expect(await stored()).toEqual(before);
  });

  it("다른 연결이 상품을 잠그고 있으면 기다렸다가 복원한다", async () => {
    const product = await saved();
    const connection = await fixture.admin.connect();
    try {
      await connection.query("begin");
      await connection.query("select 1 from moti.products where id = $1 for update", [product.id]);
      let settled = false;
      const restoring = restore(file).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      await connection.query("commit");
      expect((await restoring).library.products.map(({ title }) => title)).toEqual(["무드등", "내 테이블", "새로 담은 상품"]);
    } finally {
      await connection.query("rollback").catch(() => undefined);
      connection.release();
    }
  });

  it("잠금을 5초 넘게 기다리면 저장소를 쓸 수 없다고 끝내고 아무것도 바꾸지 않는다", async () => {
    const product = await saved();
    const before = await stored();
    const connection = await fixture.admin.connect();
    try {
      await connection.query("begin");
      await connection.query("select 1 from moti.products where id = $1 for update", [product.id]);
      const { error } = await fixture.owner.client.rpc("moti_restore_library", { p_collections: [], p_products: [] });
      expect(error?.code).toBe("55P03");
      await expect(restore(file)).rejects.toMatchObject({ code: "storage_unavailable" });
    } finally {
      await connection.query("rollback");
      connection.release();
    }
    expect(await stored()).toEqual(before);
  }, 20_000);

  it("복원 중에 지워진 상품의 수집 결과는 늦은 결과가 되고 남은 상품의 수집은 그대로 끝난다", async () => {
    const backup = asFile({ collections: [], products: [] });
    const gone = await saved("https://shop.example/gone");
    const goneJob = await claimed(gone);
    await restore({ ...file, collections: [], products: [{ ...file.products[0], sourceUrl: "https://shop.example/stays" }] });
    const stays = (await library().snapshot()).products[0];
    const staysJob = await claimed(stays);

    await restore({ ...backup, products: [{ ...file.products[0], sourceUrl: "https://shop.example/stays", note: "복원한 메모" }] });

    expect(await jobs().complete(goneJob, { title: "늦은 결과", price: null, imageSourceUrl: null }, { outcome: "absent" })).toEqual({ kind: "stale" });
    expect(await jobs().complete(staysJob, { title: "수집한 이름", price: null, imageSourceUrl: null }, { outcome: "absent" }))
      .toMatchObject({ kind: "applied", product: { id: stays.id, title: "수집한 이름", note: "복원한 메모", revision: 2 } });
  });

  it("다른 소유자의 보관함은 바뀌지 않고 다른 계정과 익명은 복원할 수 없다", async () => {
    await fixture.admin.query(
      "insert into moti.products (owner_id, source_url, identity_url, shop) values ($1, 'https://shop.example/lamp', 'https://shop.example/lamp', 'shop.example')",
      [fixture.stranger.id],
    );
    const stranger = await stored(fixture.stranger.id);

    await restore(file);
    await restore({ collections: [], products: [] });

    expect(await stored(fixture.stranger.id)).toEqual(stranger);
    expect((await fixture.stranger.client.rpc("moti_restore_library", { p_collections: [], p_products: [] })).error?.code).toBe("M0001");
    expect((await fixture.anonymous.rpc("moti_restore_library", { p_collections: [], p_products: [] })).error?.code).toBe("42501");
    await expect(restore(file, fixture.stranger.client)).rejects.toMatchObject({ code: "unauthorized" });
    expect(await stored(fixture.stranger.id)).toEqual(stranger);
  });

  it("메모와 컬렉션이 있는 상품 1,000개를 한 번에 복원한다", async () => {
    const collections = Array.from({ length: 20 }, (_, index) => ({ name: `컬렉션 ${index}`, createdAt: "2026-10-01T00:00:00.000Z" }));
    const products = Array.from({ length: 1000 }, (_, index) => ({
      ...file.products[1],
      sourceUrl: `https://shop.example/items/${index}?ref=${"x".repeat(200)}`,
      note: `메모 ${index} `.repeat(100).slice(0, 1000),
      collections: [collections[index % 20].name, collections[(index + 1) % 20].name, collections[(index + 2) % 20].name],
      addedAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 1000).toISOString(),
    }));
    await restore(file);

    const started = performance.now();
    const result = await restore({ collections, products });
    const elapsed = performance.now() - started;

    expect(result.library.products).toHaveLength(1000);
    expect(result.library.products.every(({ collectionIds }) => collectionIds.length === 3)).toBe(true);
    console.info(`restore of 1,000 products with memo and 3 collections each: ${Math.round(elapsed)} ms`);
  }, 30_000);
});
