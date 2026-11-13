import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import type { WorkerSecret } from "../../src/features/worker/domain/worker";
import { createSupabaseWorkerKeyStore, createSupabaseWorkerRunStore } from "../../src/features/worker/infrastructure/supabase-worker-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

type Issued = { key: { id: string }; secret: string };
type Run = { secret: string; run: string; lease: string };
type Picked = { kind: "price"; product: string; checked_at: string; source_url: string };
type Claimed = { kind: "collection"; job: string; job_lease: string; source_url: string };
type Item = Picked | Claimed | { kind: "none" };

async function rpc<T = unknown>(name: string, parameters: Record<string, unknown> = {}, client: SupabaseClient = fixture.anonymous) {
  const { data, error } = await client.rpc(name, parameters);
  return { data: data as T, code: error?.code ?? null };
}

async function start(): Promise<Run & { keyId: string }> {
  const issued = await rpc<Issued>("moti_worker_key_issue", { p_replaces: null }, fixture.owner.client);
  const begun = await rpc<{ run: string; lease: string }>("moti_worker_begin", { p_key: issued.data.secret });
  if (begun.code) throw new Error(`moti_worker_begin 실패: ${begun.code}`);
  return { secret: issued.data.secret, keyId: issued.data.key.id, ...begun.data };
}

const step = ({ secret, run, lease }: Run) => ({ p_key: secret, p_run: run, p_lease: lease });
const next = (run: Run) => rpc<Item>("moti_worker_next", step(run));

async function pick(run: Run): Promise<Picked> {
  const { data, code } = await next(run);
  if (code || data.kind !== "price") throw new Error(`확인할 가격이 없습니다: ${code ?? data.kind}`);
  return data;
}

type Found = { amount?: number | null; currency?: string | null; code?: string | null };
const settle = (run: Run, item: Pick<Picked, "product" | "checked_at">, found: Found) => rpc("moti_worker_price", {
  ...step(run),
  p_product: item.product,
  p_checked_at: item.checked_at,
  p_amount_minor: found.amount ?? null,
  p_currency: found.currency ?? null,
  p_code: found.code ?? null,
});

const library = () => createSupabaseLibraryStore(fixture.owner.client);
const seoulMidnight = "(date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')";

async function save(path: string, minutesAgo = 0) {
  const { product } = await library().saveLink(toLinkSaveCommand({ url: `https://shop.example/${path}`, option: "", collectionIds: [] }));
  await fixture.admin.query("update moti.products set created_at = now() - $2::interval where id = $1", [product.id, `${minutesAgo} minutes`]);
  return product.id;
}

// A product whose collection finished two days ago, with or without a stored price from then.
async function collected(path: string, price: { amount: number; currency: string } | null = { amount: 9000, currency: "KRW" }, minutesAgo = 0) {
  const id = await save(path, minutesAgo);
  await fixture.admin.query(
    `with job as (
       update moti.metadata_jobs set status = 'succeeded', attempts = 1, finished_at = now() - interval '2 days' where product_id = $1
       returning product_id
     )
     update moti.products set metadata_phase = 'ready', metadata_attempts = 1, metadata_completed_at = now() - interval '2 days',
       metadata_image = 'absent', last_success_amount_minor = $2, last_success_currency = $3,
       last_success_at = case when $2::bigint is null then null else now() - interval '2 days' end
     where id in (select product_id from job)`,
    [id, price?.amount ?? null, price?.currency ?? null],
  );
  return id;
}

const setProduct = (id: string, assignments: string) => fixture.admin.query(`update moti.products set ${assignments} where id = $1`, [id]);

async function productRow(id: string) {
  const { rows } = await fixture.admin.query<{
    title: string; owner_title: string | null; shown_title: string; revision: number; updated_at: Date;
    metadata_phase: string; metadata_generation: number; metadata_image: string | null; picture_job_id: string | null;
    last_success_amount_minor: string | null; last_success_currency: string | null; last_success_at: Date | null;
    price_checked_at: Date | null; price_check_code: string | null; checked_today: boolean | null; priced_now: boolean | null;
  }>(
    `select title, owner_title, moti.product_json(p) ->> 'title' as shown_title, revision, updated_at, metadata_phase,
       metadata_generation, metadata_image, picture_job_id, last_success_amount_minor, last_success_currency, last_success_at,
       price_checked_at, price_check_code,
       (price_checked_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date as checked_today,
       last_success_at > now() - interval '1 minute' as priced_now
     from moti.products p where id = $1`,
    [id],
  );
  return rows[0];
}

