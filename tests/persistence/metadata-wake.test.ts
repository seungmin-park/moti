import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

type Woken = { id: string; metadata_phase: string; metadata_generation: number; metadata_stalled: boolean };

async function rpc(name: string, parameters: Record<string, unknown> = {}, client: SupabaseClient = fixture.owner.client) {
  const { data, error } = await client.rpc(name, parameters);
  return { data: data as Woken[] | null, code: error?.code ?? null };
}

// A product the way a key's add or a restore leaves it: queued with no attempt, nobody collecting. `minutesAgo` sets
// when it was added and when its job last entered the queue.
async function waiting(name: string, minutesAgo: number): Promise<string> {
  const { rows } = await fixture.admin.query<{ id: string }>(
    `with product as (
       insert into moti.products (owner_id, source_url, identity_url, shop, created_at)
       values ($1, $2, $2, 'shop.example', now() - make_interval(mins => $3)) returning id, owner_id
     )
     insert into moti.metadata_jobs (owner_id, product_id, generation, updated_at)
     select owner_id, id, 1, now() - make_interval(mins => $3) from product returning product_id as id`,
    [fixture.owner.id, `https://shop.example/${name}`, minutesAgo],
  );
  return rows[0].id;
}

async function job(productId: string) {
  const { rows } = await fixture.admin.query<{ status: string; attempts: number; fresh: boolean }>(
    `select status, attempts, updated_at > now() - interval '5 seconds' as fresh
     from moti.metadata_jobs where product_id = $1 order by generation desc limit 1`,
    [productId],
  );
  return rows[0];
}

describe("기다리는 수집 깨우기", () => {
  it("지금 세대에서 아직 한 번도 시작하지 않은 대기 작업만 최신 상품부터 한도까지 깨우고 멈춤 표시를 지운다", async () => {
    const oldest = await waiting("oldest", 30);
    const middle = await waiting("middle", 20);
    const newest = await waiting("newest", 10);
    const started = await waiting("started", 5);
    // A job a retry put back in the queue: it already ran once, so the retry's own runner owns it, not a wake.
    const resumed = await waiting("resumed", 4);
    await fixture.admin.query("update moti.metadata_jobs set attempts = 1 where product_id = $1", [resumed]);
    await createSupabaseCollectionStore(fixture.owner.client).claim({ productId: started as never, generation: 1 });
    // A job left from an earlier generation: the product already moved on, so this job is not its collection.
    const earlier = await waiting("earlier", 1);
    await fixture.admin.query("update moti.products set metadata_generation = 2 where id = $1", [earlier]);
    const other = await fixture.admin.query<{ id: string }>(
      `with product as (
         insert into moti.products (owner_id, source_url, identity_url, shop)
         values ($1, 'https://other.example/x', 'https://other.example/x', 'other.example') returning id, owner_id
       )
       insert into moti.metadata_jobs (owner_id, product_id, generation, updated_at)
       select owner_id, id, 1, now() - interval '10 minutes' from product returning product_id as id`,
      [fixture.stranger.id],
    );

    const first = await rpc("moti_metadata_wake", { p_limit: 2 });

    expect(first.code).toBeNull();
    expect(first.data?.map((product) => product.id)).toEqual([newest, middle]);
    expect(first.data?.every((product) => product.metadata_phase === "queued" && !product.metadata_stalled)).toBe(true);
    expect(await job(newest)).toEqual({ status: "queued", attempts: 0, fresh: true });
    expect(await job(oldest)).toEqual({ status: "queued", attempts: 0, fresh: false });

    const rest = await rpc("moti_metadata_wake", { p_limit: 8 });

    expect(rest.data?.map((product) => product.id)).toEqual([newest, middle, oldest]);
    expect(await job(started)).toMatchObject({ status: "running", attempts: 1 });
    expect(await job(resumed)).toEqual({ status: "queued", attempts: 1, fresh: false });
    expect(await job(earlier)).toEqual({ status: "queued", attempts: 0, fresh: false });
    expect(await job(other.rows[0].id)).toEqual({ status: "queued", attempts: 0, fresh: false });
  });

  it("깨울 작업이 없으면 빈 목록이다", async () => {
    expect(await rpc("moti_metadata_wake", { p_limit: 8 })).toEqual({ data: [], code: null });
  });

  it("다른 연결이 잠근 작업은 기다리지 않고 건너뛴다", async () => {
    const locked = await waiting("locked", 10);
    const free = await waiting("free", 20);
    const holder = await fixture.admin.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from moti.metadata_jobs where product_id = $1 for update", [locked]);
      const started = Date.now();
      const result = await rpc("moti_metadata_wake", { p_limit: 8 });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(result.data?.map((product) => product.id)).toEqual([free]);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });

  it.each([0, 9, null])("한도가 %s이면 M0002이고 아무것도 바꾸지 않는다", async (limit) => {
    const product = await waiting("limit", 10);
    expect((await rpc("moti_metadata_wake", { p_limit: limit })).code).toBe("M0002");
    expect(await job(product)).toMatchObject({ fresh: false });
  });

  it("소유자가 아닌 세션은 M0001, 익명은 42501이다", async () => {
    const product = await waiting("owner-only", 10);
    expect((await rpc("moti_metadata_wake", { p_limit: 8 }, fixture.stranger.client)).code).toBe("M0001");
    expect((await rpc("moti_metadata_wake", { p_limit: 8 }, fixture.anonymous)).code).toBe("42501");
    expect(await job(product)).toMatchObject({ fresh: false });
  });

  it("수집 저장소 어댑터는 깨운 상품을 도메인 값으로 돌려준다", async () => {
    const product = await waiting("adapter", 10);
    const result = await createSupabaseCollectionStore(fixture.owner.client).wake({ limit: 8 });
    expect(result.products.map(({ id, metadata }) => ({ id, metadata })))
      .toEqual([{ id: product, metadata: { phase: "queued", generation: 1, attempts: 0, stalled: false } }]);
  });
});
