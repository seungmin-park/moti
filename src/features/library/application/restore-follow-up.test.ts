import { describe, expect, it, vi } from "vitest";
import type { CollectionRequest } from "../../metadata/application/collection";
import type { PictureObject, PictureStore } from "../../metadata/application/picture-copy";
import type { MetadataState, Product, ProductId } from "../domain/library";
import type { LibraryRestoreResult } from "./commands";
import { followUpRestore } from "./restore-follow-up";

function product(id: string, metadata: MetadataState): Product {
  return { id: id as ProductId, metadata } as Product;
}

const queued: MetadataState = { phase: "queued", generation: 1, attempts: 0, stalled: false };
const result = (products: Product[], replacedPictures: string[] = []): LibraryRestoreResult => ({
  library: { products, collections: [] },
  replacedPictures: replacedPictures as PictureObject[],
});

function given(start = 0) {
  let time = start;
  const order: string[] = [];
  const pictures: PictureStore = {
    put: vi.fn(async () => true),
    discard: vi.fn(async (objects: readonly PictureObject[]) => { order.push(`discard:${objects.length}`); }),
  };
  const collect = vi.fn(async (request: CollectionRequest) => { order.push(`collect:${request.productId}`); });
  return { pictures, collect, order, now: () => time, advance: (ms: number) => { time += ms; } };
}

describe("복원 뒤 정리", () => {
  it("Given 지운 상품의 사본과 수집을 기다리는 상품 When 정리하면 Then 사본을 먼저 버리고 기다리는 상품만 최근 것부터 수집한다", async () => {
    const { pictures, collect, order, now } = given();

    await followUpRestore(result([
      product("new-2", queued),
      product("ready", { phase: "ready", generation: 1, attempts: 1, completedAt: "2026-11-01T00:00:00.000Z", image: { outcome: "absent" } }),
      product("new-1", { ...queued, generation: 3 }),
      product("failed", { phase: "failed", generation: 1, attempts: 1, errorCode: "timeout" }),
      product("running", { phase: "running", generation: 1, attempts: 1, stalled: false }),
    ], ["a/b/c-1.webp", "a/d/e-1.webp"]), { pictures, collect, now });

    expect(order).toEqual(["discard:2", "collect:new-2", "collect:new-1"]);
    expect(collect.mock.calls.map(([request]) => request)).toEqual([
      { productId: "new-2", generation: 1 },
      { productId: "new-1", generation: 3 },
    ]);
  });

  it("Given 사본 2,500개 When 정리하면 Then 1,000개씩 나눠 버린다", async () => {
    const { pictures, collect, now } = given();
    const names = Array.from({ length: 2500 }, (_, index) => `a/b/${index}-1.webp`);

    await followUpRestore(result([], names), { pictures, collect, now });

    expect(vi.mocked(pictures.discard).mock.calls.map(([objects]) => objects.length)).toEqual([1000, 1000, 500]);
    expect(vi.mocked(pictures.discard).mock.calls.flatMap(([objects]) => objects)).toEqual(names);
  });

  it("Given 버릴 사본이 없음 When 정리하면 Then Storage를 부르지 않는다", async () => {
    const { pictures, collect, now } = given();
    await followUpRestore(result([product("new", queued)]), { pictures, collect, now });
    expect(pictures.discard).not.toHaveBeenCalled();
    expect(collect).toHaveBeenCalledOnce();
  });

  it("Given 사본 버리기가 실패 When 정리하면 Then 예외 없이 수집을 이어서 한다", async () => {
    const { pictures, collect, now } = given();
    vi.mocked(pictures.discard).mockRejectedValueOnce(new Error("storage down"));

    await expect(followUpRestore(result([product("new", queued)], ["a/b/c-1.webp"]), { pictures, collect, now })).resolves.toBeUndefined();
    expect(collect).toHaveBeenCalledOnce();
  });

  it("Given 40초가 지남 When 다음 상품을 고르면 Then 새 수집을 시작하지 않는다", async () => {
    const { pictures, now, advance } = given(1_000);
    const started: string[] = [];
    const collect = vi.fn(async (request: CollectionRequest) => {
      started.push(request.productId);
      advance(15_000);
    });

    await followUpRestore(result(["p1", "p2", "p3", "p4", "p5", "p6", "p7"].map((id) => product(id, queued))), { pictures, collect, now });

    expect(started).toEqual(["p1", "p2", "p3"]);
  });
});
