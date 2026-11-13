import { describe, expect, it, vi } from "vitest";
import type { Product } from "../../library/domain/library";
import type { JobSettlement } from "./collection";
import {
  createPictureCopier,
  type ImageCopy,
  type ImageSource,
  type NormalizedPicture,
  type PictureNormalizer,
  type PictureObject,
  type PictureStore,
  type PictureTask,
} from "./picture-copy";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const webp: NormalizedPicture = { bytes: Uint8Array.from([1, 2, 3]), width: 10, height: 10 };
const target = "owner/product/job-1.webp" as PictureObject;
const replaced = "owner/product/older-1.webp" as PictureObject;
const product = { id: "p-1" } as Product;
const now = 1_000_000;
const task: PictureTask = { imageUrl: "https://cdn.shop.example/a.png", pageUrl: "https://shop.example/p?ref=mail", target, deadline: now + 30_000 };

function given(overrides: { source?: ImageSource["read"]; normalize?: PictureNormalizer; put?: PictureStore["put"] } = {}) {
  const source = { read: vi.fn<ImageSource["read"]>(overrides.source ?? (async () => ({ ok: true, bytes: png }))) };
  const normalize = vi.fn<PictureNormalizer>(overrides.normalize ?? (async () => ({ ok: true, picture: webp })));
  const pictures = {
    put: vi.fn<PictureStore["put"]>(overrides.put ?? (async () => true)),
    discard: vi.fn<PictureStore["discard"]>(async () => {}),
  };
  const copier = createPictureCopier({ source, normalize, pictures, now: () => now });
  return { source, normalize, pictures, copier };
}

const applied = (replacedPicture: PictureObject | null = null): JobSettlement => ({ kind: "applied", product, replacedPicture });

async function settledWith(copier: ReturnType<typeof given>["copier"], value: Partial<PictureTask> = {}, settlement = applied()) {
  const settle = vi.fn(async (image: ImageCopy) => { void image; return settlement; });
  const result = await copier.settleWith({ ...task, ...value }, settle);
  expect(settle).toHaveBeenCalledOnce();
  return { result, image: settle.mock.calls[0][0] };
}

