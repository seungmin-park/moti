import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

type Issued = { key: { id: string }; secret: string };
type Run = { secret: string; run: string; lease: string };
type Claimed = { kind: "collection"; job: string; job_lease: string; source_url: string };

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
const next = (run: Run) => rpc<Claimed | { kind: "none" }>("moti_worker_next", step(run));

async function claim(run: Run): Promise<Claimed> {
  const { data, code } = await next(run);
  if (code || data.kind !== "collection") throw new Error(`수집할 작업이 없습니다: ${code ?? data.kind}`);
  return data;
}

type Page = { title?: string; amount?: number | null; currency?: string | null; image?: string | null };
const complete = (run: Run, item: Pick<Claimed, "job" | "job_lease">, page: Page = {}) => rpc("moti_worker_complete", {
  ...step(run),
  p_job: item.job,
  p_job_lease: item.job_lease,
  p_title: page.title ?? "수집한 이름",
  p_amount_minor: page.amount === undefined ? 12000 : page.amount,
  p_currency: page.currency === undefined ? "KRW" : page.currency,
  p_image_source_url: page.image === undefined ? "https://img.example/lamp.jpg" : page.image,
});
const fail = (run: Run, item: Pick<Claimed, "job" | "job_lease">, code: string) =>
  rpc("moti_worker_fail", { ...step(run), p_job: item.job, p_job_lease: item.job_lease, p_error_code: code });

const library = () => createSupabaseLibraryStore(fixture.owner.client);

async function save(path: string, minutesAgo = 0) {
  const { product } = await library().saveLink(toLinkSaveCommand({ url: `https://shop.example/${path}`, option: "", collectionIds: [] }));
  await fixture.admin.query("update moti.products set created_at = now() - $2::interval where id = $1", [product.id, `${minutesAgo} minutes`]);
  return product.id;
}

async function productRow(id: string) {
  const { rows } = await fixture.admin.query<{
    title: string; owner_title: string | null; revision: number; metadata_phase: string; metadata_attempts: number;
    metadata_error_code: string | null; metadata_image: string | null; picture_job_id: string | null;
    last_success_amount_minor: string | null; last_success_currency: string | null; purchase_status: string; shown_title: string;
  }>(
    `select title, owner_title, revision, metadata_phase, metadata_attempts, metadata_error_code, metadata_image, picture_job_id,
       last_success_amount_minor, last_success_currency, purchase_status, moti.product_json(p) ->> 'title' as shown_title
     from moti.products p where id = $1`,
    [id],
  );
  return rows[0];
}

async function jobRow(id: string) {
  const { rows } = await fixture.admin.query<{
    status: string; attempts: number; error_code: string | null; image_source_url: string | null; lease_seconds: number | null;
  }>(
    `select status, attempts, error_code, image_source_url, round(extract(epoch from lease_until - started_at))::int as lease_seconds
     from moti.metadata_jobs where id = $1`,
    [id],
  );
  return rows[0];
}

async function runRow(id: string) {
  const { rows } = await fixture.admin.query<{ collected: number; collect_failed: number; failures: Record<string, number> }>(
    "select collected, collect_failed, failures from moti.worker_runs where id = $1",
    [id],
  );
  return rows[0];
}

const jobOf = async (productId: string) =>
  (await fixture.admin.query<{ id: string }>("select id from moti.metadata_jobs where product_id = $1 order by generation desc limit 1", [productId])).rows[0].id;

const setJob = (productId: string, assignments: string) =>
  fixture.admin.query(`update moti.metadata_jobs set ${assignments} where product_id = $1`, [productId]);

async function failedAgo(productId: string, code: string, ago: string) {
  await fixture.admin.query(
    `with job as (
       update moti.metadata_jobs set status = 'failed', attempts = 1, error_code = $2, finished_at = now() - $3::interval
       where product_id = $1 returning product_id
     )
     update moti.products set metadata_phase = 'failed', metadata_attempts = 1, metadata_error_code = $2 where id in (select product_id from job)`,
    [productId, code, ago],
  );
}

