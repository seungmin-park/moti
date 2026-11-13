import { describe, expect, it } from "vitest";
import type { BackupProduct, LibraryBackup } from "../domain/library";
import {
  LIBRARY_BACKUP_FORMAT,
  MAX_BACKUP_COLLECTIONS,
  MAX_BACKUP_PRODUCTS,
  backupFileName,
  readLibraryBackup,
  toLibraryBackupDocument,
  type LibraryBackupDocument,
} from "./library-backup";

const exportedAt = new Date("2026-11-13T05:12:00.000Z");

function product(overrides: Partial<BackupProduct> = {}): BackupProduct {
  return {
    sourceUrl: "https://shop.example/p/1?utm_source=x",
    identityUrl: "https://shop.example/p/1",
    option: "블랙 / M",
    shop: "shop.example",
    collectedTitle: "오크 사이드 테이블",
    ownerTitle: null,
    note: "",
    collectionNames: [],
    addedAt: "2026-10-05T01:00:00.456Z",
    purchase: { status: "wish" },
    lastSuccessfulPrice: null,
    ...overrides,
  };
}

const backup: LibraryBackup = {
  collections: [
    { name: "거실", createdAt: "2026-10-02T03:00:00.123Z" },
    { name: "Desk", createdAt: "2026-10-03T03:00:00.000Z" },
  ],
  products: [
    product({
      ownerTitle: "내 테이블",
      note: "  선물용\n사이즈 확인  ",
      collectionNames: ["거실", "Desk"],
      purchase: { status: "purchased", date: null, price: { amountMinor: 0, currency: "KRW" } },
      lastSuccessfulPrice: { amountMinor: 129000, currency: "KRW", checkedAt: "2026-11-01T00:00:00.000Z" },
    }),
    product({
      sourceUrl: "https://www.shop.example/p/2",
      identityUrl: "https://www.shop.example/p/2",
      option: "",
      purchase: { status: "purchased", date: "2026-11-01", price: null },
    }),
    product({ sourceUrl: "https://shop.example/p/3", identityUrl: "https://shop.example/p/3", option: "" }),
  ],
};

const document = (): LibraryBackupDocument => JSON.parse(JSON.stringify(toLibraryBackupDocument(backup, exportedAt)));
const removed = Symbol("removed");
// A typed change for files the types allow, or values by path ("products.1.note") for files they do not.
type Edit = ((file: LibraryBackupDocument) => void) | Record<string, unknown>;

function tampered(edit: Edit): unknown {
  const file = document();
  if (typeof edit === "function") {
    edit(file);
    return file;
  }
  for (const [path, value] of Object.entries(edit)) {
    const keys = path.split(".");
    const parent = keys.slice(0, -1).reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, file);
    if (value === removed) delete parent[keys.at(-1)!];
    else parent[keys.at(-1)!] = value;
  }
  return file;
}

describe("백업 파일 만들기", () => {
  it("보이는 값과 소유자가 정한 값을 id·revision·수집 상태 없이 담는다", () => {
    expect(toLibraryBackupDocument(backup, exportedAt)).toEqual({
      format: "moti.library-backup",
      version: 1,
      exportedAt: "2026-11-13T05:12:00.000Z",
      collections: [
        { name: "거실", createdAt: "2026-10-02T03:00:00.123Z" },
        { name: "Desk", createdAt: "2026-10-03T03:00:00.000Z" },
      ],
      products: [
        {
          sourceUrl: "https://shop.example/p/1?utm_source=x",
          option: "블랙 / M",
          collectedTitle: "오크 사이드 테이블",
          ownerTitle: "내 테이블",
          note: "  선물용\n사이즈 확인  ",
          collections: ["거실", "Desk"],
          addedAt: "2026-10-05T01:00:00.456Z",
          purchase: { status: "purchased", date: null, price: { amountMinor: 0, currency: "KRW" } },
          lastSuccessfulPrice: { amountMinor: 129000, currency: "KRW", checkedAt: "2026-11-01T00:00:00.000Z" },
        },
        {
          sourceUrl: "https://www.shop.example/p/2",
          option: "",
          collectedTitle: "오크 사이드 테이블",
          ownerTitle: null,
          note: "",
          collections: [],
          addedAt: "2026-10-05T01:00:00.456Z",
          purchase: { status: "purchased", date: "2026-11-01", price: null },
          lastSuccessfulPrice: null,
        },
        {
          sourceUrl: "https://shop.example/p/3",
          option: "",
          collectedTitle: "오크 사이드 테이블",
          ownerTitle: null,
          note: "",
          collections: [],
          addedAt: "2026-10-05T01:00:00.456Z",
          purchase: { status: "wish" },
          lastSuccessfulPrice: null,
        },
      ],
    });
  });

  it("파일 이름은 서울 시각의 날짜와 분이다", () => {
    expect(backupFileName(exportedAt)).toBe("moti-backup-20261113-1412.json");
    expect(backupFileName(new Date("2026-12-31T15:05:00.000Z"))).toBe("moti-backup-20270101-0005.json");
  });
});

