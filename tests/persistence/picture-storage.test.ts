import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import type { CollectedPage, CollectionJob } from "../../src/features/metadata/application/collection";
import type { ImageCopy } from "../../src/features/metadata/application/picture-copy";
import { imageErrorCodes } from "../../src/features/metadata/domain/collection-error";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const jobs = () => createSupabaseCollectionStore(fixture.owner.client);
const library = () => createSupabaseLibraryStore(fixture.owner.client);
const page: CollectedPage = { title: "무선 헤드폰", price: null, imageSourceUrl: "https://cdn.shop.example/headphones.jpg" };
const copied: ImageCopy = { outcome: "copied" };
// A 1×1 lossless WebP.
const webp = Buffer.from("524946461a000000574542505650384c0d0000002f0000001007101111888808", "hex");

const pictures = (client: SupabaseClient) => client.storage.from(PICTURE_BUCKET);
const upload = (client: SupabaseClient, name: string, body: Buffer = webp, contentType = "image/webp") =>
  pictures(client).upload(name, body, { contentType, upsert: false });

async function saved(url = `https://shop.example/${randomUUID()}`): Promise<Product> {
  return (await library().saveLink(toLinkSaveCommand({ url, option: "", collectionIds: [] }))).product;
}

async function claimed(product: Product, generation = 1): Promise<CollectionJob> {
  const claim = await jobs().claim({ productId: product.id, generation });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  return claim.job;
}

async function current(product: Product): Promise<Product> {
  return (await library().snapshot()).products.find((item) => item.id === product.id)!;
}

async function stored(prefix: string): Promise<string[]> {
  const { rows } = await fixture.admin.query<{ name: string }>(
    "select name from storage.objects where bucket_id = $1 and starts_with(name, $2) order by name",
    [PICTURE_BUCKET, prefix],
  );
  return rows.map((row) => row.name);
}

async function copiedPicture(product: Product, generation = 1): Promise<CollectionJob> {
  const job = await claimed(product, generation);
  expect((await upload(fixture.owner.client, job.picture)).error).toBeNull();
  expect(await jobs().complete(job, page, copied)).toMatchObject({ kind: "applied" });
  return job;
}

// Puts a ready product back in the retry path the way a later failure would, so a new generation can copy again.
async function nextGeneration(product: Product): Promise<number> {
  const { generation } = (await current(product)).metadata;
  await fixture.admin.query(
    `update moti.products set metadata_phase = 'failed', metadata_error_code = 'timeout', metadata_completed_at = null,
     metadata_image = null, metadata_image_error_code = null where id = $1`,
    [product.id],
  );
  return (await jobs().retry({ productId: product.id, expectedGeneration: generation })).product.metadata.generation;
}

const expireLease = (job: CollectionJob) =>
  fixture.admin.query("update moti.metadata_jobs set lease_until = now() - interval '1 second' where id = $1", [job.id]);

