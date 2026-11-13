import { describe, expect, it, vi } from "vitest";
import type { PageRead, PageReader, PageSource } from "../../metadata/application/collection";
import type { PageFacts } from "../../metadata/domain/page-facts";
import { WorkerError, type WorkerCounts, type WorkerSecret } from "../domain/worker";
import { RUN_LANES, RUN_MAX_ITEMS, RUN_START_WINDOW_MS, createScheduledRunService } from "./scheduled-run";
import type { WorkerItem, WorkerJob, WorkerRunLease, WorkerRunStore } from "./worker-store";

const secret = `moti_wk_${"AbcdEfghIjklMnopQrstUvwxYz0123456789-_AbCdE"}` as WorkerSecret;
const lease: WorkerRunLease = { secret, run: "11111111-1111-4111-8111-111111111111", lease: "22222222-2222-4222-8222-222222222222" };
const counts: WorkerCounts = { collections: { collected: 0, failed: 0 }, prices: { confirmed: 0, kept: 0 }, failures: {} };
const job = (index: number): WorkerJob => ({ id: `job-${index}`, leaseToken: `lease-${index}`, sourceUrl: `https://shop.example/${index}` });
const facts = (title: string | null): PageFacts =>
  ({ title, prices: [{ amount: "12,000", currency: "KRW" }], imageUrl: "https://img.example/a.jpg" });

// A store that hands out `items` in order, then none.
function given({ items = 0, page = { ok: true, page: { html: "<html>", url: "https://shop.example/x", status: 200 } } as PageRead } = {}) {
  let handed = 0;
  let clock = 0;
  const store = {
    begin: vi.fn<WorkerRunStore["begin"]>(async () => lease),
    next: vi.fn<WorkerRunStore["next"]>(async (): Promise<WorkerItem> => (handed < items ? { kind: "collection", job: job(handed++) } : { kind: "none" })),
    complete: vi.fn<WorkerRunStore["complete"]>(async () => "applied"),
    fail: vi.fn<WorkerRunStore["fail"]>(async () => "applied"),
    finish: vi.fn<WorkerRunStore["finish"]>(async (_lease, stop) => ({ stop, ...counts })),
  };
  const source = { read: vi.fn<PageSource["read"]>(async () => page) };
  const read = vi.fn<PageReader>(() => facts("북유럽 램프"));
  const now = () => clock;
  const service = createScheduledRunService({ store, source, read, now });
  return { service, store, source, read, advance: (ms: number) => { clock += ms; } };
}