async function runRow(id: string) {
  const { rows } = await fixture.admin.query<{
    collected: number; collect_failed: number; prices_confirmed: number; prices_kept: number; failures: Record<string, number>;
  }>("select collected, collect_failed, prices_confirmed, prices_kept, failures from moti.worker_runs where id = $1", [id]);
  return rows[0];
}

const untouchedRun = { collected: 0, collect_failed: 0, prices_confirmed: 0, prices_kept: 0, failures: {} };

describe("작업자의 가격 확인 집기", () => {
  it("남은 수집을 먼저 집고, 그다음 수집이 끝난 위시 상품의 가격 확인을 집어 상품 id·확인 시각·링크만 돌려준다", async () => {
    const run = await start();
    const priced = await collected("priced", { amount: 9000, currency: "KRW" }, 10);
    await save("queued", 5);

    const first = await next(run);
    expect(first).toMatchObject({ code: null, data: { kind: "collection", source_url: "https://shop.example/queued" } });

    const item = await pick(run);
    expect(Object.keys(item).toSorted()).toEqual(["checked_at", "kind", "product", "source_url"]);
    expect(item).toMatchObject({ product: priced, source_url: "https://shop.example/priced" });
    const row = await productRow(priced);
    expect(row).toMatchObject({ checked_today: true, price_check_code: null, last_success_amount_minor: "9000" });
    expect(row.price_checked_at?.getTime()).toBe(Date.parse(item.checked_at));
    expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
  });

  it("서울 날짜로 오늘 확인했거나 오늘 가격을 얻은 상품, 구매완료, 수집이 끝나지 않은 상품은 집지 않는다. 어제 늦게 확인한 상품은 집는다", async () => {
    const run = await start();
    const checkedToday = await collected("checked-today");
    await setProduct(checkedToday, `price_checked_at = ${seoulMidnight} + interval '1 second'`);
    const pricedToday = await collected("priced-today");
    await setProduct(pricedToday, `last_success_at = ${seoulMidnight} + interval '1 second'`);
    const purchased = await collected("purchased");
    await rpc("moti_purchase_product", { p_product_id: purchased, p_revision: 1 }, fixture.owner.client);
    const failed = await save("failed");
    await fixture.admin.query(
      `with job as (update moti.metadata_jobs set status = 'failed', attempts = 3, error_code = 'timeout', finished_at = now() - interval '2 days'
         where product_id = $1 returning product_id)
       update moti.products set metadata_phase = 'failed', metadata_attempts = 3, metadata_error_code = 'timeout' where id in (select product_id from job)`,
      [failed],
    );
    const stalled = await save("stalled");
    await fixture.admin.query("update moti.metadata_jobs set attempts = 3 where product_id = $1", [stalled]);
    const checkedYesterday = await collected("checked-yesterday");
    await setProduct(checkedYesterday, `price_checked_at = ${seoulMidnight} - interval '1 second'`);
    const pricedYesterday = await collected("priced-yesterday");
    await setProduct(pricedYesterday, `last_success_at = ${seoulMidnight} - interval '1 second'`);

    const picked = [(await pick(run)).product, (await pick(run)).product];

    expect(picked).toEqual([pricedYesterday, checkedYesterday]);
    expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
    expect(await productRow(purchased)).toMatchObject({ price_checked_at: null });
  });

  it("확인한 적 없는 상품부터, 그다음 가장 오래전에 확인한 상품부터 집는다", async () => {
    const run = await start();
    const older = await collected("checked-3-days-ago", undefined, 30);
    await setProduct(older, "price_checked_at = now() - interval '3 days'");
    const newer = await collected("checked-2-days-ago", undefined, 20);
    await setProduct(newer, "price_checked_at = now() - interval '2 days'");
    const never = await collected("never-checked", null, 10);

    const order = [(await pick(run)).product, (await pick(run)).product, (await pick(run)).product];

    expect(order).toEqual([never, older, newer]);
  });

  it("다른 요청이 잠근 상품은 건너뛴다", async () => {
    const run = await start();
    const locked = await collected("locked", undefined, 5);
    const free = await collected("free", undefined, 10);
    const connection = await fixture.admin.connect();
    try {
      await connection.query("begin");
      await connection.query("select id from moti.products where id = $1 for update", [locked]);
      expect((await pick(run)).product).toBe(free);
      expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
    } finally {
      await connection.query("rollback");
      connection.release();
    }
    expect(await productRow(locked)).toMatchObject({ price_checked_at: null });
  });
});

