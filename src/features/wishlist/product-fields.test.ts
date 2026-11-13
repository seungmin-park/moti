import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeTitle,
  parsePaidPrice,
  parseProductNote,
  parseProductTitle,
  parsePurchaseDate,
  seoulToday,
} from "./product-fields";

const today = "2026-11-13";

describe("상품 이름", () => {
  it("Given 줄바꿈·제어 문자·겹친 공백이 섞인 이름 When 정리하면 Then 한 칸 공백의 NFC 한 줄 이름이 된다", () => {
    expect(normalizeTitle("  무선\n\t 헤드폰\u0007  블랙 ")).toBe("무선 헤드폰 블랙");
    expect(normalizeTitle("가방".normalize("NFD"))).toBe("가방");
  });

  it("Given 120 코드 포인트의 이름 When 고치면 Then 그대로 받고, 121이면 자르지 않고 거절한다", () => {
    expect(parseProductTitle("😀".repeat(MAX_TITLE_LENGTH))).toEqual({ ok: true, value: "😀".repeat(MAX_TITLE_LENGTH) });
    expect(parseProductTitle("😀".repeat(MAX_TITLE_LENGTH + 1)))
      .toEqual({ ok: false, field: "title", message: "상품 이름은 1~120자로 입력해 주세요." });
  });

  it("Given 앞뒤 공백 When 고치면 Then 정리한 이름을 받는다", () => {
    expect(parseProductTitle("  책상 조명 ")).toEqual({ ok: true, value: "책상 조명" });
  });

  it.each(["", "   ", "\u0000\n"])("Given 비어 있는 이름 %j When 고치면 Then 거절한다", (input) => {
    expect(parseProductTitle(input)).toEqual({ ok: false, field: "title", message: "상품 이름은 1~120자로 입력해 주세요." });
  });

  it.each([null, 1, "가\uD800"])("Given 문자열이 아니거나 깨진 이름 %j When 고치면 Then 거절한다", (input) => {
    expect(parseProductTitle(input)).toEqual({ ok: false, field: "title", message: "상품 이름을 확인해 주세요." });
  });
});

describe("메모", () => {
  it("Given 3000 코드 포인트의 메모 When 적으면 Then 적은 그대로 받고, 3001이면 거절한다", () => {
    expect(parseProductNote("😀".repeat(MAX_NOTE_LENGTH))).toEqual({ ok: true, value: "😀".repeat(MAX_NOTE_LENGTH) });
    expect(parseProductNote("😀".repeat(MAX_NOTE_LENGTH + 1)))
      .toEqual({ ok: false, field: "note", message: "메모는 3,000자까지 적을 수 있어요." });
  });

  it("Given 줄바꿈과 앞뒤 공백 When 적으면 Then 바꾸지 않고, 빈 메모도 받는다", () => {
    expect(parseProductNote(" 선물용\n  사이즈 확인 ")).toEqual({ ok: true, value: " 선물용\n  사이즈 확인 " });
    expect(parseProductNote("")).toEqual({ ok: true, value: "" });
  });

  it.each([null, 3, "가\u0000", "가\uDC00"])("Given 저장할 수 없는 메모 %j When 적으면 Then 거절한다", (input) => {
    expect(parseProductNote(input)).toEqual({ ok: false, field: "note", message: "메모를 확인해 주세요." });
  });
});

describe("구매일", () => {
  it("Given 빈 칸 When 기록하면 Then 구매일 없음이다", () => {
    expect(parsePurchaseDate("", today)).toEqual({ ok: true, value: null });
    expect(parsePurchaseDate(null, today)).toEqual({ ok: true, value: null });
  });

  it("Given 오늘과 1900-01-01 When 기록하면 Then 받는다", () => {
    expect(parsePurchaseDate(today, today)).toEqual({ ok: true, value: today });
    expect(parsePurchaseDate("1900-01-01", today)).toEqual({ ok: true, value: "1900-01-01" });
  });

  it("Given 서울 기준 내일 When 기록하면 Then 오늘까지만 받는다고 거절한다", () => {
    expect(parsePurchaseDate("2026-11-14", today))
      .toEqual({ ok: false, field: "date", message: "구매일은 오늘까지 입력할 수 있어요." });
  });

  it.each(["2026-02-30", "2026-13-01", "0000-01-01", "1899-12-31", "2026/11/01", "2026-1-1", " 2026-11-01", 20261101])(
    "Given 달력에 없거나 형식이 다른 날 %j When 기록하면 Then 거절한다",
    (input) => {
      expect(parsePurchaseDate(input, today)).toEqual({ ok: false, field: "date", message: "올바른 구매일을 입력해 주세요." });
    },
  );
});

describe("실구매가", () => {
  it("Given 빈 칸과 0 When 기록하면 Then 미입력과 0원을 구분한다", () => {
    expect(parsePaidPrice("")).toEqual({ ok: true, value: null });
    expect(parsePaidPrice("  ")).toEqual({ ok: true, value: null });
    expect(parsePaidPrice("0")).toEqual({ ok: true, value: { amountMinor: 0, currency: "KRW" } });
  });

  it("Given 원 단위 정수 When 기록하면 Then 원화 최소 단위로 받는다", () => {
    expect(parsePaidPrice(" 289000 ")).toEqual({ ok: true, value: { amountMinor: 289000, currency: "KRW" } });
    expect(parsePaidPrice(String(Number.MAX_SAFE_INTEGER)))
      .toEqual({ ok: true, value: { amountMinor: Number.MAX_SAFE_INTEGER, currency: "KRW" } });
  });

  it.each(["-1", "1.5", "1,000", "1e3", "２", "9007199254740992", null])("Given 정수가 아닌 값 %j When 기록하면 Then 거절한다", (input) => {
    expect(parsePaidPrice(input)).toEqual({ ok: false, field: "price", message: "실구매가는 0 이상의 정수로 입력해 주세요." });
  });
});

describe("서울 날짜", () => {
  it("Given UTC 시각 When 서울 날짜를 구하면 Then 15시를 넘으면 다음 날이다", () => {
    expect(seoulToday(new Date("2026-11-13T14:59:59.999Z"))).toBe("2026-11-13");
    expect(seoulToday(new Date("2026-11-13T15:00:00.000Z"))).toBe("2026-11-14");
  });
});
