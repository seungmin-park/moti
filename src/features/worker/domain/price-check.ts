import type { PriceCheckCode } from "../../metadata/domain/collection-error";
import type { PageFacts } from "../../metadata/domain/page-facts";
import { pickSinglePrice, type Price } from "../../metadata/domain/price";

// Why a daily check kept the previous price, as the worker reports it. `other_currency` is not one: only the database
// knows the stored currency, so it decides that one when it compares.
export type PriceCheckReason = Exclude<PriceCheckCode, "other_currency">;
// What one daily check found on the product's page: a price to compare with the stored one, or why there is none.
export type PriceCheckOutcome = { kind: "price"; price: Price } | { kind: "kept"; code: PriceCheckReason };

// The rule that set the stored price (3a) decides again: a page that reads as a product and shows one distinct price.
// The owner's option cannot be asked of a page, so a page with a price per option keeps the stored one.
export function decidePriceCheck(facts: PageFacts): PriceCheckOutcome {
  if (facts.title === null) return { kind: "kept", code: "no_product_data" };
  const choice = pickSinglePrice(facts.prices);
  return choice.kind === "single" ? { kind: "price", price: choice.price } : { kind: "kept", code: "no_single_price" };
}