describe("백업 파일 읽기", () => {
  it("자기가 만든 파일을 글자로 바꿨다가 읽으면 같은 내용과 개수를 돌려준다", () => {
    const text = JSON.stringify(toLibraryBackupDocument(backup, exportedAt));

    expect(readLibraryBackup(JSON.parse(text))).toEqual({
      ok: true,
      document: toLibraryBackupDocument(backup, exportedAt),
      counts: { products: 3, collections: 2 },
    });
  });

  it("빈 보관함의 파일도 읽는다", () => {
    const empty = toLibraryBackupDocument({ collections: [], products: [] }, exportedAt);
    expect(readLibraryBackup(JSON.parse(JSON.stringify(empty)))).toMatchObject({ ok: true, counts: { products: 0, collections: 0 } });
  });

  it("상품·컬렉션 한도까지는 읽는다", () => {
    const file = tampered((value) => {
      value.collections = Array.from({ length: MAX_BACKUP_COLLECTIONS }, (_, index) => ({ name: `c${index}`, createdAt: "2026-10-02T03:00:00.123Z" }));
      value.products = Array.from({ length: MAX_BACKUP_PRODUCTS }, (_, index) => ({
        ...value.products[2],
        sourceUrl: `https://shop.example/p/${index}`,
        collections: index === 0 ? Array.from({ length: 100 }, (__, n) => `c${n}`) : [],
      }));
    });
    expect(readLibraryBackup(file)).toMatchObject({ ok: true, counts: { products: MAX_BACKUP_PRODUCTS, collections: MAX_BACKUP_COLLECTIONS } });
  });

  it.each([
    ["JSON 객체가 아님", [] as unknown],
    ["null", null],
    ["글자", "moti"],
    ["다른 형식", { format: "other", version: 1 }],
    ["형식 없음", { version: 1, products: [], collections: [] }],
  ])("%s이면 moti 백업이 아니다", (_, value) => {
    expect(readLibraryBackup(value)).toEqual({ ok: false, problem: "not_backup", path: null });
  });

  it("더 새로운 버전은 따로 알린다", () => {
    expect(readLibraryBackup({ format: LIBRARY_BACKUP_FORMAT, version: 2 })).toEqual({ ok: false, problem: "newer_version", path: "version" });
  });

  it.each<[string, Edit, string]>([
    ["알 수 없는 버전", { version: 0 }, "version"],
    ["문자열 버전", { version: "1" }, "version"],
    ["맨 위의 모르는 칸", { signature: "x" }, "signature"],
    ["상품의 모르는 칸", { "products.1.id": "x" }, "products.1.id"],
    ["컬렉션의 모르는 칸", { "collections.0.revision": 1 }, "collections.0.revision"],
    ["구매의 모르는 칸", { "products.0.purchase.note": "x" }, "products.0.purchase.note"],
    ["빠진 칸", { "products.1.note": removed }, "products.1.note"],
    ["잘못된 형식", { "products.1.note": 1 }, "products.1.note"],
    ["내보낸 시각 형식", { exportedAt: "2026-11-13" }, "exportedAt"],
    ["밀리초 없는 담은 시각", { "products.1.addedAt": "2026-10-05T01:00:00Z" }, "products.1.addedAt"],
    ["앞에 공백이 있는 링크", { "products.1.sourceUrl": " https://www.shop.example/p/2" }, "products.1.sourceUrl"],
    ["웹 주소가 아닌 링크", { "products.1.sourceUrl": "javascript:alert(1)" }, "products.1.sourceUrl"],
    ["정리되지 않은 옵션", { "products.1.option": " M" }, "products.1.option"],
    ["NFC가 아닌 이름", { "products.1.collectedTitle": "가".normalize("NFD") }, "products.1.collectedTitle"],
    ["앞뒤 공백이 있는 소유자 이름", { "products.1.ownerTitle": " 이름" }, "products.1.ownerTitle"],
    ["빈 소유자 이름", { "products.1.ownerTitle": "" }, "products.1.ownerTitle"],
    ["121자 이름", { "products.1.collectedTitle": "가".repeat(121) }, "products.1.collectedTitle"],
    ["3,001자 메모", { "products.1.note": "가".repeat(3001) }, "products.1.note"],
    ["NUL이 있는 메모", { "products.1.note": "a\u0000b" }, "products.1.note"],
    ["앞뒤 공백이 있는 컬렉션 이름", { "collections.1.name": "Desk " }, "collections.1.name"],
    ["41자 컬렉션 이름", { "collections.1.name": "가".repeat(41) }, "collections.1.name"],
    ["같은 컬렉션 이름 두 번", (file) => { file.collections[1].name = "거실"; file.products[0].collections = ["거실"]; }, "collections.1.name"],
    ["대소문자만 다른 컬렉션 이름", (file) => { file.collections.push({ name: "DESK", createdAt: "2026-10-03T03:00:00.000Z" }); }, "collections.2.name"],
    ["없는 컬렉션 소속", (file) => { file.products[1].collections = ["부엌"]; }, "products.1.collections.0"],
    ["대소문자가 다른 소속 이름", (file) => { file.products[1].collections = ["desk"]; }, "products.1.collections.0"],
    ["같은 소속 두 번", (file) => { file.products[0].collections = ["거실", "거실"]; }, "products.0.collections.1"],
    ["101개 소속", (file) => { file.products[1].collections = Array.from({ length: 101 }, () => "거실"); }, "products.1.collections"],
    ["추적 값만 다른 같은 링크", (file) => { file.products[2].sourceUrl = "https://shop.example/p/1?utm_medium=y"; file.products[2].option = "블랙 / M"; }, "products.2.sourceUrl"],
    ["위시 상품의 구매 기록", { "products.2.purchase.date": null }, "products.2.purchase.date"],
    ["모르는 구매 상태", { "products.2.purchase.status": "returned" }, "products.2.purchase.status"],
    ["원화가 아닌 실구매가", { "products.0.purchase.price.currency": "USD" }, "products.0.purchase.price.currency"],
    ["음수 실구매가", { "products.0.purchase.price.amountMinor": -1 }, "products.0.purchase.price.amountMinor"],
    ["2^53 실구매가", { "products.0.purchase.price.amountMinor": 2 ** 53 }, "products.0.purchase.price.amountMinor"],
    ["소수 실구매가", { "products.0.purchase.price.amountMinor": 1.5 }, "products.0.purchase.price.amountMinor"],
    ["없는 날짜", { "products.1.purchase.date": "2026-02-30" }, "products.1.purchase.date"],
    ["1900년 전 구매일", { "products.1.purchase.date": "1899-12-31" }, "products.1.purchase.date"],
    ["0원인 마지막 확인 가격", { "products.0.lastSuccessfulPrice.amountMinor": 0 }, "products.0.lastSuccessfulPrice.amountMinor"],
    ["통화 형식이 아닌 마지막 확인 가격", { "products.0.lastSuccessfulPrice.currency": "won" }, "products.0.lastSuccessfulPrice.currency"],
    ["확인 시각 없는 마지막 확인 가격", { "products.0.lastSuccessfulPrice.checkedAt": removed }, "products.0.lastSuccessfulPrice.checkedAt"],
    ["5,001개 상품", (file) => {
      file.products = Array.from({ length: MAX_BACKUP_PRODUCTS + 1 }, (_, index) => ({ ...file.products[2], sourceUrl: `https://shop.example/p/${index}` }));
    }, "products"],
    ["501개 컬렉션", (file) => {
      file.collections = Array.from({ length: MAX_BACKUP_COLLECTIONS + 1 }, (_, index) => ({ name: `c${index}`, createdAt: "2026-10-02T03:00:00.123Z" }));
      file.products[0].collections = [];
    }, "collections"],
  ])("%s이면 손상된 파일로 보고 처음 문제의 위치를 알린다", (_, change, path) => {
    expect(readLibraryBackup(tampered(change))).toEqual({ ok: false, problem: "invalid", path });
  });
});
