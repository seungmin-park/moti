import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import type { CollectedPage, CollectionJob } from "../../src/features/metadata/application/collection";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const library = () => createSupabaseLibraryStore(fixture.owner.client);
const jobs = () => createSupabaseCollectionStore(fixture.owner.client);
const page: CollectedPage = { title: "무선 헤드폰", price: null, imageSourceUrl: "https://cdn.shop.example/headphones.jpg" };
// A 1×1 lossless WebP.
const webp = Buffer.from("524946461a000000574542505650384c0d0000002f0000001007101111888808", "hex");

async function rpc<T = unknown>(name: string, parameters: Record<string, unknown>, client: SupabaseClient = fixture.owner.client) {
  const { data, error } = await client.rpc(name, parameters);
  return { data: data as T, code: error?.code ?? null };
}

async function saved(url = `https://shop.example/${randomUUID()}`, collectionIds: string[] = []): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({ url, option: "", collectionIds }))).product;
}

const remove = (product: { id: string }, revision: number, client?: SupabaseClient) =>
  rpc<{ id: string }>("moti_delete_product", { p_product_id: product.id, p_revision: revision }, client);

async function rows(product: { id: string }) {
  const [products, memberships, metadataJobs] = await Promise.all(["products where id", "product_collections where product_id", "metadata_jobs where product_id"]
    .map((from) => fixture.admin.query<{ count: string }>(`select count(*) from moti.${from} = $1`, [product.id])));
  return { products: Number(products.rows[0].count), memberships: Number(memberships.rows[0].count), jobs: Number(metadataJobs.rows[0].count) };
}

async function claimed(product: Product, generation = 1): Promise<CollectionJob> {
  const claim = await jobs().claim({ productId: product.id, generation });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  return claim.job;
}

async function uploaded(job: CollectionJob): Promise<string> {
  const { error } = await fixture.owner.client.storage.from(PICTURE_BUCKET).upload(job.picture, webp, { contentType: "image/webp", upsert: false });
  if (error) throw new Error(`사진을 올리지 못했습니다: ${error.message}`);
  return job.picture;
}

describe("상품 삭제", () => {
  it("화면이 본 revision으로 지우면 상품·소속·수집 작업이 사라지고 컬렉션은 남으며 id를 돌려준다", async () => {
    const desk = await library().createCollection({ name: "책상" });
    const product = await saved(undefined, [desk.id]);
    const kept = await saved();
    expect(await rows(product)).toEqual({ products: 1, memberships: 1, jobs: 1 });

    expect(await remove(product, 1)).toEqual({ data: { id: product.id }, code: null });

    expect(await rows(product)).toEqual({ products: 0, memberships: 0, jobs: 0 });
    const snapshot = await library().snapshot();
    expect(snapshot.products.map(({ id }) => id)).toEqual([kept.id]);
    expect(snapshot.collections).toEqual([desk]);
  });

  it("소속과 수집 작업은 상품 외래키의 on delete cascade로 함께 지운다", async () => {
    const { rows: constraints } = await fixture.admin.query<{ table: string; action: string }>(
      `select c.conrelid::regclass::text as table, c.confdeltype as action from pg_constraint c
       where c.contype = 'f' and c.confrelid = 'moti.products'::regclass order by 1`,
    );
    expect(constraints).toEqual([{ table: "moti.metadata_jobs", action: "c" }, { table: "moti.product_collections", action: "c" }]);
  });

  it("다른 곳에서 먼저 바뀐 상품을 오래된 revision으로 지우면 M0008이고 지우지 않으며, 최신 revision이면 지운다", async () => {
    const product = await saved();
    await rpc("moti_edit_product", { p_product_id: product.id, p_revision: 1, p_title: null, p_note: "다른 탭", p_collection_ids: [] });

    expect(await remove(product, 1)).toEqual({ data: null, code: "M0008" });
    expect((await rows(product)).products).toBe(1);
    expect((await remove(product, 3)).code).toBe("M0008");
    expect(await remove(product, 2)).toEqual({ data: { id: product.id }, code: null });
  });

  it("없는 상품, 이미 지운 상품, 다른 소유자의 상품은 M0006이고 다른 소유자의 상품은 그대로다", async () => {
    const product = await saved();
    await remove(product, 1);
    const foreign = await fixture.admin.query<{ id: string }>(
      `insert into moti.products (owner_id, source_url, identity_url, shop)
       values ($1, 'https://shop.example/other', 'https://shop.example/other', 'shop.example') returning id`,
      [fixture.stranger.id],
    );

    for (const id of [randomUUID(), product.id, foreign.rows[0].id]) {
      expect(await remove({ id }, 1)).toEqual({ data: null, code: "M0006" });
    }
    expect((await rows(foreign.rows[0])).products).toBe(1);
  });

  it.each([0, -1, null])("revision %s는 M0002이고 지우지 않는다", async (revision) => {
    const product = await saved();
    expect((await remove(product, revision as number)).code).toBe("M0002");
    expect((await rows(product)).products).toBe(1);
  });

  it("같은 revision으로 동시에 8번 지우면 하나만 성공하고 나머지는 M0006이다", async () => {
    const product = await saved();
    const results = await Promise.all(Array.from({ length: 8 }, () => remove(product, 1)));
    expect(results.filter((result) => result.code === null)).toHaveLength(1);
    expect(results.filter((result) => result.code === "M0006")).toHaveLength(7);
  });

  it("지운 뒤 같은 링크를 다시 담으면 새 id의 새 상품이 된다", async () => {
    const url = `https://shop.example/${randomUUID()}?utm_source=share`;
    const first = await saved(url);
    await remove(first, 1);

    const again = await library().saveLink(toLinkSaveCommand({ url, option: "", collectionIds: [] }));

    expect(again.kind).toBe("added");
    expect(again.product.id).not.toBe(first.id);
    expect(again.product).toMatchObject({ identityUrl: first.identityUrl, revision: 1, metadata: { phase: "queued", generation: 1 } });
    expect(await rows(again.product)).toEqual({ products: 1, memberships: 0, jobs: 1 });
  });
});

