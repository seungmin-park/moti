import { describe, expect, it, vi } from "vitest";
import type { Product, ProductId } from "../../library/domain/library";
import { createCollectionRunner, decideOutcome, runWithin, type CollectionJob, type CollectionJobStore } from "./collection";
import type { ImageCopy, PictureCopier, PictureObject } from "./picture-copy";

describe("수집 결과 결정", () => {
  it("Given 이름과 하나의 가격 When 결정하면 Then 이름·가격·이미지를 저장한다", () => {
    expect(decideOutcome({
      title: "무선 헤드폰",
      prices: [{ amount: "289000", currency: "KRW" }, { amount: "289,000", currency: "KRW" }],
      imageUrl: "https://cdn.shop.example/a.jpg",
    })).toEqual({
      kind: "complete",
      page: { title: "무선 헤드폰", price: { amountMinor: 289000, currency: "KRW" }, imageSourceUrl: "https://cdn.shop.example/a.jpg" },
    });
  });

  it("Given 가격이 여럿이거나 통화가 없음 When 결정하면 Then 가격을 지어내지 않고 이름만 저장한다", () => {
    expect(decideOutcome({ title: "의자", prices: [{ amount: "1", currency: "KRW" }, { amount: "2", currency: "KRW" }], imageUrl: null }))
      .toEqual({ kind: "complete", page: { title: "의자", price: null, imageSourceUrl: null } });
    expect(decideOutcome({ title: "의자", prices: [{ amount: "39000", currency: null }], imageUrl: null }))
      .toEqual({ kind: "complete", page: { title: "의자", price: null, imageSourceUrl: null } });
  });

  it("Given 이름이 없는 페이지 When 결정하면 Then 상품 정보 없음으로 실패한다", () => {
    expect(decideOutcome({ title: null, prices: [{ amount: "1000", currency: "KRW" }], imageUrl: null }))
      .toEqual({ kind: "fail", code: "no_product_data" });
  });
});

const job: CollectionJob = {
  id: "job-1",
  leaseToken: "lease-1",
  generation: 1,
  attempts: 1,
  sourceUrl: "https://shop.example/p",
  picture: "owner/p-1/job-1-1.webp" as PictureObject,
};
const product = { id: "p-1" as ProductId } as Product;

function store(overrides: Partial<CollectionJobStore> = {}): CollectionJobStore {
  return {
    claim: vi.fn(async () => ({ kind: "claimed" as const, job })),
    complete: vi.fn(async () => ({ kind: "applied" as const, product, replacedPicture: null })),
    fail: vi.fn(async () => ({ kind: "applied" as const, product, replacedPicture: null })),
    retry: vi.fn(),
    ...overrides,
  };
}

// Stands in for the copier: it hands the given outcome to the settlement, as the real one does after copying.
function copier(image: ImageCopy = { outcome: "absent" }) {
  return { settleWith: vi.fn<PictureCopier["settleWith"]>(async (_task, settle) => settle(image)) };
}