describe("작업자의 가격 확인 결과", () => {
  it("같은 통화의 가격은 마지막 확인 가격과 시각을 바꾸고 셈한다. 이름·소유자 이름·revision·수집 단계·사진은 그대로다", async () => {
    const run = await start();
    const product = await collected("lamp");
    await rpc("moti_edit_product", { p_product_id: product, p_revision: 1, p_title: "내 램프", p_note: "", p_collection_ids: [] }, fixture.owner.client);
    const copy = randomUUID();
    await setProduct(product, `title = '수집한 이름', metadata_image = 'copied', picture_job_id = '${copy}', picture_attempt = 1,
      picture_copied_at = now() - interval '2 days', picture_object_version = 'v1'`);
    const before = await productRow(product);
    const item = await pick(run);

    expect(await settle(run, item, { amount: 8500, currency: "KRW" })).toEqual({ code: null, data: { kind: "applied" } });

    const after = await productRow(product);
    expect(after).toMatchObject({
      title: "수집한 이름", owner_title: "내 램프", shown_title: "내 램프", revision: 2, updated_at: before.updated_at,
      metadata_phase: "ready", metadata_generation: 1, metadata_image: "copied", picture_job_id: copy,
      last_success_amount_minor: "8500", last_success_currency: "KRW", priced_now: true, price_check_code: null, checked_today: true,
    });
    expect(await runRow(run.run)).toEqual({ ...untouchedRun, prices_confirmed: 1 });
    const { rows } = await fixture.admin.query("select count(*)::int as objects from storage.objects where split_part(name, '/', 1) = $1", [fixture.owner.id]);
    expect(rows).toEqual([{ objects: 0 }]);
  });

  it("저장한 가격이 없으면 확인한 가격을 처음으로 저장한다", async () => {
    const run = await start();
    const product = await collected("unpriced", null);
    await settle(run, await pick(run), { amount: 1999, currency: "USD" });
    expect(await productRow(product)).toMatchObject({ last_success_amount_minor: "1999", last_success_currency: "USD", priced_now: true });
    expect(await runRow(run.run)).toEqual({ ...untouchedRun, prices_confirmed: 1 });
  });

  it("다른 통화의 가격은 이전 가격과 시각을 지키고 other_currency로 남기며 유지와 이유로 센다", async () => {
    const run = await start();
    const product = await collected("lamp");
    const before = await productRow(product);

    expect(await settle(run, await pick(run), { amount: 1999, currency: "USD" })).toEqual({ code: null, data: { kind: "applied" } });

    expect(await productRow(product)).toMatchObject({
      last_success_amount_minor: "9000", last_success_currency: "KRW", last_success_at: before.last_success_at,
      price_check_code: "other_currency", checked_today: true,
    });
    expect(await runRow(run.run)).toEqual({ ...untouchedRun, prices_kept: 1, failures: { other_currency: 1 } });
  });

  it("확인하지 못한 이유는 상품에 남기고 이전 가격과 시각을 지키며 이유별로 센다", async () => {
    const run = await start();
    const lamp = await collected("lamp", undefined, 30);
    const desk = await collected("desk", undefined, 20);
    const chair = await collected("chair", null, 10);
    const before = await productRow(lamp);
    const picks = new Map<string, Picked>();
    for (let index = 0; index < 3; index += 1) {
      const item = await pick(run);
      picks.set(item.product, item);
    }

    await settle(run, picks.get(lamp)!, { code: "timeout" });
    await settle(run, picks.get(desk)!, { code: "no_single_price" });
    await settle(run, picks.get(chair)!, { code: "timeout" });

    expect(await productRow(lamp)).toMatchObject({
      last_success_amount_minor: "9000", last_success_currency: "KRW", last_success_at: before.last_success_at, price_check_code: "timeout",
    });
    expect(await productRow(desk)).toMatchObject({ last_success_amount_minor: "9000", price_check_code: "no_single_price" });
    expect(await productRow(chair)).toMatchObject({ last_success_amount_minor: null, price_check_code: "timeout" });
    expect(await runRow(run.run)).toEqual({ ...untouchedRun, prices_kept: 3, failures: { timeout: 2, no_single_price: 1 } });
  });

  it("집은 뒤 구매완료로 옮긴 상품의 정산은 stale이고 아무것도 쓰지 않는다", async () => {
    const run = await start();
    const product = await collected("bought");
    const item = await pick(run);
    await rpc("moti_purchase_product", { p_product_id: product, p_revision: 1 }, fixture.owner.client);
    const before = await productRow(product);

    expect(await settle(run, item, { amount: 7000, currency: "KRW" })).toEqual({ code: null, data: { kind: "stale" } });
    expect(await settle(run, item, { code: "timeout" })).toEqual({ code: null, data: { kind: "stale" } });

    expect(await productRow(product)).toEqual(before);
    expect(before).toMatchObject({ last_success_amount_minor: "9000", price_check_code: null });
    expect(await runRow(run.run)).toEqual(untouchedRun);
  });

  it("한 확인은 한 번만 정산한다. 다른 확인 시각이나 다른 상품의 정산은 stale이다", async () => {
    const run = await start();
    const product = await collected("lamp");
    const item = await pick(run);

    expect(await settle(run, { ...item, checked_at: new Date(Date.parse(item.checked_at) - 1000).toISOString() }, { code: "timeout" }))
      .toEqual({ code: null, data: { kind: "stale" } });
    expect(await settle(run, { ...item, product: randomUUID() }, { code: "timeout" })).toEqual({ code: null, data: { kind: "stale" } });
    expect(await settle(run, item, { amount: 8000, currency: "KRW" })).toEqual({ code: null, data: { kind: "applied" } });
    expect(await settle(run, item, { amount: 7000, currency: "KRW" })).toEqual({ code: null, data: { kind: "stale" } });

    expect(await productRow(product)).toMatchObject({ last_success_amount_minor: "8000" });
    expect(await runRow(run.run)).toEqual({ ...untouchedRun, prices_confirmed: 1 });
  });

  it.each([
    ["가격과 이유를 함께 보낸", { amount: 8000, currency: "KRW", code: "timeout" }],
    ["가격도 이유도 없는", {}],
    ["통화 없는 가격의", { amount: 8000 }],
    ["가격 없는 통화의", { currency: "KRW" }],
    ["0원의", { amount: 0, currency: "KRW" }],
    ["소문자 통화의", { amount: 8000, currency: "krw" }],
    ["작업자가 정하지 않는 other_currency의", { code: "other_currency" }],
    ["수집에만 있는 attempts_exhausted의", { code: "attempts_exhausted" }],
    ["목록에 없는 이유의", { code: "bogus" }],
  ])("%s 정산은 M0002이고 아무것도 쓰지 않는다", async (_name, found) => {
    const run = await start();
    const product = await collected("lamp");
    const item = await pick(run);
    const before = await productRow(product);
    expect((await settle(run, item, found as Found)).code).toBe("M0002");
    expect(await productRow(product)).toEqual(before);
    expect(await runRow(run.run)).toEqual(untouchedRun);
  });

  it("실행 중에 키를 폐기하면 정산은 M0012이고, 닫힌 실행의 정산은 M0013이다", async () => {
    const run = await start();
    const product = await collected("lamp");
    const item = await pick(run);
    await rpc("moti_worker_key_revoke", { p_key_id: run.keyId }, fixture.owner.client);
    expect((await settle(run, item, { amount: 8000, currency: "KRW" })).code).toBe("M0012");
    expect(await productRow(product)).toMatchObject({ last_success_amount_minor: "9000" });

    const second = await start();
    await setProduct(product, "price_checked_at = null");
    const again = await pick(second);
    await rpc("moti_worker_finish", { ...step(second), p_stop: "deadline" });
    expect((await settle(second, again, { amount: 8000, currency: "KRW" })).code).toBe("M0013");
    expect(await productRow(product)).toMatchObject({ last_success_amount_minor: "9000" });
  });
});

