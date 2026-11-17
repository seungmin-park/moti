import { describe, expect, it, vi } from "vitest";
import type { Normalized, PictureObject, PictureStore } from "../../metadata/application/picture-copy";
import { LibraryError, type Product, type ProductId } from "../domain/library";
import { toPicturePasteCommand } from "./commands";
import { createPicturePasteService, type PictureApplied, type PicturePasteStore } from "./picture-paste";

const productId = "22222222-2222-4222-8222-222222222222" as ProductId;
const reserved = `owner/${productId}/paste-1.webp` as PictureObject;
const previous = `owner/${productId}/older-1.webp` as PictureObject;
const product = {
  id: productId,
  sourceUrl: "https://example.com/item",
  identityUrl: "https://example.com/item",
  option: "",
  shop: "example.com",
  title: "막힌 쇼핑몰 상품",
  note: "",
  revision: 2,
  collectionIds: [],
  addedAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  purchase: { status: "wish" },
  metadata: { phase: "failed", generation: 1, attempts: 1, errorCode: "blocked_by_site" },
  lastSuccessfulPrice: null,
  priceCheck: null,
  wishPrice: null,
  picture: { version: "33333333-3333-4333-8333-333333333333", pasted: true },
} satisfies Product;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const picture = { bytes: new Uint8Array([1, 2, 3]), width: 600, height: 450 };

function given({ normalized = { ok: true, picture } as Normalized, applied = { kind: "applied", product, replaced: previous } as PictureApplied } = {}) {
  const store: PicturePasteStore = {
    reserve: vi.fn(async () => reserved),
    apply: vi.fn(async () => applied),
    clear: vi.fn(async () => ({ product: { ...product, picture: null }, replaced: reserved })),
  };
  const normalize = vi.fn(async () => normalized);
  const pictures: PictureStore = { put: vi.fn(async () => true), discard: vi.fn(async () => {}) };
  return { store, normalize, pictures, service: createPicturePasteService({ store, normalize, pictures }) };
}

describe("사진 붙여넣기", () => {
  it("Given 붙여 넣은 PNG When 저장하면 Then 판별한 형식으로 다시 만들고 예약한 이름에 올린 뒤 상품에 걸고 대신한 사본을 버린다", async () => {
    const { store, normalize, pictures, service } = given();

    const result = await service.paste({ productId, bytes: png });

    expect(result).toEqual({ kind: "pasted", product });
    expect(normalize).toHaveBeenCalledExactlyOnceWith(png, "png");
    expect(store.reserve).toHaveBeenCalledExactlyOnceWith(productId);
    expect(pictures.put).toHaveBeenCalledExactlyOnceWith(reserved, picture);
    expect(store.apply).toHaveBeenCalledExactlyOnceWith(productId, reserved);
    expect(pictures.discard).toHaveBeenCalledExactlyOnceWith([previous]);
  });

  it("Given 처음 붙여 넣는 상품 When 저장하면 Then 버릴 사본이 없다", async () => {
    const { pictures, service } = given({ applied: { kind: "applied", product, replaced: null } });

    expect(await service.paste({ productId, bytes: png })).toEqual({ kind: "pasted", product });
    expect(pictures.discard).not.toHaveBeenCalled();
  });

  it.each([
    ["HTML", new TextEncoder().encode("<!doctype html><svg></svg>")],
    ["HEIC", new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63])],
    ["빈 본문", new Uint8Array()],
  ])("Given %s When 저장하면 Then 형식을 거절하고 예약도 업로드도 하지 않는다", async (_name, bytes) => {
    const { store, normalize, pictures, service } = given();

    expect(await service.paste({ productId, bytes })).toEqual({ kind: "refused", problem: "unsupported_format" });
    expect(normalize).not.toHaveBeenCalled();
    expect(store.reserve).not.toHaveBeenCalled();
    expect(pictures.put).not.toHaveBeenCalled();
  });

  it.each([
    ["unreadable_image", "unreadable"],
    ["too_large", "too_large"],
    ["timeout", "timeout"],
  ] as const)("Given 정규화가 %s When 저장하면 Then %s로 거절하고 예약하지 않는다", async (code, problem) => {
    const { store, pictures, service } = given({ normalized: { ok: false, code } });

    expect(await service.paste({ productId, bytes: png })).toEqual({ kind: "refused", problem });
    expect(store.reserve).not.toHaveBeenCalled();
    expect(pictures.put).not.toHaveBeenCalled();
  });

  it("Given 업로드 실패 When 저장하면 Then 저장소 오류를 던지고 상품을 바꾸지 않는다", async () => {
    const { store, pictures, service } = given();
    vi.mocked(pictures.put).mockResolvedValueOnce(false);

    await expect(service.paste({ productId, bytes: png })).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(store.apply).not.toHaveBeenCalled();
  });

  it("Given 예약이 그새 바뀜 When 저장하면 Then 올린 사본을 버리고 저장소 오류를 던진다", async () => {
    const { pictures, service } = given({ applied: { kind: "stale" } });

    await expect(service.paste({ productId, bytes: png })).rejects.toMatchObject({
      code: "storage_unavailable",
      message: "사진을 저장하는 데 너무 오래 걸렸어요. 다시 붙여 넣어 주세요.",
      field: "picture",
    });
    expect(pictures.discard).toHaveBeenCalledExactlyOnceWith([reserved]);
  });

  it("Given 상품에 걸기가 예외를 던짐 When 저장하면 Then 다시 던지고 늦게 커밋될 수 있는 사본을 버리지 않는다", async () => {
    const { store, pictures, service } = given();
    vi.mocked(store.apply).mockRejectedValueOnce(new LibraryError("product_missing", "없음"));

    await expect(service.paste({ productId, bytes: png })).rejects.toMatchObject({ code: "product_missing" });
    expect(pictures.discard).not.toHaveBeenCalled();
  });

  it("Given 붙여 넣은 사진 When 지우면 Then 상품을 돌려주고 지운 사본을 버린다", async () => {
    const { store, pictures, service } = given();

    expect(await service.clear({ productId })).toEqual({ ...product, picture: null });
    expect(store.clear).toHaveBeenCalledExactlyOnceWith(productId);
    expect(pictures.discard).toHaveBeenCalledExactlyOnceWith([reserved]);
  });

  it("Given 붙여 넣은 사진이 없음 When 지우면 Then 버리지 않는다", async () => {
    const { store, pictures, service } = given();
    vi.mocked(store.clear).mockResolvedValueOnce({ product, replaced: null });

    expect(await service.clear({ productId })).toEqual(product);
    expect(pictures.discard).not.toHaveBeenCalled();
  });

  it("명령은 상품 UUID를 소문자로 바꾸고 UUID가 아니면 거절한다", () => {
    expect(toPicturePasteCommand(productId.toUpperCase(), png)).toEqual({ productId, bytes: png });
    expect(() => toPicturePasteCommand("not-a-uuid", png)).toThrow(LibraryError);
  });
});
