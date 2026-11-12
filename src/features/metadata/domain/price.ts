import type { PriceCandidate } from "./page-facts";

export type Price = { amountMinor: number; currency: string };
export type PriceChoice = { kind: "single"; price: Price } | { kind: "none" } | { kind: "ambiguous" };

const plain = /^(\d+)(?:\.(\d+))?$/;
const grouped = /^\d{1,3}(?:,\d{3})+$/;
const currencies = new Set(Intl.supportedValuesOf("currency"));

// Same source of fraction digits as the screen, so a stored amount reads back as the page showed it.
function fractionDigits(currency: string): number {
  const format = new Intl.NumberFormat("ko-KR", { style: "currency", currency });
  return format.resolvedOptions().maximumFractionDigits ?? 0;
}

export function toMinorUnits(amount: string, currency: string | null): Price | null {
  const code = currency?.trim().toUpperCase() ?? "";
  if (!currencies.has(code)) return null;
  const text = amount.trim();
  const match = grouped.test(text) ? [text, text.replaceAll(",", ""), undefined] : plain.exec(text);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const digits = fractionDigits(code);
  if (/[^0]/.test(fraction.slice(digits))) return null;
  const minor = BigInt(whole + fraction.slice(0, digits).padEnd(digits, "0"));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { amountMinor: Number(minor), currency: code };
}

export function pickSinglePrice(candidates: readonly PriceCandidate[]): PriceChoice {
  const prices = new Map<string, Price>();
  for (const candidate of candidates) {
    const price = toMinorUnits(candidate.amount, candidate.currency);
    if (price) prices.set(`${price.amountMinor} ${price.currency}`, price);
  }
  if (prices.size === 0) return { kind: "none" };
  if (prices.size > 1) return { kind: "ambiguous" };
  return { kind: "single", price: [...prices.values()][0] };
}