describe("작업자의 수집이 오늘의 가격 확인을 대신한다", () => {
  async function collect(run: Run, page: { amount: number | null; currency: string | null }) {
    const { data } = await next(run);
    if (data.kind !== "collection") throw new Error(`수집할 작업이 없습니다: ${data.kind}`);
    return rpc("moti_worker_complete", {
      ...step(run), p_job: data.job, p_job_lease: data.job_lease, p_title: "수집한 이름",
      p_amount_minor: page.amount, p_currency: page.currency, p_image_source_url: null,
    });
  }

  it("수집이 같은 통화의 가격을 쓰면 오늘 확인한 것으로 남기고, 같은 날 그 상품의 가격 확인을 다시 집지 않는다", async () => {
    const run = await start();
    const product = await save("lamp");
    await collect(run, { amount: 12000, currency: "KRW" });
    expect(await productRow(product)).toMatchObject({ checked_today: true, price_check_code: null, last_success_amount_minor: "12000" });
    expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
  });

  it("수집한 가격이 다른 통화면 other_currency, 하나의 가격이 없으면 no_single_price로 오늘 확인한 것으로 남긴다", async () => {
    const run = await start();
    const foreign = await save("foreign", 10);
    await setProduct(foreign, "last_success_amount_minor = 9000, last_success_currency = 'KRW', last_success_at = now() - interval '2 days'");
    const unpriced = await save("unpriced", 5);
    await collect(run, { amount: null, currency: null });
    await collect(run, { amount: 1999, currency: "USD" });

    expect(await productRow(unpriced)).toMatchObject({ checked_today: true, price_check_code: "no_single_price", last_success_amount_minor: null });
    expect(await productRow(foreign)).toMatchObject({ checked_today: true, price_check_code: "other_currency", last_success_amount_minor: "9000" });
    expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
    expect(await runRow(run.run)).toEqual({ ...untouchedRun, collected: 2 });
  });

  it("수집 중에 구매완료로 옮긴 상품은 가격 확인 열도 그대로다", async () => {
    const run = await start();
    const product = await save("bought");
    const { data } = await next(run);
    if (data.kind !== "collection") throw new Error("수집할 작업이 없습니다");
    await rpc("moti_purchase_product", { p_product_id: product, p_revision: 1 }, fixture.owner.client);
    await rpc("moti_worker_complete", {
      ...step(run), p_job: data.job, p_job_lease: data.job_lease, p_title: "산 물건",
      p_amount_minor: 12000, p_currency: "KRW", p_image_source_url: null,
    });
    expect(await productRow(product)).toMatchObject({ title: "산 물건", price_checked_at: null, price_check_code: null });
  });
});