describe("상품 삭제와 진행 중인 수집", () => {
  it("수집 중에 지우면 늦게 온 완료·실패는 오류 없이 stale이고 상품을 되살리지 않는다", async () => {
    const completing = await saved();
    const failing = await saved();
    const completeJob = await claimed(completing);
    const failJob = await claimed(failing);

    expect((await remove(completing, 1)).code).toBeNull();
    expect((await remove(failing, 1)).code).toBeNull();

    expect(await jobs().complete(completeJob, { ...page, imageSourceUrl: null }, { outcome: "absent" })).toEqual({ kind: "stale" });
    expect(await jobs().fail(failJob, "timeout")).toEqual({ kind: "stale" });
    expect(await rows(completing)).toEqual({ products: 0, memberships: 0, jobs: 0 });
    expect(await rows(failing)).toEqual({ products: 0, memberships: 0, jobs: 0 });
  });

  it("삭제와 수집 완료가 동시에 와도 교착 없이 삭제가 성공하고 상품은 남지 않는다", async () => {
    const products = await Promise.all(Array.from({ length: 6 }, () => saved()));
    const claims = await Promise.all(products.map((product) => claimed(product)));

    const results = await Promise.all(products.map((product, index) => Promise.all([
      remove(product, 1),
      jobs().complete(claims[index], { ...page, imageSourceUrl: null }, { outcome: "absent" }).then(
        (settled) => ({ settled, code: null }),
        (error: Error) => ({ settled: null, code: error.message }),
      ),
    ])));

    for (const [deleted, settled] of results) {
      expect(deleted.code).toBeNull();
      expect(settled.code).toBeNull();
      expect(["applied", "stale"]).toContain(settled.settled?.kind);
    }
    for (const product of products) expect(await rows(product)).toEqual({ products: 0, memberships: 0, jobs: 0 });
  });

  it("다시 가져오기는 지운 상품에 M0006이다", async () => {
    const product = await saved();
    await remove(product, 1);
    await expect(jobs().retry({ productId: product.id, expectedGeneration: 1 })).rejects.toMatchObject({ code: "product_missing" });
    expect(await rows(product)).toEqual({ products: 0, memberships: 0, jobs: 0 });
  });
});

