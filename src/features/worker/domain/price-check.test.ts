import { describe, expect, it } from "vitest";
import type { PageFacts, PriceCandidate } from "../../metadata/domain/page-facts";
import { decidePriceCheck } from "./price-check";

const page = (prices: PriceCandidate[], title: string | null = "북유럽 램프"): PageFacts =>
  ({ title, prices, imageUrl: "https://img.example/lamp.jpg" });

describe("매일 가격 확인의 판단", () => {
  it("Given 상품 페이지에 서로 다른 가격이 하나 When 판단하면 Then 그 가격을 비교할 값으로 낸다", () => {
    expect(decidePriceCheck(page([{ amount: "12,000", currency: "KRW" }]))).toEqual({
      kind: "price", price: { amountMinor: 12000, currency: "KRW" },
    });
  });

  it("Given 같은 가격이 여러 곳에 적힘 When 판단하면 Then 하나의 가격이다", () => {
    expect(decidePriceCheck(page([
      { amount: "19.99", currency: "USD" }, { amount: "19.990", currency: "usd" }, { amount: "가격문의", currency: "USD" },
    ]))).toEqual({ kind: "price", price: { amountMinor: 1999, currency: "USD" } });
  });

  it.each<[string, PriceCandidate[]]>([
    ["옵션마다 다른 가격", [{ amount: "12000", currency: "KRW" }, { amount: "15000", currency: "KRW" }]],
    ["같은 숫자의 다른 통화", [{ amount: "12000", currency: "KRW" }, { amount: "12000", currency: "JPY" }]],
    ["가격이 없음", []],
    ["읽을 수 없는 가격뿐", [{ amount: "가격문의", currency: "KRW" }, { amount: "1000", currency: null }]],
  ])("Given %s When 판단하면 Then 이전 가격을 지키고 이유는 no_single_price다", (_name, prices) => {
    expect(decidePriceCheck(page(prices))).toEqual({ kind: "kept", code: "no_single_price" });
  });

  it("Given 상품 이름을 찾지 못한 페이지 When 가격이 하나 있어도 Then 상품 페이지로 보지 않고 no_product_data다", () => {
    expect(decidePriceCheck(page([{ amount: "12000", currency: "KRW" }], null))).toEqual({ kind: "kept", code: "no_product_data" });
    expect(decidePriceCheck(page([], null))).toEqual({ kind: "kept", code: "no_product_data" });
  });
});