describe("작업자의 수집 집기", () => {
  it("할 일이 없으면 none이고, 대기 중인 위시 상품을 소유자의 실행기처럼 집어 링크만 돌려준다", async () => {
    const run = await start();
    expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
    const product = await save("lamp");

    const item = await claim(run);

    expect(Object.keys(item).toSorted()).toEqual(["job", "job_lease", "kind", "source_url"]);
    expect(item).toMatchObject({ job: await jobOf(product), source_url: "https://shop.example/lamp" });
    expect(await jobRow(item.job)).toEqual({ status: "running", attempts: 1, error_code: null, image_source_url: null, lease_seconds: 60 });
    expect(await productRow(product)).toMatchObject({ metadata_phase: "running", metadata_attempts: 1 });
    expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
  });

  it("구매완료 상품, 지금 세대가 아닌 작업, 세 번 시도한 작업, 임대가 남은 작업, 다시 해도 소용없거나 한 시간이 안 된 실패는 집지 않는다", async () => {
    const run = await start();
    const purchased = await save("purchased");
    await rpc("moti_purchase_product", { p_product_id: purchased, p_revision: 1 }, fixture.owner.client);
    const older = await save("older-generation");
    await fixture.admin.query("update moti.products set metadata_generation = 2 where id = $1", [older]);
    const exhausted = await save("exhausted");
    await setJob(exhausted, "attempts = 3");
    const held = await save("held");
    await setJob(held, "status = 'running', attempts = 1, lease_token = gen_random_uuid(), lease_until = now() + interval '30 seconds', started_at = now()");
    const blocked = await save("blocked");
    await failedAgo(blocked, "blocked_address", "2 hours");
    const recent = await save("recent");
    await failedAgo(recent, "timeout", "50 minutes");

    expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
  });

  it("대기 작업을 먼저 최신 상품부터 집고, 그다음 임대가 끝난 작업과 한 시간이 지난 재시도 가능한 실패를 최신 상품부터 집는다", async () => {
    const run = await start();
    const failed = await save("failed", 40);
    await failedAgo(failed, "blocked_by_site", "2 hours");
    const lapsed = await save("lapsed", 30);
    await setJob(lapsed, "status = 'running', attempts = 1, lease_token = gen_random_uuid(), lease_until = now() - interval '1 second', started_at = now() - interval '61 seconds'");
    await save("queued-old", 20);
    await save("queued-new", 10);

    const order: string[] = [];
    for (let index = 0; index < 4; index += 1) order.push((await claim(run)).source_url.split("/").at(-1)!);
    expect(order).toEqual(["queued-new", "queued-old", "lapsed", "failed"]);
    expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
    expect(await productRow(failed)).toMatchObject({ metadata_phase: "running", metadata_error_code: null, metadata_attempts: 2 });
    expect(await jobRow(await jobOf(failed))).toMatchObject({ status: "running", attempts: 2, error_code: null });
    expect(await jobRow(await jobOf(lapsed))).toMatchObject({ status: "running", attempts: 2 });
  });

  it("다른 요청이 잠근 작업은 건너뛴다", async () => {
    const run = await start();
    const locked = await save("locked", 5);
    const free = await save("free", 10);
    const connection = await fixture.admin.connect();
    try {
      await connection.query("begin");
      await connection.query("select id from moti.metadata_jobs where product_id = $1 for update", [locked]);
      expect((await claim(run)).source_url).toBe("https://shop.example/free");
      expect(await next(run)).toEqual({ code: null, data: { kind: "none" } });
    } finally {
      await connection.query("rollback");
      connection.release();
    }
    expect(await productRow(free)).toMatchObject({ metadata_phase: "running" });
  });
});