describe("예약 실행", () => {
  it("Given 수집할 상품 둘 When 실행하면 Then 각 페이지를 읽어 사진 없이 이름과 가격을 쓰고, 남은 일이 없어 done으로 끝낸다", async () => {
    const { service, store, source } = given({ items: 2 });

    const result = await service.run({ secret });

    expect(result).toEqual({ kind: "finished", stop: "done", ...counts });
    expect(store.begin).toHaveBeenCalledWith(secret);
    expect(source.read.mock.calls.map(([url]) => url).toSorted()).toEqual(["https://shop.example/0", "https://shop.example/1"]);
    expect(store.complete).toHaveBeenCalledTimes(2);
    expect(store.complete).toHaveBeenCalledWith(lease, job(0), {
      title: "북유럽 램프",
      price: { amountMinor: 12000, currency: "KRW" },
      imageSourceUrl: "https://img.example/a.jpg",
    });
    expect(store.complete.mock.calls[0]).toHaveLength(3);
    expect(store.finish).toHaveBeenCalledWith(lease, "done");
  });

  it("Given 가져오기가 막힌 페이지와 상품 정보가 없는 페이지 When 실행하면 Then 각 이유로 실패를 쓰고 실행은 이어간다", async () => {
    const blocked = given({ items: 2, page: { ok: false, code: "blocked_by_site", status: 403 } });
    expect(await blocked.service.run({ secret })).toMatchObject({ kind: "finished", stop: "done" });
    expect(blocked.store.fail.mock.calls.map(([, item, code]) => [item.id, code]).toSorted()).toEqual([["job-0", "blocked_by_site"], ["job-1", "blocked_by_site"]]);

    const empty = given({ items: 1 });
    empty.read.mockReturnValue(facts(null));
    await empty.service.run({ secret });
    expect(empty.store.fail).toHaveBeenCalledWith(lease, job(0), "no_product_data");
    expect(empty.store.complete).not.toHaveBeenCalled();
  });

  it("Given 페이지 읽기가 예외를 던짐 When 실행하면 Then 그 작업을 internal로 실패시키고 다음 작업을 이어간다", async () => {
    const { service, store, source } = given({ items: 2 });
    source.read.mockRejectedValueOnce(new Error("socket"));

    expect(await service.run({ secret })).toMatchObject({ kind: "finished", stop: "done" });
    expect(store.fail).toHaveBeenCalledWith(lease, job(0), "internal");
    expect(store.complete).toHaveBeenCalledWith(lease, job(1), expect.anything());
  });

  it.each([
    ["모르는 키", "key_rejected"],
    ["다른 실행이 진행 중", "run_busy"],
    ["24시간 한도", "run_limit"],
    ["저장소 장애", "storage_unavailable"],
  ] as const)("Given %s(%s) When 시작이 거절되면 Then 아무것도 집지 않고 그 코드로 거절한다", async (_name, code) => {
    const { service, store } = given({ items: 3 });
    store.begin.mockRejectedValueOnce(new WorkerError(code, "refused"));

    expect(await service.run({ secret })).toEqual({ kind: "refused", code });
    expect(store.next).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
  });

  it.each(["key_rejected", "run_lost"] as const)("Given 실행 중 %s When 단계가 거절되면 Then 모든 줄을 멈추고 끝내지 않은 채 그 코드로 거절한다", async (code) => {
    const { service, store } = given({ items: 10 });
    store.complete.mockRejectedValueOnce(new WorkerError(code, "gone"));

    expect(await service.run({ secret })).toEqual({ kind: "refused", code });
    expect(store.finish).not.toHaveBeenCalled();
    expect(store.next.mock.calls.length).toBeLessThanOrEqual(RUN_LANES);
  });

  it("Given 쓰기가 계속 실패 When 실행하면 Then 줄마다 두 번 이어 실패한 뒤 멈추고, 작업은 임대에 남긴 채 deadline으로 끝낸다", async () => {
    const { service, store } = given({ items: 100 });
    store.complete.mockRejectedValue(new WorkerError("storage_unavailable", "x"));

    expect(await service.run({ secret })).toEqual({ kind: "finished", stop: "deadline", ...counts });
    expect(store.complete).toHaveBeenCalledTimes(RUN_LANES * 2);
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("Given 한 번 실패한 뒤 성공 When 실행하면 Then 실패 횟수를 새로 세어 그 줄이 남은 일을 이어간다", async () => {
    const { service, store } = given({ items: 9 });
    store.complete.mockRejectedValueOnce(new WorkerError("storage_unavailable", "x"));

    expect(await service.run({ secret })).toMatchObject({ kind: "finished", stop: "done" });
    expect(store.complete).toHaveBeenCalledTimes(9);
  });

  it("Given 시작한 지 20초가 지남 When 줄이 다음 일을 고르려 하면 Then 새로 집지 않고 deadline으로 끝낸다", async () => {
    const { service, store, source, advance } = given({ items: 100 });
    source.read.mockImplementation(async () => {
      advance(RUN_START_WINDOW_MS / 4);
      return { ok: true, page: { html: "<html>", url: "https://shop.example/x", status: 200 } };
    });

    expect(await service.run({ secret })).toMatchObject({ kind: "finished", stop: "deadline" });
    expect(store.finish).toHaveBeenCalledWith(lease, "deadline");
    expect(store.next.mock.calls.length).toBeLessThan(RUN_LANES * 3);
  });

  it("Given 집을 일이 끝없이 있음 When 실행하면 Then 한 번에 60개까지만 시작하고 deadline으로 끝낸다", async () => {
    const { service, store } = given({ items: 1000 });

    expect(await service.run({ secret })).toMatchObject({ kind: "finished", stop: "deadline" });
    expect(store.complete).toHaveBeenCalledTimes(RUN_MAX_ITEMS);
  });

  it("Given 끝내기가 실패 When 실행하면 Then 예외 없이 저장소 장애로 거절한다", async () => {
    const { service, store } = given({ items: 1 });
    store.finish.mockRejectedValueOnce(new Error("timeout"));
    expect(await service.run({ secret })).toEqual({ kind: "refused", code: "storage_unavailable" });
  });
});
