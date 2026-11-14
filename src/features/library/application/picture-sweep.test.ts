import { describe, expect, it, vi } from "vitest";
import type { PictureObject, PictureStore } from "../../metadata/application/picture-copy";
import { SWEEP_BATCH, sweepPictures, type PictureOrphanStore } from "./picture-sweep";

const names = (count: number) => Array.from({ length: count }, (_, index) => `owner/product/job-${index}.webp` as PictureObject);

function given(found: PictureObject[] | Error) {
  const orphans: PictureOrphanStore = {
    find: vi.fn(async () => {
      if (found instanceof Error) throw found;
      return found;
    }),
  };
  const pictures: PictureStore = { put: vi.fn(async () => true), discard: vi.fn(async () => {}) };
  return { orphans, pictures };
}

describe("남은 사진 정리", () => {
  it("Given 남은 사본 둘 When 정리하면 Then 한 번에 200개까지 묻고 받은 이름 그대로 버리라고 한다", async () => {
    const found = names(2);
    const { orphans, pictures } = given(found);

    const result = await sweepPictures({ orphans, pictures });

    expect(SWEEP_BATCH).toBe(200);
    expect(orphans.find).toHaveBeenCalledExactlyOnceWith(200);
    expect(pictures.discard).toHaveBeenCalledExactlyOnceWith(found);
    expect(result).toEqual({ kind: "requested", count: 2 });
  });

  it("Given 남은 사본 없음 When 정리하면 Then Storage를 부르지 않는다", async () => {
    const { orphans, pictures } = given([]);

    expect(await sweepPictures({ orphans, pictures })).toEqual({ kind: "requested", count: 0 });
    expect(pictures.discard).not.toHaveBeenCalled();
  });

  it("Given 한도만큼 남은 사본 When 정리하면 Then 다시 묻지 않고 나머지는 다음에 열 때 정리한다", async () => {
    const found = names(SWEEP_BATCH);
    const { orphans, pictures } = given(found);

    expect(await sweepPictures({ orphans, pictures })).toEqual({ kind: "requested", count: 200 });
    expect(orphans.find).toHaveBeenCalledTimes(1);
    expect(pictures.discard).toHaveBeenCalledExactlyOnceWith(found);
  });

  it("Given 남은 사본을 찾지 못함 When 정리하면 Then 예외 없이 실패라고 답하고 아무것도 버리지 않는다", async () => {
    const { orphans, pictures } = given(new Error("owner/product/job-1.webp"));

    const result = await sweepPictures({ orphans, pictures });

    expect(result).toEqual({ kind: "failed", step: "find" });
    expect(JSON.stringify(result)).not.toContain(".webp");
    expect(pictures.discard).not.toHaveBeenCalled();
  });

  it("Given 버리기가 예외를 던짐 When 정리하면 Then 예외 없이 실패라고 답한다", async () => {
    const { orphans, pictures } = given(names(1));
    vi.mocked(pictures.discard).mockRejectedValueOnce(new Error("owner/product/job-0.webp"));

    const result = await sweepPictures({ orphans, pictures });

    expect(result).toEqual({ kind: "failed", step: "discard" });
    expect(JSON.stringify(result)).not.toContain(".webp");
  });
});