describe("가격 확인 어댑터", () => {
  const store = () => createSupabaseWorkerRunStore(fixture.anonymous);

  it("집은 확인을 도메인 값으로 돌려주고 확인 시각을 받은 그대로 보내 정산한다. 끝내기와 소유자의 기록은 가격 셈과 이유를 돌려준다", async () => {
    const { data: issued } = await rpc<Issued>("moti_worker_key_issue", { p_replaces: null }, fixture.owner.client);
    const lamp = await collected("lamp", undefined, 20);
    const desk = await collected("desk", undefined, 10);
    const lease = await store().begin(issued.secret as WorkerSecret);

    const first = await store().next(lease);
    expect(first).toEqual({ kind: "price", check: { productId: lamp, fence: expect.any(String), sourceUrl: "https://shop.example/lamp" } });
    if (first.kind !== "price") throw new Error("집은 가격 확인이 없습니다");
    expect(Date.parse(first.check.fence)).toBe((await productRow(lamp)).price_checked_at?.getTime());
    expect(await store().price(lease, first.check, { kind: "price", price: { amountMinor: 8000, currency: "KRW" } })).toBe("applied");
    expect(await store().price(lease, first.check, { kind: "kept", code: "timeout" })).toBe("stale");
    const second = await store().next(lease);
    if (second.kind !== "price") throw new Error("집은 가격 확인이 없습니다");
    expect(await store().price(lease, second.check, { kind: "kept", code: "no_single_price" })).toBe("applied");
    expect(await store().next(lease)).toEqual({ kind: "none" });

    const counts = { collections: { collected: 0, failed: 0 }, prices: { confirmed: 1, kept: 1 }, failures: { no_single_price: 1 } };
    expect(await store().finish(lease, "done")).toEqual({ stop: "done", ...counts });
    expect(await productRow(lamp)).toMatchObject({ last_success_amount_minor: "8000", price_check_code: null });
    expect(await productRow(desk)).toMatchObject({ last_success_amount_minor: "9000", price_check_code: "no_single_price" });
    const { runs } = await createSupabaseWorkerKeyStore(fixture.owner.client).read();
    expect(runs).toEqual([expect.objectContaining({ state: "done", ...counts })]);
  });
});

describe("보관함 읽기의 가격 확인", () => {
  it("확인한 적 없는 상품은 null, 확인한 상품은 그 확인의 시각과 이전 가격을 지킨 이유(확인했으면 null)를 돌려준다", async () => {
    const run = await start();
    const kept = await collected("kept", undefined, 20);
    const confirmed = await collected("confirmed", undefined, 10);
    const never = await collected("never", null, 0);
    const picks = new Map<string, Picked>();
    for (let index = 0; index < 2; index += 1) {
      const item = await pick(run);
      picks.set(item.product, item);
    }
    await settle(run, picks.get(kept)!, { code: "timeout" });
    await settle(run, picks.get(confirmed)!, { amount: 8000, currency: "KRW" });

    const { products } = await library().snapshot();
    const checkOf = (id: string) => products.find((product) => product.id === id)!.priceCheck;

    expect(checkOf(kept)).toEqual({ checkedAt: (await productRow(kept)).price_checked_at!.toISOString(), code: "timeout" });
    expect(checkOf(confirmed)).toEqual({ checkedAt: (await productRow(confirmed)).price_checked_at!.toISOString(), code: null });
    expect(checkOf(never)).toBeNull();
  });
});
