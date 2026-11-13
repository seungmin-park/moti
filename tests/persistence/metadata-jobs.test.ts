import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product } from "../../src/features/library/domain/library";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import type { CollectedPage, CollectionJob } from "../../src/features/metadata/application/collection";
import type { ImageCopy } from "../../src/features/metadata/application/picture-copy";
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
const page: CollectedPage = {
  title: "무선 헤드폰",
  price: { amountMinor: 289000, currency: "KRW" },
  imageSourceUrl: "https://cdn.shop.example/headphones.jpg",
};
const notCopied: ImageCopy = { outcome: "failed", code: "timeout" };

async function saved(url = "https://shop.example/item"): Promise<Product> {
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

async function jobRows(product: Product) {
  const { rows } = await fixture.admin.query<{ generation: number; status: string; attempts: number; error_code: string | null; image_source_url: string | null }>(
    "select generation, status, attempts, error_code, image_source_url from moti.metadata_jobs where product_id = $1 order by generation",
    [product.id],
  );
  return rows;
}

const expireLease = (job: CollectionJob) =>
  fixture.admin.query("update moti.metadata_jobs set lease_until = now() - interval '1 second' where id = $1", [job.id]);

describe("수집 작업 저장소", () => {
  it("맡은 작업을 완료하면 이름과 가격을 기록하고 작업에만 이미지 주소를 남긴다", async () => {
    const product = await saved();
    const job = await claimed(product);
    expect(job).toMatchObject({ generation: 1, attempts: 1, sourceUrl: "https://shop.example/item" });
    expect((await current(product)).metadata).toEqual({ phase: "running", generation: 1, attempts: 1, stalled: false });

    const settlement = await jobs().complete(job, page, notCopied);

    expect(settlement.kind).toBe("applied");
    const stored = await current(product);
    expect(settlement).toEqual({ kind: "applied", product: stored, replacedPicture: null });
    expect(stored).toMatchObject({
      title: "무선 헤드폰",
      revision: product.revision,
      updatedAt: product.updatedAt,
      metadata: { phase: "ready", generation: 1, attempts: 1 },
      lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW" },
    });
    expect(await jobRows(product)).toEqual([
      { generation: 1, status: "succeeded", attempts: 1, error_code: null, image_source_url: page.imageSourceUrl },
    ]);
  });

  it("같은 작업을 동시에 여러 번 맡으려 해도 하나만 맡는다", async () => {
    const product = await saved();
    const claims = await Promise.all(Array.from({ length: 6 }, () => jobs().claim({ productId: product.id, generation: 1 })));
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind !== "claimed")).toEqual(Array(5).fill({ kind: "skipped", reason: "busy" }));
    expect(await jobRows(product)).toMatchObject([{ status: "running", attempts: 1 }]);
  });

  it("다른 세대나 끝난 작업은 맡지 않는다", async () => {
    const product = await saved();
    expect(await jobs().claim({ productId: product.id, generation: 2 })).toEqual({ kind: "skipped", reason: "stale" });
    expect(await jobs().claim({ productId: randomUUID() as Product["id"], generation: 1 })).toEqual({ kind: "skipped", reason: "stale" });
    await jobs().complete(await claimed(product), page, notCopied);
    expect(await jobs().claim({ productId: product.id, generation: 1 })).toEqual({ kind: "skipped", reason: "settled" });
  });

  it("실패를 기록하면 링크를 지키고 실패 코드를 남긴다", async () => {
    const product = await saved();
    const settlement = await jobs().fail(await claimed(product), "blocked_address");
    const stored = await current(product);
    expect(settlement).toEqual({ kind: "applied", product: stored, replacedPicture: null });
    expect(stored).toMatchObject({
      sourceUrl: product.sourceUrl,
      title: product.title,
      metadata: { phase: "failed", generation: 1, attempts: 1, errorCode: "blocked_address" },
      lastSuccessfulPrice: null,
    });
    expect(await jobRows(product)).toMatchObject([{ status: "failed", error_code: "blocked_address" }]);
  });

  it("수집 중이거나 막 담았거나 이미 끝났거나 세대가 다르면 다시 가져오기를 거절한다", async () => {
    const product = await saved();
    const raw = (generation = 1, productId: string = product.id) =>
      fixture.owner.client.rpc("moti_metadata_retry", { p_product_id: productId, p_expected_generation: generation });

    expect((await raw()).error?.code).toBe("M0007");
    await expect(jobs().retry({ productId: product.id, expectedGeneration: 1 })).rejects.toMatchObject({ code: "metadata_not_retryable" });
    const job = await claimed(product);
    expect((await raw()).error?.code).toBe("M0007");
    await jobs().fail(job, "timeout");
    expect((await raw(2)).error?.code).toBe("M0007");
    expect((await raw(1, randomUUID())).error?.code).toBe("M0006");
    await expect(jobs().retry({ productId: randomUUID() as Product["id"], expectedGeneration: 1 }))
      .rejects.toMatchObject({ code: "product_missing" });

    const ready = await saved("https://shop.example/ready");
    await jobs().complete(await claimed(ready), { ...page, imageSourceUrl: null }, { outcome: "absent" });
    expect((await raw(1, ready.id)).error?.code).toBe("M0007");
    expect(await jobRows(product)).toMatchObject([{ generation: 1, status: "failed" }]);
  });

  it("실패한 상품을 다시 가져오면 새 세대로 대기하고 늦게 끝난 이전 세대는 반영하지 않는다", async () => {
    const product = await saved();
    const old = await claimed(product);
    await expireLease(old);
    await fixture.admin.query("update moti.metadata_jobs set attempts = 3 where id = $1", [old.id]);
    await fixture.admin.query("update moti.products set metadata_attempts = 3 where id = $1", [product.id]);
    expect((await current(product)).metadata).toMatchObject({ phase: "running", stalled: true });

    const retried = await jobs().retry({ productId: product.id, expectedGeneration: 1 });

    expect(retried.kind).toBe("requeued");
    expect(retried.product.metadata).toEqual({ phase: "queued", generation: 2, attempts: 0, stalled: false });
    expect(await jobs().complete(old, page, notCopied)).toEqual({ kind: "stale" });
    expect(await jobs().fail(old, "timeout")).toEqual({ kind: "stale" });
    expect(await current(product)).toEqual(retried.product);
    expect(await jobRows(product)).toMatchObject([
      { generation: 1, status: "failed", error_code: "superseded", image_source_url: null },
      { generation: 2, status: "queued", attempts: 0 },
    ]);

    const next = await claimed(product, 2);
    expect((await jobs().complete(next, page, notCopied)).kind).toBe("applied");
    expect((await current(product)).metadata).toMatchObject({ phase: "ready", generation: 2 });
  });

  it("실패 뒤 다시 가져오면 세대가 하나 오르고 시도 횟수가 처음부터다", async () => {
    const product = await saved();
    await jobs().fail(await claimed(product), "timeout");
    const retried = await jobs().retry({ productId: product.id, expectedGeneration: 1 });
    expect(retried).toMatchObject({ kind: "requeued", product: { metadata: { phase: "queued", generation: 2, attempts: 0 } } });
    expect(await jobRows(product)).toMatchObject([
      { generation: 1, status: "failed", error_code: "timeout" },
      { generation: 2, status: "queued" },
    ]);
  });

  it("세대가 바뀐 뒤 도착한 완료는 작업만 superseded로 닫고 상품을 바꾸지 않는다", async () => {
    const product = await saved();
    const job = await claimed(product);
    await fixture.admin.query("update moti.products set metadata_generation = 2, metadata_phase = 'queued' where id = $1", [product.id]);
    const before = await current(product);

    expect(await jobs().complete(job, page, notCopied)).toEqual({ kind: "stale" });

    expect(await current(product)).toEqual(before);
    expect(await jobRows(product)).toMatchObject([{ generation: 1, status: "failed", error_code: "superseded" }]);
  });

  it("맡은 기한이 지난 작업은 세 번까지 다시 맡고 그 뒤에는 시도 초과로 실패한다", async () => {
    const product = await saved();
    const first = await claimed(product);
    await expireLease(first);
    const second = await claimed(product);
    expect(second.attempts).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await jobs().complete(first, page, notCopied)).toEqual({ kind: "stale" });
    await expireLease(second);
    const third = await claimed(product);
    expect(third.attempts).toBe(3);
    await expireLease(third);

    const exhausted = await jobs().claim({ productId: product.id, generation: 1 });

    const stored = await current(product);
    expect(exhausted).toEqual({ kind: "exhausted", product: stored });
    expect(stored.metadata).toEqual({ phase: "failed", generation: 1, attempts: 3, errorCode: "attempts_exhausted" });
    expect(await jobRows(product)).toMatchObject([{ status: "failed", attempts: 3, error_code: "attempts_exhausted" }]);
    expect(await jobs().complete(third, page, notCopied)).toEqual({ kind: "stale" });
  });

  it("다른 임차 토큰의 완료와 실패는 반영하지 않는다", async () => {
    const product = await saved();
    const job = await claimed(product);
    const forged = { ...job, leaseToken: randomUUID() };
    expect(await jobs().complete(forged, page, notCopied)).toEqual({ kind: "stale" });
    expect(await jobs().fail(forged, "timeout")).toEqual({ kind: "stale" });
    expect((await current(product)).metadata.phase).toBe("running");
  });

  it.each([
    ["moti_metadata_fail", { p_error_code: "nope" }],
    ["moti_metadata_fail", { p_error_code: "superseded" }],
    ["moti_metadata_fail", { p_error_code: null }],
    ["moti_metadata_complete", { p_title: "" }],
    ["moti_metadata_complete", { p_title: "가".repeat(121) }],
    ["moti_metadata_complete", { p_title: "줄\n바꿈" }],
    ["moti_metadata_complete", { p_amount_minor: 1000, p_currency: null }],
    ["moti_metadata_complete", { p_amount_minor: null, p_currency: "KRW" }],
    ["moti_metadata_complete", { p_amount_minor: 0, p_currency: "KRW" }],
    ["moti_metadata_complete", { p_amount_minor: 1000, p_currency: "krw" }],
    ["moti_metadata_complete", { p_image_source_url: "javascript:alert(1)", p_image: "failed", p_image_error_code: "timeout" }],
  ])("%s의 잘못된 입력 %j은 DB가 거절한다", async (name, override) => {
    const product = await saved();
    const job = await claimed(product);
    const base = name === "moti_metadata_fail"
      ? { p_job_id: job.id, p_lease: job.leaseToken, p_error_code: "timeout" }
      : {
        p_job_id: job.id, p_lease: job.leaseToken, p_title: "램프", p_amount_minor: null, p_currency: null,
        p_image_source_url: null, p_image: "absent", p_image_error_code: null,
      };
    const response = await fixture.owner.client.rpc(name, { ...base, ...override });
    expect(response.error?.code).toBe("M0002");
    expect((await current(product)).metadata.phase).toBe("running");
  });

  it("다른 통화로 확인한 가격은 마지막 성공 가격을 덮어쓰지 않고 같은 통화는 갱신한다", async () => {
    const product = await saved();
    await jobs().complete(await claimed(product), page, notCopied);
    const first = (await current(product)).lastSuccessfulPrice;
    const requeue = async (generation: number) => {
      await fixture.admin.query(
        `update moti.products set metadata_phase = 'failed', metadata_error_code = 'timeout', metadata_completed_at = null,
         metadata_image = null, metadata_image_error_code = null where id = $1`,
        [product.id],
      );
      await jobs().retry({ productId: product.id, expectedGeneration: generation });
      return claimed(product, generation + 1);
    };

    await jobs().complete(await requeue(1), { ...page, title: "Headphones", price: { amountMinor: 1999, currency: "USD" } }, notCopied);
    expect(await current(product)).toMatchObject({ title: "Headphones", lastSuccessfulPrice: first });

    await jobs().complete(await requeue(2), { ...page, price: { amountMinor: 279000, currency: "KRW" } }, notCopied);
    expect((await current(product)).lastSuccessfulPrice).toMatchObject({ amountMinor: 279000, currency: "KRW" });
  });

  it("오래 대기하거나 기한이 지난 작업은 멈춤으로 보이고 시도가 남았으면 같은 세대를 멈추지 않은 대기로 되돌린다", async () => {
    const product = await saved();
    await fixture.admin.query(
      "update moti.metadata_jobs set created_at = now() - interval '2 minutes', updated_at = now() - interval '2 minutes' where product_id = $1",
      [product.id],
    );
    expect((await current(product)).metadata).toEqual({ phase: "queued", generation: 1, attempts: 0, stalled: true });
    const waiting = await jobs().retry({ productId: product.id, expectedGeneration: 1 });
    expect(waiting).toEqual({ kind: "resumed", product: await current(product) });
    expect(waiting.product.metadata).toEqual({ phase: "queued", generation: 1, attempts: 0, stalled: false });

    const job = await claimed(product);
    expect((await current(product)).metadata).toMatchObject({ phase: "running", stalled: false });
    await expireLease(job);
    expect((await current(product)).metadata).toMatchObject({ phase: "running", stalled: true });
    const expired = await jobs().retry({ productId: product.id, expectedGeneration: 1 });
    expect(expired).toEqual({ kind: "resumed", product: await current(product) });
    expect(expired.product.metadata).toEqual({ phase: "queued", generation: 1, attempts: 1, stalled: false });
    expect(await jobs().complete(job, page, notCopied)).toEqual({ kind: "stale" });

    expect((await claimed(product)).attempts).toBe(2);
  });

  it("보관함과 수집 응답 어디에도 원본 이미지 주소를 내보내지 않는다", async () => {
    const product = await saved();
    const job = await claimed(product);
    const completed = await fixture.owner.client.rpc("moti_metadata_complete", {
      p_job_id: job.id, p_lease: job.leaseToken, p_title: "램프", p_amount_minor: null, p_currency: null,
      p_image_source_url: page.imageSourceUrl, p_image: "failed", p_image_error_code: "timeout",
    });
    const snapshot = await fixture.owner.client.rpc("moti_snapshot");
    for (const response of [completed, snapshot]) {
      expect(response.error).toBeNull();
      expect(JSON.stringify(response.data)).not.toContain("cdn.shop.example");
    }
  });

  it("다른 계정과 익명 요청은 수집 작업을 맡거나 끝내거나 다시 시작할 수 없다", async () => {
    const product = await saved();
    const job = await claimed(product);
    const calls = [
      ["moti_metadata_claim", { p_product_id: product.id, p_generation: 1 }],
      ["moti_metadata_complete", {
        p_job_id: job.id, p_lease: job.leaseToken, p_title: "탈취", p_amount_minor: null, p_currency: null,
        p_image_source_url: null, p_image: "absent", p_image_error_code: null,
      }],
      ["moti_metadata_fail", { p_job_id: job.id, p_lease: job.leaseToken, p_error_code: "timeout" }],
      ["moti_metadata_retry", { p_product_id: product.id, p_expected_generation: 1 }],
      ["moti_metadata_wake", { p_limit: 8 }],
    ] as const;
    for (const [name, parameters] of calls) {
      expect((await fixture.stranger.client.rpc(name, parameters)).error?.code).toBe("M0001");
      expect((await fixture.anonymous.rpc(name, parameters)).error?.code).toBe("42501");
    }
    expect(await current(product)).toMatchObject({ title: product.title, metadata: { phase: "running", attempts: 1 } });
    const internal = await fixture.admin.query<{ proname: string; authenticated_execute: boolean; anon_execute: boolean }>(
      `select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
       has_function_privilege('anon', p.oid, 'execute') as anon_execute
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'moti' and p.proname like 'metadata_%'`,
    );
    expect(internal.rows.map((row) => row.proname).toSorted()).toEqual([
      "metadata_claim", "metadata_complete", "metadata_fail", "metadata_retry", "metadata_wake",
    ]);
    expect(internal.rows.every((row) => !row.authenticated_execute && !row.anon_execute)).toBe(true);
  });

  it("작업 상태와 임차·오류 열이 어긋난 행은 DB가 거절한다", async () => {
    const product = await saved();
    for (const update of [
      "status = 'running'",
      "status = 'failed'",
      "status = 'queued', lease_token = gen_random_uuid(), lease_until = now()",
      "error_code = 'nope', status = 'failed'",
    ]) {
      await expect(fixture.admin.query(`update moti.metadata_jobs set ${update} where product_id = $1`, [product.id]))
        .rejects.toMatchObject({ code: "23514" });
    }
    await expect(fixture.admin.query(
      "update moti.products set metadata_phase = 'failed', metadata_error_code = 'nope' where id = $1", [product.id],
    )).rejects.toMatchObject({ code: "23514" });
  });
});
