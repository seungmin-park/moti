import { describe, expect, it, vi } from "vitest";
import type { Product, ProductId } from "../../library/domain/library";
import { createCollectionRunner, decideOutcome, type CollectionJob, type CollectionJobStore } from "./collection";

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

const job: CollectionJob = { id: "job-1", leaseToken: "lease-1", generation: 1, attempts: 1, sourceUrl: "https://shop.example/p" };
const product = { id: "p-1" as ProductId } as Product;

function store(overrides: Partial<CollectionJobStore> = {}): CollectionJobStore {
  return {
    claim: vi.fn(async () => ({ kind: "claimed" as const, job })),
    complete: vi.fn(async () => ({ kind: "applied" as const, product })),
    fail: vi.fn(async () => ({ kind: "applied" as const, product })),
    retry: vi.fn(),
    ...overrides,
  };
}

describe("수집 실행기", () => {
  const request = { productId: "p-1" as ProductId, generation: 1 };
  const page = { ok: true as const, page: { html: "<title>램프</title>", url: "https://shop.example/p", status: 200 } };

  it("Given 저장소가 응답하지 않음 When 실행하면 Then 예외 없이 사용할 수 없음을 돌려준다", async () => {
    const runner = createCollectionRunner({
      store: store({ claim: vi.fn(async () => { throw new Error("db down"); }) }),
      source: { read: vi.fn() },
      read: vi.fn(),
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "unavailable" });
  });

  it("Given 맡은 뒤 읽기 단계가 예상하지 못한 오류 When 실행하면 Then 내부 오류로 실패를 기록한다", async () => {
    const jobs = store();
    const runner = createCollectionRunner({
      store: jobs,
      source: { read: vi.fn(async () => page) },
      read: vi.fn(() => { throw new Error("parser bug"); }),
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "failed", code: "internal", product });
    expect(jobs.fail).toHaveBeenCalledWith(job, "internal");
  });

  it("Given 실패 기록도 실패 When 실행하면 Then 예외 없이 사용할 수 없음을 돌려준다", async () => {
    const runner = createCollectionRunner({
      store: store({ fail: vi.fn(async () => { throw new Error("db down"); }) }),
      source: { read: vi.fn(async () => ({ ok: false as const, code: "timeout" as const, status: null })) },
      read: vi.fn(),
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "unavailable" });
  });

  it("Given 이미 끝났거나 다른 실행이 맡은 작업 When 실행하면 Then 페이지를 요청하지 않는다", async () => {
    const source = { read: vi.fn() };
    const runner = createCollectionRunner({
      store: store({ claim: vi.fn(async () => ({ kind: "skipped" as const, reason: "busy" as const })) }),
      source,
      read: vi.fn(),
    });
    await expect(runner.run(request)).resolves.toEqual({ kind: "skipped", reason: "busy" });
    expect(source.read).not.toHaveBeenCalled();
  });
});
