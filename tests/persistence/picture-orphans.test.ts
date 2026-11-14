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
async function shown(): Promise<string> {
  const job = await claimed(await saved());
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
    const { apiUrl, serviceRoleKey } = readDatabaseConfig();
    const service = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const foreign = `${fixture.stranger.id}/${randomUUID()}/${randomUUID()}-1.webp`;
    expect((await pictures(service).upload(foreign, webp, { contentType: "image/webp" })).error).toBeNull();
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

  it("돌려준 사본은 소유자가 지울 수 있고 돌려주지 않은 오래된 사본은 Storage도 지우지 못한다", async () => {
    const kept = [await aged(await shown(), 60), await aged(await stillRunning(), 60)];
    const older = await aged(await leftBehind(), 11);
    const before = await stored();

    const { data } = await orphans();
    await pictures(fixture.owner.client).remove(before);

    expect(data).toEqual([older]);
    expect(await stored()).toEqual(kept.toSorted());
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