describe("작업자의 수집 결과", () => {
  it("이름은 title에만 쓰고 소유자가 고친 이름·revision·화면 이름은 그대로다. 사진 주소가 있으면 사진은 waiting이다", async () => {
    const run = await start();
    const product = await save("lamp");
    await rpc("moti_edit_product", { p_product_id: product, p_revision: 1, p_title: "내 램프", p_note: "", p_collection_ids: [] }, fixture.owner.client);
    const item = await claim(run);

    expect(await complete(run, item, { title: "북유럽 램프" })).toEqual({ code: null, data: { kind: "applied" } });

    expect(await productRow(product)).toMatchObject({
      title: "북유럽 램프", owner_title: "내 램프", revision: 2, shown_title: "내 램프", metadata_phase: "ready",
      metadata_image: "waiting", picture_job_id: null, last_success_amount_minor: "12000", last_success_currency: "KRW",
    });
    expect(await jobRow(item.job)).toMatchObject({ status: "succeeded", image_source_url: "https://img.example/lamp.jpg" });
    expect(await runRow(run.run)).toEqual({ collected: 1, collect_failed: 0, failures: {} });
    const { rows } = await fixture.admin.query("select count(*)::int as objects from storage.objects where split_part(name, '/', 1) = $1", [fixture.owner.id]);
    expect(rows).toEqual([{ objects: 0 }]);
  });

  it("사진 주소가 없으면 absent이고 이전 사본은 그대로 보인다", async () => {
    const run = await start();
    const product = await save("lamp");
    const earlier = randomUUID();
    await fixture.admin.query(
      `update moti.products set picture_job_id = $2, picture_attempt = 1, picture_copied_at = now(), picture_object_version = 'v1' where id = $1`,
      [product, earlier],
    );
    const item = await claim(run);
    await complete(run, item, { image: null });
    expect(await productRow(product)).toMatchObject({ metadata_image: "absent", picture_job_id: earlier });
  });

  it("다른 통화의 가격은 저장한 가격을 바꾸지 않고, 수집 중에 구매완료로 옮긴 상품은 이름만 쓴다", async () => {
    const run = await start();
    const priced = await save("priced", 10);
    await fixture.admin.query(
      "update moti.products set last_success_amount_minor = 9000, last_success_currency = 'KRW', last_success_at = now() - interval '1 day' where id = $1",
      [priced],
    );
    const bought = await save("bought", 5);
    const first = await claim(run);
    const second = await claim(run);
    expect([first.source_url, second.source_url]).toEqual(["https://shop.example/bought", "https://shop.example/priced"]);
    await rpc("moti_purchase_product", { p_product_id: bought, p_revision: 1 }, fixture.owner.client);

    await complete(run, second, { amount: 1999, currency: "USD" });
    await complete(run, first, { title: "산 물건" });

    expect(await productRow(priced)).toMatchObject({ last_success_amount_minor: "9000", last_success_currency: "KRW", title: "수집한 이름" });
    expect(await productRow(bought)).toMatchObject({
      title: "산 물건", purchase_status: "purchased", last_success_amount_minor: null, last_success_currency: null,
    });
  });

  it("실패는 작업과 상품을 실패로 두고 실행에 이유별로 센다. 시도 소진과 목록에 없는 이유는 M0002다", async () => {
    const run = await start();
    for (const path of ["a", "b", "c"]) await save(path);
    const first = await claim(run);
    expect((await fail(run, first, "attempts_exhausted")).code).toBe("M0002");
    expect((await fail(run, first, "superseded")).code).toBe("M0002");
    expect((await fail(run, first, "bogus")).code).toBe("M0002");
    expect(await fail(run, first, "timeout")).toEqual({ code: null, data: { kind: "applied" } });
    await fail(run, await claim(run), "timeout");
    await fail(run, await claim(run), "blocked_address");

    expect(await runRow(run.run)).toEqual({ collected: 0, collect_failed: 3, failures: { timeout: 2, blocked_address: 1 } });
    expect(await jobRow(first.job)).toMatchObject({ status: "failed", error_code: "timeout" });
    const { rows } = await fixture.admin.query("select metadata_phase, metadata_error_code from moti.products where id = (select product_id from moti.metadata_jobs where id = $1)", [first.job]);
    expect(rows).toEqual([{ metadata_phase: "failed", metadata_error_code: "timeout" }]);
  });

  it("세대가 바뀐 작업의 결과는 stale이고 작업을 superseded로 닫는다. 다른 작업 임대도 stale이며 아무것도 쓰지 않는다", async () => {
    const run = await start();
    const product = await save("lamp");
    const item = await claim(run);
    expect(await complete(run, { ...item, job_lease: randomUUID() })).toEqual({ code: null, data: { kind: "stale" } });
    expect(await fail(run, { ...item, job: randomUUID() }, "timeout")).toEqual({ code: null, data: { kind: "stale" } });
    await fixture.admin.query("update moti.products set metadata_generation = metadata_generation + 1, metadata_phase = 'queued' where id = $1", [product]);

    expect(await complete(run, item)).toEqual({ code: null, data: { kind: "stale" } });

    expect(await jobRow(item.job)).toMatchObject({ status: "failed", error_code: "superseded" });
    expect(await productRow(product)).toMatchObject({ title: "새로 담은 상품", last_success_amount_minor: null });
    expect(await runRow(run.run)).toEqual({ collected: 0, collect_failed: 0, failures: {} });
  });

  it.each([
    ["빈 이름", { title: "" }],
    ["제어 문자", { title: "램프\u0007" }],
    ["앞뒤 공백", { title: " 램프" }],
    ["통화 없는 가격", { currency: null }],
    ["0원", { amount: 0 }],
    ["소문자 통화", { currency: "krw" }],
    ["웹 주소가 아닌 사진", { image: "javascript:alert(1)" }],
  ])("%s 결과는 M0002이고 아무것도 쓰지 않는다", async (_name, page) => {
    const run = await start();
    const product = await save("lamp");
    const item = await claim(run);
    expect((await complete(run, item, page as Page)).code).toBe("M0002");
    expect(await productRow(product)).toMatchObject({ title: "새로 담은 상품", metadata_phase: "running" });
  });

  it("실행 중에 키를 폐기하면 집기와 쓰기가 M0012이고, 닫힌 실행의 단계는 M0013이다", async () => {
    const run = await start();
    const product = await save("lamp");
    const item = await claim(run);
    await save("other");
    await rpc("moti_worker_key_revoke", { p_key_id: run.keyId }, fixture.owner.client);
    expect((await complete(run, item)).code).toBe("M0012");
    expect((await next(run)).code).toBe("M0012");
    expect(await productRow(product)).toMatchObject({ metadata_phase: "running", title: "새로 담은 상품" });

    const second = await start();
    await rpc("moti_worker_finish", { ...step(second), p_stop: "done" });
    expect((await next(second)).code).toBe("M0013");
  });
});
