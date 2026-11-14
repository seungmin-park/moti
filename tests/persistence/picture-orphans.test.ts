import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { createPictureOrphanStore, PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import type { CollectedPage, CollectionJob } from "../../src/features/metadata/application/collection";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { readDatabaseConfig } from "../support/database-config";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const jobs = () => createSupabaseCollectionStore(fixture.owner.client);
const page: CollectedPage = { title: "무선 헤드폰", price: null, imageSourceUrl: "https://cdn.shop.example/headphones.jpg" };
// A 1×1 lossless WebP.
const webp = Buffer.from("524946461a000000574542505650384c0d0000002f0000001007101111888808", "hex");
const pictures = (client: SupabaseClient) => client.storage.from(PICTURE_BUCKET);

async function saved(): Promise<Product> {
  return (await createSupabaseLibraryStore(fixture.owner.client)
    .saveLink(toLinkSaveCommand({ url: `https://shop.example/${randomUUID()}`, option: "", collectionIds: [] }))).product;
}

async function claimed(product: Product, generation = 1): Promise<CollectionJob> {
  const claim = await jobs().claim({ productId: product.id, generation });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  return claim.job;
}

async function uploaded(job: CollectionJob): Promise<string> {
  const { error } = await pictures(fixture.owner.client).upload(job.picture, webp, { contentType: "image/webp", upsert: false });
  if (error) throw new Error(`사진을 올리지 못했습니다: ${error.message}`);
  return job.picture;
}

const expireLease = (job: CollectionJob) =>
  fixture.admin.query("update moti.metadata_jobs set lease_until = now() - interval '1 second' where id = $1", [job.id]);

// The copy a product shows.
async function shown(product?: Product): Promise<string> {
  const job = await claimed(product ?? await saved());
  const name = await uploaded(job);
  expect(await jobs().complete(job, page, { outcome: "copied" })).toMatchObject({ kind: "applied" });
  return name;
}

// A run that uploaded and then died: its lease expires and nobody claimed the job again, so a late complete may still
// record the copy.
async function stillRunning(): Promise<string> {
  const job = await claimed(await saved());
  const name = await uploaded(job);
  await expireLease(job);
  return name;
}

// The same run once the next attempt claims the job: no product shows the copy and no complete can record it.
async function leftBehind(): Promise<string> {
  const product = await saved();
  const first = await claimed(product);
  const name = await uploaded(first);
  await expireLease(first);
  expect((await claimed(product)).attempts).toBe(2);
  return name;
}

// A product's first copy once a later collection copied a new one, and the discard of the old one never ran.
async function replaced(): Promise<{ old: string; current: string }> {
  const product = await saved();
  const old = await shown(product);
  await fixture.admin.query(
    `update moti.products set metadata_phase = 'failed', metadata_error_code = 'timeout', metadata_completed_at = null,
     metadata_image = null, metadata_image_error_code = null where id = $1`,
    [product.id],
  );
  const retried = await jobs().retry({ productId: product.id, expectedGeneration: 1 });
  const next = await claimed(product, retried.product.metadata.generation);
  const current = await uploaded(next);
  expect(await jobs().complete(next, page, { outcome: "copied" })).toMatchObject({ kind: "applied", replacedPicture: old });
  return { old, current };
}

// The copy of a product a restore removed: the row and its jobs are gone, the object is not.
async function removed(): Promise<string> {
  const product = await saved();
  const name = await shown(product);
  await fixture.admin.query("delete from moti.products where id = $1", [product.id]);
  return name;
}

// A run that uploaded and stalled, then the owner's retry put the job back in the queue: it is not running, and the
// next claim makes a new attempt, so nothing can record the copy.
async function resumed(): Promise<string> {
  const product = await saved();
  const job = await claimed(product);
  const name = await uploaded(job);
  await expireLease(job);
  expect(await jobs().retry({ productId: product.id, expectedGeneration: 1 })).toMatchObject({ kind: "resumed" });
  return name;
}

// A run whose product moved to a new generation before it finished: its complete closes the job as superseded.
async function superseded(): Promise<string> {
  const product = await saved();
  const job = await claimed(product);
  const name = await uploaded(job);
  await fixture.admin.query("update moti.products set metadata_generation = 2, metadata_phase = 'queued' where id = $1", [product.id]);
  expect(await jobs().complete(job, page, { outcome: "copied" })).toEqual({ kind: "stale" });
  return name;
}

function service(): SupabaseClient {
  const { apiUrl, serviceRoleKey } = readDatabaseConfig();
  return createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function aged(name: string, minutes: number): Promise<string> {
  const { rowCount } = await fixture.admin.query(
    "update storage.objects set created_at = now() - make_interval(mins => $3) where bucket_id = $1 and name = $2",
    [PICTURE_BUCKET, name, minutes],
  );
  expect(rowCount).toBe(1);
  return name;
}

async function orphans(limit: unknown = 200, client: SupabaseClient = fixture.owner.client) {
  const { data, error } = await client.rpc("moti_picture_orphans", { p_limit: limit });
  return { data: data as string[] | null, code: error?.code ?? null };
}

async function stored(): Promise<string[]> {
  const { rows } = await fixture.admin.query<{ name: string }>(
    "select name from storage.objects where bucket_id = $1 and starts_with(name, $2) order by name",
    [PICTURE_BUCKET, `${fixture.owner.id}/`],
  );
  return rows.map((row) => row.name);
}

describe("남은 사진 사본 찾기", () => {
  it("상품이 보여주지 않는 사본은 10분이 지나야 돌려준다", async () => {
    const older = await aged(await leftBehind(), 11);
    await aged(await leftBehind(), 9);

    expect(await orphans()).toEqual({ data: [older], code: null });
  });

  it("상품이 보여주는 사본은 오래돼도 돌려주지 않는다", async () => {
    await aged(await shown(), 60);
    const older = await aged(await leftBehind(), 11);

    expect(await orphans()).toEqual({ data: [older], code: null });
  });

  it("끝나지 않은 작업의 이번 시도 사본은 임대가 지나도 돌려주지 않고 다음 시도가 맡은 뒤에만 돌려준다", async () => {
    const product = await saved();
    const first = await claimed(product);
    const name = await aged(await uploaded(first), 11);
    await expireLease(first);

    expect(await orphans()).toEqual({ data: [], code: null });
    await claimed(product);
    expect(await orphans()).toEqual({ data: [name], code: null });
  });

  it("다른 계정 접두사의 객체는 돌려주지 않는다", async () => {
    const foreign = `${fixture.stranger.id}/${randomUUID()}/${randomUUID()}-1.webp`;
    expect((await pictures(service()).upload(foreign, webp, { contentType: "image/webp" })).error).toBeNull();
    await aged(foreign, 60);
    const older = await aged(await leftBehind(), 11);

    expect(await orphans()).toEqual({ data: [older], code: null });
  });

  it("한도는 남은 사본에만 세어 오래된 보이는 사본이 많아도 남은 사본을 찾는다", async () => {
    await aged(await shown(), 120);
    await aged(await shown(), 90);
    const names = [await aged(await leftBehind(), 30), await aged(await leftBehind(), 11)].toSorted();

    expect(await orphans(1)).toEqual({ data: [names[0]], code: null });
    expect(await orphans(2)).toEqual({ data: names, code: null });
  });

  // The answer repeats may_discard's conditions instead of calling it, so this pins the two together: of the owner's old
  // copies, Storage lets the owner discard exactly the ones the answer holds.
  it("여러 상태의 오래된 사본 가운데 돌려준 것만 Storage가 소유자에게 지우게 한다", async () => {
    const swapped = await replaced();
    const kept = [await shown(), await stillRunning(), swapped.current];
    const returned = [await leftBehind(), swapped.old, await removed(), await resumed(), await superseded()];
    for (const name of [...kept, ...returned]) await aged(name, 11);
    const before = await stored();

    const { data } = await orphans();
    await pictures(fixture.owner.client).remove(before);
    const after = await stored();

    expect(data).toEqual(returned.toSorted());
    expect(before.filter((name) => !after.includes(name))).toEqual(data);
    expect(after).toEqual(kept.toSorted());
  });

  it("moti가 만들지 않은 이름은 오래돼도 돌려주지 않는다", async () => {
    // The dashboard marks a folder it creates with an empty placeholder, the only size Storage accepts for that name.
    const strange: [string, Buffer][] = [
      [`${fixture.owner.id}/.emptyFolderPlaceholder`, Buffer.alloc(0)],
      [`${fixture.owner.id}/${randomUUID()}/${randomUUID()}-1.png`, webp],
    ];
    for (const [name, body] of strange) {
      expect((await pictures(service()).upload(name, body, { contentType: "image/webp" })).error).toBeNull();
      await aged(name, 60);
    }
    const older = await aged(await leftBehind(), 11);

    expect(await orphans()).toEqual({ data: [older], code: null });
    expect(await createPictureOrphanStore(fixture.owner.client).find(200)).toEqual([older]);
  });

  it.each([0, 201, null])("한도가 %s이면 M0002다", async (limit) => {
    await aged(await leftBehind(), 11);
    expect(await orphans(limit)).toEqual({ data: null, code: "M0002" });
  });

  it("소유자가 아닌 세션은 M0001, 익명은 42501이다", async () => {
    await aged(await leftBehind(), 11);
    expect((await orphans(200, fixture.stranger.client)).code).toBe("M0001");
    expect((await orphans(200, fixture.anonymous)).code).toBe("42501");
  });

  it("남은 사본 저장소 어댑터는 이름만 돌려주고 소유자가 아닌 세션이면 예외를 던진다", async () => {
    const older = await aged(await leftBehind(), 11);

    expect(await createPictureOrphanStore(fixture.owner.client).find(200)).toEqual([older]);
    await expect(createPictureOrphanStore(fixture.stranger.client).find(200)).rejects.toThrow("M0001");
  });

  it("Storage를 읽는 함수는 마이그레이션 소유자로 실행하고 RPC 역할만 부르며 공개 REST에 드러나지 않는다", async () => {
    const { rows } = await fixture.admin.query<{
      proname: string; owner: string; prosecdef: boolean; rpc: boolean; anon: boolean; authenticated: boolean; worker: boolean;
    }>(
      `select p.proname, r.rolname as owner, p.prosecdef,
       has_function_privilege('moti_rpc', p.oid, 'execute') as rpc,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('moti_worker', p.oid, 'execute') as worker
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
       where n.nspname = 'moti' and p.proname in ('stored_picture_version', 'stored_pictures', 'picture_orphans')
       order by p.proname`,
    );
    const migrationOwner = rows.find((row) => row.proname === "stored_picture_version")!.owner;
    expect(rows.filter((row) => row.proname !== "stored_picture_version")).toEqual([
      { proname: "picture_orphans", owner: migrationOwner, prosecdef: false, rpc: true, anon: false, authenticated: false, worker: false },
      { proname: "stored_pictures", owner: migrationOwner, prosecdef: true, rpc: true, anon: false, authenticated: false, worker: false },
    ]);
    for (const client of [fixture.owner.client, fixture.anonymous]) {
      const direct = await client.schema("moti").rpc("stored_pictures", { p_owner: fixture.owner.id, p_before: new Date().toISOString() });
      expect(direct.error?.code).toBe("PGRST106");
    }
  });
});
