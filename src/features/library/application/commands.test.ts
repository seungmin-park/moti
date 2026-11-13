import { describe, expect, it } from "vitest";
import { parseLink } from "../../wishlist/link";
import {
  toCollectionCreateCommand,
  toCollectionRenameCommand,
  toLibraryRestoreCommand,
  toLinkSaveCommand,
  toProductChangeCommand,
  type LibraryRestoreInput,
  type ProductChangeInput,
} from "./commands";

const collectionId = "ca47b10d-e052-4910-bdba-75ae5eb99620";
const validLink = {
  url: "https://example.com/item?size=M&utm_source=one#blue",
  option: " 가 ",
  collectionIds: [collectionId],
};

describe("저장 명령", () => {
  it("원문, 중복 판별 URL, NFC 옵션과 컬렉션을 한 명령에 담는다", () => {
    expect(toLinkSaveCommand(validLink)).toEqual({
      sourceUrl: "https://example.com/item?size=M&utm_source=one#blue",
      identityUrl: "https://example.com/item?size=M#blue",
      shop: "example.com",
      option: "가",
      collectionIds: [collectionId],
    });
  });

  it("같은 UUID의 대소문자와 반복 선택을 하나의 컬렉션으로 취급한다", () => {
    expect(toLinkSaveCommand({
      ...validLink,
      collectionIds: [collectionId.toUpperCase(), collectionId],
    }).collectionIds).toEqual([collectionId]);
  });

  it.each([null, [], "link", 1].map((input) => [input]))("객체가 아닌 입력 %s는 거절한다", (input) => {
    expect(() => toLinkSaveCommand(input)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it.each([
    { url: null, field: "url" },
    { url: "javascript:alert(1)", field: "url" },
    { option: 1, field: "option" },
    { option: "x".repeat(121), field: "option" },
    { collectionIds: "invalid", field: "collection" },
    { collectionIds: ["not-a-uuid"], field: "collection" },
    { collectionIds: [null], field: "collection" },
    { collectionIds: Array.from({ length: 101 }, () => collectionId), field: "collection" },
  ])("잘못된 $field 입력은 저장 전에 거절한다", ({ field, ...input }) => {
    expect(() => toLinkSaveCommand({ ...validLink, ...input })).toThrowError(
      expect.objectContaining({ code: "invalid_input", field }),
    );
  });

  it("컬렉션 없이 저장하는 명령을 허용한다", () => {
    expect(toLinkSaveCommand({ ...validLink, collectionIds: [] }).collectionIds)
      .toEqual([]);
  });
});

describe("컬렉션 생성 명령", () => {
  it("이름 규칙이 정리한 이름으로 명령을 만든다", () => {
    expect(toCollectionCreateCommand(" 가방 ")).toEqual({ name: "가방" });
  });

  it("이름 규칙이 거절한 입력은 컬렉션 필드의 입력 오류로 바꾼다", () => {
    expect(() => toCollectionCreateCommand(null)).toThrowError(
      expect.objectContaining({ code: "invalid_input", field: "collection", message: "컬렉션 이름을 확인해 주세요." }),
    );
    expect(() => toCollectionCreateCommand("가".repeat(41))).toThrowError(
      expect.objectContaining({ code: "invalid_input", field: "collection", message: "컬렉션 이름은 1~40자로 입력해 주세요." }),
    );
  });
});

describe("상품 정리 명령", () => {
  const productId = "22222222-2222-4222-8222-222222222222";
  const today = "2026-11-13";

  it("이름은 정리하고, 메모는 적은 그대로, 컬렉션은 소문자로 한 번씩만 담는다", () => {
    expect(toProductChangeCommand(productId.toUpperCase(), {
      revision: 3,
      change: { type: "details", title: "  책상\n조명 ", note: " 선물용\n", collectionIds: [collectionId.toUpperCase(), collectionId] },
    }, today)).toEqual({
      productId,
      revision: 3,
      change: { type: "details", title: "책상 조명", note: " 선물용\n", collectionIds: [collectionId] },
    });
  });

  it("이름을 보내지 않으면 지금 이름을 그대로 둔다", () => {
    expect(toProductChangeCommand(productId, { revision: 1, change: { type: "details", title: null, note: "", collectionIds: [] } }, today).change)
      .toEqual({ type: "details", title: null, note: "", collectionIds: [] });
  });

  it("빈 구매일과 0원 실구매가를 서로 다른 값으로 담는다", () => {
    expect(toProductChangeCommand(productId, {
      revision: 2, change: { type: "purchase.record", date: null, price: { amountMinor: 0, currency: "KRW" } },
    }, today).change).toEqual({ type: "purchase.record", date: null, price: { amountMinor: 0, currency: "KRW" } });
    expect(toProductChangeCommand(productId, {
      revision: 2, change: { type: "purchase.record", date: today, price: null },
    }, today).change).toEqual({ type: "purchase.record", date: today, price: null });
  });

  it.each(["purchase", "wish"] as const)("%s 변경은 값 없이 담는다", (type) => {
    expect(toProductChangeCommand(productId, { revision: 1, change: { type } }, today)).toEqual({ productId, revision: 1, change: { type } });
  });

  it.each([
    [{ type: "details", title: " ", note: "", collectionIds: [] }, "title"],
    [{ type: "details", title: "가".repeat(121), note: "", collectionIds: [] }, "title"],
    [{ type: "details", title: null, note: "가".repeat(3001), collectionIds: [] }, "note"],
    [{ type: "details", title: null, note: "", collectionIds: ["desk"] }, "collection"],
    [{ type: "details", title: null, note: "", collectionIds: Array(101).fill(collectionId) }, "collection"],
    [{ type: "purchase.record", date: "2026-11-14", price: null }, "date"],
    [{ type: "purchase.record", date: "2026-02-30", price: null }, "date"],
    [{ type: "purchase.record", date: null, price: { amountMinor: -1, currency: "KRW" } }, "price"],
    [{ type: "purchase.record", date: null, price: { amountMinor: 0.5, currency: "KRW" } }, "price"],
    [{ type: "purchase.record", date: null, price: { amountMinor: 2 ** 53, currency: "KRW" } }, "price"],
    [{ type: "purchase.record", date: null, price: { amountMinor: 1000, currency: "USD" } }, "price"],
  ] satisfies [ProductChangeInput["change"], string][])("규칙에 맞지 않는 %j은 %s 칸의 입력 오류다", (change, field) => {
    expect(() => toProductChangeCommand(productId, { revision: 1, change }, today))
      .toThrowError(expect.objectContaining({ code: "invalid_input", field }));
  });

  it.each([0, 1.5, 2147483648, Number.NaN])("화면이 본 revision %s가 범위를 벗어나면 필드 없는 입력 오류다", (revision) => {
    expect(() => toProductChangeCommand(productId, { revision, change: { type: "purchase" } }, today))
      .toThrowError(expect.objectContaining({ code: "invalid_input", field: undefined }));
  });

  it("UUID가 아닌 상품은 필드 없는 입력 오류다", () => {
    expect(() => toProductChangeCommand("lamp", { revision: 1, change: { type: "purchase" } }, today))
      .toThrowError(expect.objectContaining({ code: "invalid_input", field: undefined }));
  });
});

describe("컬렉션 이름 바꾸기 명령", () => {
  it("이름 규칙으로 정리하고 컬렉션 ID를 소문자로 담는다", () => {
    expect(toCollectionRenameCommand(collectionId.toUpperCase(), { revision: 2, name: " 작업 공간 " }))
      .toEqual({ collectionId, revision: 2, name: "작업 공간" });
  });

  it.each([
    [collectionId, { revision: 1, name: " " }, "collection"],
    [collectionId, { revision: 1, name: "가".repeat(41) }, "collection"],
    [collectionId, { revision: 1, name: null }, "collection"],
    ["desk", { revision: 1, name: "책상" }, "collection"],
    [collectionId, { revision: 0, name: "책상" }, undefined],
  ])("%s의 잘못된 입력 %j은 입력 오류다", (id, input, field) => {
    expect(() => toCollectionRenameCommand(id, input)).toThrowError(expect.objectContaining({ code: "invalid_input", field }));
  });
});

describe("복원 명령", () => {
  const file: LibraryRestoreInput = {
    collections: [{ name: "거실", createdAt: "2026-10-02T03:00:00.123Z" }],
    products: [
      {
        sourceUrl: "https://www.shop.example/p/1?utm_source=x&b=2&a=1",
        option: "블랙 / M",
        collectedTitle: "오크 사이드 테이블",
        ownerTitle: "내 테이블",
        note: "  선물용\n",
        collections: ["거실"],
        addedAt: "2026-10-05T01:00:00.456Z",
        purchase: { status: "purchased", date: "2026-11-13", price: { amountMinor: 0, currency: "KRW" } },
        lastSuccessfulPrice: { amountMinor: 129000, currency: "KRW", checkedAt: "2026-11-01T00:00:00.000Z" },
      },
      {
        sourceUrl: "https://shop.example/p/2",
        option: "",
        collectedTitle: "새로 담은 상품",
        ownerTitle: null,
        note: "",
        collections: [],
        addedAt: "2026-10-04T01:00:00.000Z",
        purchase: { status: "wish" },
        lastSuccessfulPrice: null,
      },
    ],
  };

  it("링크에서 저장할 때와 같은 판별 주소와 쇼핑몰을 얻고 나머지 값은 파일 그대로 담는다", () => {
    const command = toLibraryRestoreCommand(file, "2026-11-13");

    expect(command).toEqual({
      backup: {
        collections: [{ name: "거실", createdAt: "2026-10-02T03:00:00.123Z" }],
        products: [
          {
            sourceUrl: "https://www.shop.example/p/1?utm_source=x&b=2&a=1",
            identityUrl: "https://www.shop.example/p/1?a=1&b=2",
            option: "블랙 / M",
            shop: "shop.example",
            collectedTitle: "오크 사이드 테이블",
            ownerTitle: "내 테이블",
            note: "  선물용\n",
            collectionNames: ["거실"],
            addedAt: "2026-10-05T01:00:00.456Z",
            purchase: { status: "purchased", date: "2026-11-13", price: { amountMinor: 0, currency: "KRW" } },
            lastSuccessfulPrice: { amountMinor: 129000, currency: "KRW", checkedAt: "2026-11-01T00:00:00.000Z" },
          },
          {
            sourceUrl: "https://shop.example/p/2",
            identityUrl: "https://shop.example/p/2",
            option: "",
            shop: "shop.example",
            collectedTitle: "새로 담은 상품",
            ownerTitle: null,
            note: "",
            collectionNames: [],
            addedAt: "2026-10-04T01:00:00.000Z",
            purchase: { status: "wish" },
            lastSuccessfulPrice: null,
          },
        ],
      },
    });
    const parsed = parseLink(file.products[0].sourceUrl, file.products[0].option);
    expect(parsed.ok && parsed.link).toEqual({
      sourceUrl: command.backup.products[0].sourceUrl,
      identityUrl: command.backup.products[0].identityUrl,
      option: command.backup.products[0].option,
      shop: command.backup.products[0].shop,
    });
  });

  it("서버의 서울 날짜보다 뒤의 구매일은 그 상품의 위치와 함께 거절한다", () => {
    expect(() => toLibraryRestoreCommand(file, "2026-11-12")).toThrowError(
      expect.objectContaining({ code: "invalid_input", field: "products.0.purchase.date" }),
    );
  });

  it("읽기를 거치지 않은 잘못된 링크는 거절한다", () => {
    const broken = { ...file, products: [file.products[1], { ...file.products[1], sourceUrl: "javascript:alert(1)" }] };
    expect(() => toLibraryRestoreCommand(broken, "2026-11-13")).toThrowError(
      expect.objectContaining({ code: "invalid_input", field: "products.1.sourceUrl" }),
    );
  });

  it("빈 보관함 파일도 명령이 된다", () => {
    expect(toLibraryRestoreCommand({ collections: [], products: [] }, "2026-11-13")).toEqual({ backup: { collections: [], products: [] } });
  });
});