describe("상품 삭제와 예약 실행", () => {
  type Run = { secret: string; run: string; lease: string };
  type Claimed = { kind: "collection"; job: string; job_lease: string };
  type Picked = { kind: "price"; product: string; checked_at: string };

  async function start(): Promise<Run> {
    const issued = await rpc<{ secret: string }>("moti_worker_key_issue", { p_replaces: null });
    const begun = await rpc<{ run: string; lease: string }>("moti_worker_begin", { p_key: issued.data.secret }, fixture.anonymous);
    if (begun.code) throw new Error(`moti_worker_begin 실패: ${begun.code}`);
    return { secret: issued.data.secret, ...begun.data };
  }
  const step = ({ secret, run, lease }: Run) => ({ p_key: secret, p_run: run, p_lease: lease });
  const next = (run: Run) => rpc<Claimed | Picked | { kind: "none" }>("moti_worker_next", step(run), fixture.anonymous);

  // A product whose collection finished two days ago, so the worker picks it for a price check.
  async function collected(): Promise<Product> {
    const product = await saved();
    await fixture.admin.query(
      `with job as (
         update moti.metadata_jobs set status = 'succeeded', attempts = 1, finished_at = now() - interval '2 days' where product_id = $1
         returning product_id
       )
       update moti.products set metadata_phase = 'ready', metadata_attempts = 1, metadata_completed_at = now() - interval '2 days',
         metadata_image = 'absent', last_success_amount_minor = 9000, last_success_currency = 'KRW',
         last_success_at = now() - interval '2 days'
       where id in (select product_id from job)`,
      [product.id],
    );
    return product;
  }

  it("지운 상품의 대기 작업과 가격 확인은 고르지 않는다", async () => {
    const queued = await saved();
    const checked = await collected();
    await remove(queued, 1);
    await remove(checked, 1);

    expect(await next(await start())).toEqual({ data: { kind: "none" }, code: null });
  });

  it("예약 실행이 맡은 수집을 지우면 늦게 온 완료·실패는 stale이고 실행 셈을 올리지 않으며 상품을 되살리지 않는다", async () => {
    const completing = await saved();
    const failing = await saved();
    const run = await start();
    const first = await next(run);
    const second = await next(run);
    const claims = [first.data, second.data] as Claimed[];
    expect(claims.map(({ kind }) => kind)).toEqual(["collection", "collection"]);

    await remove(completing, 1);
    await remove(failing, 1);
    const job = (claim: Claimed) => ({ ...step(run), p_job: claim.job, p_job_lease: claim.job_lease });
    expect(await rpc("moti_worker_complete", {
      ...job(claims[0]), p_title: "수집한 이름", p_amount_minor: 12000, p_currency: "KRW", p_image_source_url: null,
    }, fixture.anonymous)).toEqual({ data: { kind: "stale" }, code: null });
    expect(await rpc("moti_worker_fail", { ...job(claims[1]), p_error_code: "timeout" }, fixture.anonymous))
      .toEqual({ data: { kind: "stale" }, code: null });

    for (const product of [completing, failing]) expect(await rows(product)).toEqual({ products: 0, memberships: 0, jobs: 0 });
    const { rows: counts } = await fixture.admin.query("select collected, collect_failed from moti.worker_runs where id = $1", [run.run]);
    expect(counts).toEqual([{ collected: 0, collect_failed: 0 }]);
  });

  it("예약 실행이 고른 가격 확인을 지우면 늦게 온 결과는 stale이고 상품을 되살리지 않는다", async () => {
    const product = await collected();
    const run = await start();
    const picked = (await next(run)).data as Picked;
    expect(picked).toMatchObject({ kind: "price", product: product.id });

    await remove(product, 1);

    expect(await rpc("moti_worker_price", {
      ...step(run), p_product: picked.product, p_checked_at: picked.checked_at, p_amount_minor: 8000, p_currency: "KRW", p_code: null,
    }, fixture.anonymous)).toEqual({ data: { kind: "stale" }, code: null });
    expect(await rows(product)).toEqual({ products: 0, memberships: 0, jobs: 0 });
  });
});

describe("상품 삭제와 사진 사본", () => {
  const orphans = async () => (await rpc<string[]>("moti_picture_orphans", { p_limit: 200 })).data;
  const aged = async (name: string, minutes: number) => {
    const { rowCount } = await fixture.admin.query(
      "update storage.objects set created_at = now() - make_interval(mins => $3) where bucket_id = $1 and name = $2",
      [PICTURE_BUCKET, name, minutes],
    );
    expect(rowCount).toBe(1);
  };

  it("지운 상품이 보여주던 사본은 10분이 지나면 남은 사본으로 돌려주고 소유자가 Storage에서 지울 수 있다", async () => {
    const product = await saved();
    const job = await claimed(product);
    const name = await uploaded(job);
    expect(await jobs().complete(job, page, { outcome: "copied" })).toMatchObject({ kind: "applied" });
    await aged(name, 60);
    expect(await orphans()).toEqual([]);

    await remove(product, 1);
    expect(await orphans()).toEqual([name]);

    const discarded = await fixture.owner.client.storage.from(PICTURE_BUCKET).remove([name]);
    expect(discarded.error).toBeNull();
    expect(discarded.data?.map((item) => item.name)).toEqual([name]);
  });

  it("수집 중에 올린 사본도 상품을 지우면 10분 여유가 지난 뒤에만 남은 사본이 된다", async () => {
    const product = await saved();
    const name = await uploaded(await claimed(product));
    await aged(name, 9);

    await remove(product, 1);
    expect(await orphans()).toEqual([]);

    await aged(name, 11);
    expect(await orphans()).toEqual([name]);
  });
});

describe("상품 삭제의 소유자 경계", () => {
  it.each(["anonymous", "stranger"] as const)("%s는 삭제 RPC를 실행하지 못하고 상품이 남는다", async (who) => {
    const product = await saved();
    const client = who === "anonymous" ? fixture.anonymous : fixture.stranger.client;
    expect((await remove(product, 1, client)).code).toBe(who === "anonymous" ? "42501" : "M0001");
    expect(await rows(product)).toEqual({ products: 1, memberships: 0, jobs: 1 });
  });

  it("삭제 RPC는 RPC 역할이 소유한 security definer이고 로그인 세션만 실행한다", async () => {
    const { rows: functions } = await fixture.admin.query(
      `select r.rolname as owner, p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
       where n.nspname = 'public' and p.proname = 'moti_delete_product'`,
    );
    expect(functions).toEqual([
      { owner: "moti_rpc", prosecdef: true, proconfig: ["search_path=\"\""], anon: false, authenticated: true, service_role: false },
    ]);
  });
});