describe("상품 사진 사본 저장소", () => {
  it("사진 버킷은 비공개이고 1 MiB 이하의 WebP만 받는다", async () => {
    const { rows } = await fixture.admin.query(
      "select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1",
      [PICTURE_BUCKET],
    );
    expect(rows).toEqual([{ public: false, file_size_limit: "1048576", allowed_mime_types: ["image/webp"] }]);
  });

  it("작업을 맡으면 DB가 이 시도의 사진 이름을 정해 돌려준다", async () => {
    const product = await saved();
    const first = await claimed(product);
    expect(first.picture).toBe(`${fixture.owner.id}/${product.id}/${first.id}-1.webp`);
    await expireLease(first);
    expect((await claimed(product)).picture).toBe(`${fixture.owner.id}/${product.id}/${first.id}-2.webp`);
  });

  it("임대가 살아 있는 작업의 예약된 이름에만 소유자 토큰으로 WebP를 한 번 올린다", async () => {
    const product = await saved();
    const job = await claimed(product);
    const reserved = job.picture;
    const refused: [SupabaseClient, string, Buffer, string][] = [
      [fixture.stranger.client, reserved, webp, "image/webp"],
      [fixture.anonymous, reserved, webp, "image/webp"],
      [fixture.owner.client, reserved, webp, "image/png"],
      [fixture.owner.client, reserved, Buffer.alloc(1024 * 1024 + 1, 1), "image/webp"],
      [fixture.owner.client, `${fixture.owner.id}/${product.id}/${randomUUID()}-1.webp`, webp, "image/webp"],
      [fixture.owner.client, `${fixture.owner.id}/${product.id}/${job.id}-2.webp`, webp, "image/webp"],
      [fixture.owner.client, `${fixture.stranger.id}/${product.id}/${job.id}-1.webp`, webp, "image/webp"],
    ];
    for (const [client, name, body, contentType] of refused) {
      expect((await upload(client, name, body, contentType)).error, `${name} ${contentType}`).not.toBeNull();
    }
    expect(await stored(`${fixture.owner.id}/`)).toEqual([]);
    expect(await stored(`${fixture.stranger.id}/`)).toEqual([]);

    expect((await upload(fixture.owner.client, reserved)).error).toBeNull();
    expect((await upload(fixture.owner.client, reserved)).error).not.toBeNull();
    const overwrite = await pictures(fixture.owner.client).upload(reserved, Buffer.from(webp).reverse(), { contentType: "image/webp", upsert: true });
    expect(overwrite.error).not.toBeNull();
    const { data } = await pictures(fixture.owner.client).download(reserved);
    expect(Buffer.from(await data!.arrayBuffer()).equals(webp)).toBe(true);
    expect(await stored(`${fixture.owner.id}/`)).toEqual([reserved]);
  });

  it("맡지 않았거나 끝났거나 임대가 지난 작업의 이름에는 올릴 수 없다", async () => {
    const waiting = await saved();
    const { rows } = await fixture.admin.query<{ id: string }>("select id from moti.metadata_jobs where product_id = $1", [waiting.id]);
    const expired = await saved();
    const expiredJob = await claimed(expired);
    await expireLease(expiredJob);
    const failed = await saved();
    const failedJob = await claimed(failed);
    await jobs().fail(failedJob, "timeout");
    const ready = await saved();
    const readyJob = await claimed(ready);
    await jobs().complete(readyJob, page, { outcome: "failed", code: "timeout" });

    for (const name of [`${fixture.owner.id}/${waiting.id}/${rows[0].id}-1.webp`, expiredJob.picture, failedJob.picture, readyJob.picture]) {
      expect((await upload(fixture.owner.client, name)).error, name).not.toBeNull();
    }
    expect(await stored(`${fixture.owner.id}/`)).toEqual([]);
  });

  it("소유자는 서명한 주소로 같은 바이트를 받고 공개 주소·다른 계정·익명은 읽지 못한다", async () => {
    const product = await saved();
    const job = await copiedPicture(product);

    const signed = await pictures(fixture.owner.client).createSignedUrl(job.picture, 60);
    expect(signed.error).toBeNull();
    expect(new URL(signed.data!.signedUrl).pathname).toBe(`/storage/v1/object/sign/${PICTURE_BUCKET}/${job.picture}`);
    const download = await fetch(signed.data!.signedUrl);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(webp)).toBe(true);

    expect((await fetch(pictures(fixture.owner.client).getPublicUrl(job.picture).data.publicUrl)).status).toBe(400);
    for (const client of [fixture.stranger.client, fixture.anonymous]) {
      expect((await pictures(client).createSignedUrl(job.picture, 60)).error).not.toBeNull();
      expect((await pictures(client).download(job.picture)).error).not.toBeNull();
    }
  });

  it("완료는 이번 사진 결과를 기록하고 새 사본만 보여줄 사진을 바꾼다", async () => {
    const product = await saved();
    const first = await claimed(product);
    await upload(fixture.owner.client, first.picture);
    expect(await jobs().complete(first, page, copied)).toEqual({ kind: "applied", product: await current(product), replacedPicture: null });
    expect(await current(product)).toMatchObject({
      metadata: { phase: "ready", generation: 1, image: { outcome: "copied" } },
      picture: { version: first.id },
    });

    const failedCopy = await claimed(product, await nextGeneration(product));
    expect(await jobs().complete(failedCopy, page, { outcome: "failed", code: "unreadable_image" }))
      .toMatchObject({ kind: "applied", replacedPicture: null });
    expect(await current(product)).toMatchObject({
      metadata: { phase: "ready", generation: 2, image: { outcome: "failed", errorCode: "unreadable_image" } },
      picture: { version: first.id },
    });

    const pageFailure = await claimed(product, await nextGeneration(product));
    await jobs().fail(pageFailure, "blocked_by_site");
    expect((await current(product)).picture).toEqual({ version: first.id });

    const retried = await jobs().retry({ productId: product.id, expectedGeneration: 3 });
    const absent = await claimed(product, retried.product.metadata.generation);
    await jobs().complete(absent, { ...page, imageSourceUrl: null }, { outcome: "absent" });
    expect(await current(product)).toMatchObject({
      metadata: { phase: "ready", generation: 4, image: { outcome: "absent" } },
      picture: { version: first.id },
    });

    const second = await claimed(product, await nextGeneration(product));
    await upload(fixture.owner.client, second.picture);
    expect(await jobs().complete(second, page, copied)).toMatchObject({ kind: "applied", replacedPicture: first.picture });
    expect((await current(product)).picture).toEqual({ version: second.id });
  });

  it("소유자도 보여주는 사진은 지우지 못하고 바뀐 사진만 지운다", async () => {
    const product = await saved();
    const first = await copiedPicture(product);
    await pictures(fixture.owner.client).remove([first.picture]);
    expect(await stored(`${fixture.owner.id}/`)).toEqual([first.picture]);

    const second = await copiedPicture(product, await nextGeneration(product));
    await pictures(fixture.stranger.client).remove([first.picture]);
    expect(await stored(`${fixture.owner.id}/`)).toEqual([first.picture, second.picture].toSorted());

    await pictures(fixture.owner.client).remove([first.picture, second.picture]);
    expect(await stored(`${fixture.owner.id}/`)).toEqual([second.picture]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["알 수 없는 결과", { p_image: "nope" }],
    ["결과 없음", { p_image: null }],
    ["원인 없는 실패", { p_image: "failed", p_image_error_code: null }],
    ["원인이 붙은 사본", { p_image: "copied", p_image_error_code: "timeout" }],
    ["원인이 붙은 없음", { p_image: "absent", p_image_source_url: null, p_image_error_code: "timeout" }],
    ["사진 오류가 아닌 원인", { p_image: "failed", p_image_error_code: "no_product_data" }],
    ["닫힌 작업의 원인", { p_image: "failed", p_image_error_code: "superseded" }],
    ["주소가 있는데 없음", { p_image: "absent" }],
    ["주소 없이 사본", { p_image: "copied", p_image_source_url: null }],
    ["주소 없이 실패", { p_image: "failed", p_image_error_code: "timeout", p_image_source_url: null }],
    ["올리지 않은 사본", { p_image: "copied" }],
  ])("%s으로 끝내려는 완료는 DB가 거절한다", async (_, override) => {
    const product = await saved();
    const job = await claimed(product);
    const response = await fixture.owner.client.rpc("moti_metadata_complete", {
      p_job_id: job.id, p_lease: job.leaseToken, p_title: "램프", p_amount_minor: null, p_currency: null,
      p_image_source_url: page.imageSourceUrl, p_image_error_code: null, ...override,
    });
    expect(response.error?.code).toBe("M0002");
    expect((await current(product)).metadata.phase).toBe("running");
  });

  it("DB의 사진 오류 목록은 코드의 목록과 같다", async () => {
    const { rows } = await fixture.admin.query<{ prosrc: string }>(
      "select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'moti' and p.proname = 'is_image_error'",
    );
    expect(rows).toHaveLength(1);
    expect([...rows[0].prosrc.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).toSorted()).toEqual(imageErrorCodes.toSorted());
    for (const code of [...imageErrorCodes, "no_product_data", "attempts_exhausted", "superseded", "nope"]) {
      const result = await fixture.admin.query<{ ok: boolean }>("select moti.is_image_error($1) as ok", [code]);
      expect(result.rows[0].ok, code).toBe((imageErrorCodes as readonly string[]).includes(code));
    }
  });

  it("사진을 가져오지 못한 상품은 다시 가져오면 새 세대로 대기하고 사본이 있는 상품은 거절한다", async () => {
    const product = await saved();
    const kept = await copiedPicture(product);
    const raw = (generation: number) =>
      fixture.owner.client.rpc("moti_metadata_retry", { p_product_id: product.id, p_expected_generation: generation });
    expect((await raw(1)).error?.code).toBe("M0007");

    const job = await claimed(product, await nextGeneration(product));
    await jobs().complete(job, page, { outcome: "failed", code: "upload_failed" });

    const retried = await jobs().retry({ productId: product.id, expectedGeneration: 2 });

    expect(retried).toMatchObject({
      kind: "requeued",
      product: { metadata: { phase: "queued", generation: 3, attempts: 0, stalled: false }, picture: { version: kept.id } },
    });
    const { rows } = await fixture.admin.query("select metadata_image, metadata_image_error_code from moti.products where id = $1", [product.id]);
    expect(rows).toEqual([{ metadata_image: null, metadata_image_error_code: null }]);
  });

  it("보여줄 사진의 이름은 소유자만 찾고 상품 응답에는 이름도 버킷도 없다", async () => {
    const product = await saved();
    const locate = (client: SupabaseClient, productId: string = product.id) =>
      client.rpc("moti_picture_locate", { p_product_id: productId });
    expect(await locate(fixture.owner.client)).toMatchObject({ data: null, error: null });

    const job = await copiedPicture(product);

    expect((await locate(fixture.owner.client)).data).toBe(job.picture);
    expect((await locate(fixture.owner.client, randomUUID())).error?.code).toBe("M0006");
    expect((await locate(fixture.stranger.client)).error?.code).toBe("M0001");
    expect((await locate(fixture.anonymous)).error?.code).toBe("42501");
    const snapshot = await fixture.owner.client.rpc("moti_snapshot");
    expect(snapshot.error).toBeNull();
    const text = JSON.stringify(snapshot.data);
    expect(text).toContain(`"picture_version":"${job.id}"`);
    for (const hidden of [job.picture, ".webp", PICTURE_BUCKET, "cdn.shop.example"]) expect(text).not.toContain(hidden);
  });

  it("보관함 저장소는 보여줄 사진을 한 시간짜리 서명 주소로 열고 사본이 없으면 없다고 답한다", async () => {
    const product = await saved();
    expect(await library().openPicture({ productId: product.id })).toEqual({ kind: "missing" });
    const job = await copiedPicture(product);

    const opened = await library().openPicture({ productId: product.id });

    if (opened.kind !== "found") throw new Error("사진을 열지 못했습니다.");
    const url = new URL(opened.url);
    expect(url.pathname).toBe(`/storage/v1/object/sign/${PICTURE_BUCKET}/${job.picture}`);
    const claims = JSON.parse(Buffer.from(url.searchParams.get("token")!.split(".")[1], "base64url").toString("utf8"));
    expect(claims.exp - claims.iat).toBe(3600);
    expect(Buffer.from(await (await fetch(url)).arrayBuffer()).equals(webp)).toBe(true);
    await expect(library().openPicture({ productId: randomUUID() as Product["id"] })).rejects.toMatchObject({ code: "product_missing" });
    await expect(createSupabaseLibraryStore(fixture.stranger.client).openPicture({ productId: product.id }))
      .rejects.toMatchObject({ code: "unauthorized" });
  });

  it("사진 정책은 RPC 역할로 실행하는 별도 스키마의 함수이고 공개 REST에 드러나지 않으며 덮어쓰기 정책이 없다", async () => {
    const functions = await fixture.admin.query<{ proname: string; owner: string; prosecdef: boolean; anon_execute: boolean; authenticated_execute: boolean }>(
      `select p.proname, r.rolname as owner, p.prosecdef,
       has_function_privilege('anon', p.oid, 'execute') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
       where n.nspname = 'moti_storage'`,
    );
    expect(functions.rows.length).toBeGreaterThan(0);
    for (const row of functions.rows) {
      expect(row).toMatchObject({ owner: "moti_rpc", prosecdef: true, anon_execute: false, authenticated_execute: true });
    }
    expect((await fixture.owner.client.schema("moti_storage").rpc(functions.rows[0].proname, {})).error?.code).toBe("PGRST106");

    const policies = await fixture.admin.query<{ cmd: string; roles: string[] }>(
      "select cmd, roles::text[] as roles from pg_policies where schemaname = 'storage' and tablename = 'objects' order by cmd",
    );
    expect(policies.rows).toEqual([
      { cmd: "DELETE", roles: ["authenticated"] },
      { cmd: "INSERT", roles: ["authenticated"] },
      { cmd: "SELECT", roles: ["authenticated"] },
    ]);
  });
});