describe("사진 사본 복사", () => {
  it("Given 읽고 판별하고 정규화한 사진 When 복사하면 Then 예약된 이름에 올리고 사본으로 끝낸다", async () => {
    const { source, normalize, pictures, copier } = given();

    const { result, image } = await settledWith(copier);

    expect(image).toEqual({ outcome: "copied" });
    expect(result).toEqual(applied());
    expect(source.read).toHaveBeenCalledExactlyOnceWith(task.imageUrl, { pageUrl: task.pageUrl, signal: expect.any(AbortSignal) });
    expect(source.read.mock.calls[0][1].signal.aborted).toBe(false);
    expect(normalize).toHaveBeenCalledExactlyOnceWith(png, "png");
    expect(pictures.put).toHaveBeenCalledExactlyOnceWith(target, webp);
    expect(pictures.discard).not.toHaveBeenCalled();
  });

  it("Given 사진 주소가 없는 페이지 When 복사하면 Then 요청하지 않고 사진 없음으로 끝낸다", async () => {
    const { source, pictures, copier } = given();
    expect((await settledWith(copier, { imageUrl: null })).image).toEqual({ outcome: "absent" });
    expect(source.read).not.toHaveBeenCalled();
    expect(pictures.discard).not.toHaveBeenCalled();
  });

  it("Given 남은 시간이 5초보다 적음 When 복사하면 Then 요청하지 않고 시간 초과로 끝낸다", async () => {
    const { source, copier } = given();
    expect((await settledWith(copier, { deadline: now + 4_999 })).image).toEqual({ outcome: "failed", code: "timeout" });
    expect(source.read).not.toHaveBeenCalled();
  });

  it("Given 쇼핑몰이 사진 요청을 막음 When 복사하면 Then 그 원인으로 끝내고 정규화하지 않는다", async () => {
    const { normalize, copier } = given({ source: async () => ({ ok: false, code: "blocked_by_site" }) });
    expect((await settledWith(copier)).image).toEqual({ outcome: "failed", code: "blocked_by_site" });
    expect(normalize).not.toHaveBeenCalled();
  });

  it("Given 사진이라고 밝혔지만 HTML인 바이트 When 복사하면 Then 지원하지 않는 형식이고 디코더에 넘기지 않는다", async () => {
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const { normalize, pictures, copier } = given({ source: async () => ({ ok: true, bytes: html }) });
    expect((await settledWith(copier)).image).toEqual({ outcome: "failed", code: "unsupported_content" });
    expect(normalize).not.toHaveBeenCalled();
    expect(pictures.put).not.toHaveBeenCalled();
  });

  it.each(["unreadable_image", "too_large", "timeout"] as const)("Given 정규화가 %s When 복사하면 Then 그 원인으로 끝내고 올리지 않는다", async (code) => {
    const { pictures, copier } = given({ normalize: async () => ({ ok: false, code }) });
    expect((await settledWith(copier)).image).toEqual({ outcome: "failed", code });
    expect(pictures.put).not.toHaveBeenCalled();
  });

  it("Given 저장소가 올리기를 거절 When 복사하면 Then 올리기 실패로 끝낸다", async () => {
    const { pictures, copier } = given({ put: async () => false });
    expect((await settledWith(copier)).image).toEqual({ outcome: "failed", code: "upload_failed" });
    expect(pictures.discard).not.toHaveBeenCalled();
  });

  it.each([
    ["가져오기", { source: async () => { throw new Error("socket"); } }],
    ["정규화", { normalize: async () => { throw new Error("libvips"); } }],
    ["올리기", { put: async () => { throw new Error("storage"); } }],
  ] as const)("Given %s 단계가 예상하지 못한 오류 When 복사하면 Then 내부 오류로 끝내고 이름과 가격은 저장한다", async (_, overrides) => {
    const { copier } = given(overrides);
    expect((await settledWith(copier)).image).toEqual({ outcome: "failed", code: "internal" });
  });

  it("Given 새 사본이 이전 사본을 대신함 When 끝내면 Then 대신한 이전 사본만 지운다", async () => {
    const { pictures, copier } = given();
    await settledWith(copier, {}, applied(replaced));
    expect(pictures.discard).toHaveBeenCalledExactlyOnceWith([replaced]);
  });

  it("Given 그 사이 세대가 바뀜 When 끝내면 Then 반영되지 않은 자기 사본을 지운다", async () => {
    const { pictures, copier } = given();
    expect((await settledWith(copier, {}, { kind: "stale" })).result).toEqual({ kind: "stale" });
    expect(pictures.discard).toHaveBeenCalledExactlyOnceWith([target]);
  });

  it("Given 사본을 올렸지만 끝내기가 예외 When 끝내면 Then 늦게 반영될 수 있으니 자기 사본을 지우지 않고 그 오류를 그대로 던진다", async () => {
    const { pictures, copier } = given();
    // A complete that timed out here may still commit and point the product at this copy.
    const failure = new Error("complete timed out");
    await expect(copier.settleWith(task, async () => { throw failure; })).rejects.toBe(failure);
    expect(pictures.put).toHaveBeenCalledExactlyOnceWith(target, webp);
    expect(pictures.discard).not.toHaveBeenCalled();
  });

  it("Given 올린 것이 없음 When 끝내기가 실패하거나 세대가 바뀌면 Then 지울 것이 없다", async () => {
    const { pictures, copier } = given({ put: async () => false });
    await expect(copier.settleWith(task, async () => { throw new Error("db down"); })).rejects.toThrow("db down");
    await settledWith(copier, {}, { kind: "stale" });
    expect(pictures.discard).not.toHaveBeenCalled();
  });
});