describe("수집 실행기", () => {
  const request = { productId: "p-1" as ProductId, generation: 1 };
  const page = { ok: true as const, page: { html: "<title>램프</title>", url: "https://shop.example/p", status: 200 } };

  it("Given 이름과 사진 주소가 있는 페이지 When 실행하면 Then 사진 결과를 이름·가격과 함께 한 번에 끝낸다", async () => {
    const jobs = store();
    const pictures = copier({ outcome: "copied" });
    const runner = createCollectionRunner({
      store: jobs,
      source: { read: vi.fn(async () => ({ ...page, page: { ...page.page, url: "https://shop.example/p?moved=1" } })) },
      read: vi.fn(() => ({ title: "램프", prices: [], imageUrl: "https://cdn.shop.example/lamp.png" })),
      copier: pictures,
    });

    await expect(runner.run(request)).resolves.toEqual({ kind: "collected", product });

    expect(pictures.settleWith).toHaveBeenCalledExactlyOnceWith({
      imageUrl: "https://cdn.shop.example/lamp.png",
      pageUrl: "https://shop.example/p?moved=1",
      target: job.picture,
    }, expect.any(Function));
    expect(jobs.complete).toHaveBeenCalledExactlyOnceWith(job,
      { title: "램프", price: null, imageSourceUrl: "https://cdn.shop.example/lamp.png" }, { outcome: "copied" });
  });

  it("Given 페이지를 읽지 못함 When 실행하면 Then 사진은 가져오지 않고 실패만 기록한다", async () => {
    const jobs = store();
    const pictures = copier();
    const runner = createCollectionRunner({
      store: jobs,
      source: { read: vi.fn(async () => ({ ok: false as const, code: "blocked_by_site" as const, status: 403 })) },
      read: vi.fn(),
      copier: pictures,
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "failed", code: "blocked_by_site", product });
    expect(pictures.settleWith).not.toHaveBeenCalled();
    expect(jobs.complete).not.toHaveBeenCalled();
  });

  it("Given 사진과 함께 끝내기가 예외 When 실행하면 Then 내부 오류로 실패를 기록한다", async () => {
    const jobs = store({ complete: vi.fn(async () => { throw new Error("db down"); }) });
    const runner = createCollectionRunner({
      store: jobs,
      source: { read: vi.fn(async () => page) },
      read: vi.fn(() => ({ title: "램프", prices: [], imageUrl: null })),
      copier: copier(),
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "failed", code: "internal", product });
    expect(jobs.fail).toHaveBeenCalledWith(job, "internal");
  });

  it("Given 저장소가 응답하지 않음 When 실행하면 Then 예외 없이 사용할 수 없음을 돌려준다", async () => {
    const runner = createCollectionRunner({
      store: store({ claim: vi.fn(async () => { throw new Error("db down"); }) }),
      source: { read: vi.fn() },
      read: vi.fn(),
      copier: copier(),
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "unavailable" });
  });

  it("Given 맡은 뒤 읽기 단계가 예상하지 못한 오류 When 실행하면 Then 내부 오류로 실패를 기록한다", async () => {
    const jobs = store();
    const runner = createCollectionRunner({
      store: jobs,
      source: { read: vi.fn(async () => page) },
      read: vi.fn(() => { throw new Error("parser bug"); }),
      copier: copier(),
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "failed", code: "internal", product });
    expect(jobs.fail).toHaveBeenCalledWith(job, "internal");
  });

  it("Given 실패 기록도 실패 When 실행하면 Then 예외 없이 사용할 수 없음을 돌려준다", async () => {
    const runner = createCollectionRunner({
      store: store({ fail: vi.fn(async () => { throw new Error("db down"); }) }),
      source: { read: vi.fn(async () => ({ ok: false as const, code: "timeout" as const, status: null })) },
      read: vi.fn(),
      copier: copier(),
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "unavailable" });
  });

  it("Given 이미 끝났거나 다른 실행이 맡은 작업 When 실행하면 Then 페이지를 요청하지 않는다", async () => {
    const source = { read: vi.fn() };
    const runner = createCollectionRunner({
      store: store({ claim: vi.fn(async () => ({ kind: "skipped" as const, reason: "busy" as const })) }),
      source,
      read: vi.fn(),
      copier: copier(),
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "skipped", reason: "busy" });
    expect(source.read).not.toHaveBeenCalled();
  });
});

describe("시간 안에 나눠 실행", () => {
  function clock(start = 0) {
    let time = start;
    return { now: () => time, advance: (ms: number) => { time += ms; } };
  }

  it("Given 다섯 항목 When 동시 2개로 실행하면 Then 한 번에 둘을 넘지 않고 순서대로 모두 시작한다", async () => {
    const { now } = clock();
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const count = await runWithin([1, 2, 3, 4, 5], async (item) => {
      started.push(item);
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    }, { concurrency: 2, deadline: 1000, now });

    expect(count).toBe(5);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(most).toBe(2);
  });

  it("Given 마감이 지남 When 다음 항목을 고르면 Then 새로 시작하지 않고 시작한 수를 돌려준다", async () => {
    const time = clock();
    const started: string[] = [];
    const count = await runWithin(["a", "b", "c", "d"], async (item) => {
      started.push(item);
      time.advance(30);
    }, { concurrency: 1, deadline: 50, now: time.now });

    expect(started).toEqual(["a", "b"]);
    expect(count).toBe(2);
  });

  it("Given 예외를 던지는 실행 When 실행하면 Then 예외 없이 나머지를 이어서 시작한다", async () => {
    const { now } = clock();
    const started: number[] = [];
    await expect(runWithin([1, 2, 3], async (item) => {
      started.push(item);
      if (item === 1) throw new Error("boom");
    }, { concurrency: 1, deadline: 1000, now })).resolves.toBe(3);
    expect(started).toEqual([1, 2, 3]);
  });

  it("Given 빈 목록 When 실행하면 Then 아무것도 시작하지 않는다", async () => {
    await expect(runWithin([], async () => undefined, { concurrency: 2, deadline: 1000, now: () => 0 })).resolves.toBe(0);
  });
});
