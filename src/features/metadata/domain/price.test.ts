import { describe, expect, it } from "vitest";
import { pickSinglePrice, toMinorUnits } from "./price";

describe("가격의 최소 단위 변환", () => {
  it.each([
    ["289000", "KRW", 289000],
    ["289,000", "KRW", 289000],
    ["1,234,567", "KRW", 1234567],
    ["289000.00", "KRW", 289000],
    ["19.99", "USD", 1999],
    ["19.9", "USD", 1990],
    ["20", "USD", 2000],
    ["1500", "JPY", 1500],
    ["12.345", "BHD", 12345],
    [" 39000 ", "krw", 39000],
  ])("Given %s %s When 바꾸면 Then 최소 단위 %d다", (amount, currency, minor) => {
    expect(toMinorUnits(amount, currency)).toEqual({ amountMinor: minor, currency: currency.trim().toUpperCase() });
  });

  it.each<[string, string | null, string]>([
    ["19.999", "USD", "통화보다 긴 0이 아닌 소수"],
    ["289000.5", "KRW", "원화의 0이 아닌 소수"],
    ["0", "KRW", "0원"],
    ["0.00", "USD", "0달러"],
    ["-100", "KRW", "음수"],
    ["1.2.3", "KRW", "잘못된 숫자"],
    ["1,23", "KRW", "잘못된 자릿수 구분"],
    ["12,345.67", "USD", "구분 기호와 소수를 함께 쓴 숫자"],
    ["1e5", "KRW", "지수 표기"],
    ["가격문의", "KRW", "숫자가 아닌 문구"],
    ["", "KRW", "빈 값"],
    ["9007199254740992", "KRW", "안전한 정수보다 큰 값"],
    ["1000", "XYZ", "알 수 없는 통화"],
    ["1000", "", "빈 통화"],
    ["1000", null, "통화 없음"],
  ])("Given %s %s (%s) When 바꾸면 Then 가격을 만들지 않는다", (amount, currency) => {
    expect(toMinorUnits(amount, currency)).toBeNull();
  });
});

describe("하나의 가격 고르기", () => {
  it("Given 같은 가격을 두 곳에서 말함 When 고르면 Then 하나의 가격이다", () => {
    expect(pickSinglePrice([{ amount: "289000", currency: "KRW" }, { amount: "289,000", currency: "KRW" }]))
      .toEqual({ kind: "single", price: { amountMinor: 289000, currency: "KRW" } });
  });

  it("Given 서로 다른 두 가격 When 고르면 Then 정하지 않는다", () => {
    expect(pickSinglePrice([{ amount: "289000", currency: "KRW" }, { amount: "259000", currency: "KRW" }]))
      .toEqual({ kind: "ambiguous" });
  });

  it("Given 같은 숫자의 다른 통화 When 고르면 Then 정하지 않는다", () => {
    expect(pickSinglePrice([{ amount: "20", currency: "USD" }, { amount: "20", currency: "EUR" }]))
      .toEqual({ kind: "ambiguous" });
  });

  it("Given 가격 후보가 없거나 모두 해석할 수 없음 When 고르면 Then 가격이 없다", () => {
    expect(pickSinglePrice([])).toEqual({ kind: "none" });
    expect(pickSinglePrice([{ amount: "39000", currency: null }, { amount: "가격문의", currency: "KRW" }]))
      .toEqual({ kind: "none" });
  });

  it("Given 해석할 수 없는 후보와 하나의 가격 When 고르면 Then 그 가격만 쓴다", () => {
    expect(pickSinglePrice([{ amount: "39000", currency: null }, { amount: "39000", currency: "KRW" }]))
      .toEqual({ kind: "single", price: { amountMinor: 39000, currency: "KRW" } });
  });
});
