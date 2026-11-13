// Rules for what the owner writes on a saved product. The screen checks a form with them before sending, and the
// server's commands check the request with them again; the database keeps the same limits as its last line.
export const MAX_TITLE_LENGTH = 120;
export const MAX_NOTE_LENGTH = 3000;
export const PAID_CURRENCIES = ["KRW"] as const;
export const MAX_PAID_AMOUNT = Number.MAX_SAFE_INTEGER;
export const EARLIEST_PURCHASE_DATE = "1900-01-01";

export type PaidCurrency = (typeof PAID_CURRENCIES)[number];
export type PaidPrice = { amountMinor: number; currency: PaidCurrency };
export type ProductField = "title" | "note" | "date" | "price";
export type FieldResult<T> = { ok: true; value: T } | { ok: false; field: ProductField; message: string };

const codePoints = (value: string) => [...value].length;
const fail = (field: ProductField, message: string): FieldResult<never> => ({ ok: false, field, message });

export function normalizeTitle(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseProductTitle(input: unknown): FieldResult<string> {
  if (typeof input !== "string" || !input.isWellFormed()) return fail("title", "상품 이름을 확인해 주세요.");
  const title = normalizeTitle(input);
  if (!title || codePoints(title) > MAX_TITLE_LENGTH) return fail("title", "상품 이름은 1~120자로 입력해 주세요.");
  return { ok: true, value: title };
}

export function parseProductNote(input: unknown): FieldResult<string> {
  if (typeof input !== "string" || !input.isWellFormed() || input.includes("\u0000")) {
    return fail("note", "메모를 확인해 주세요.");
  }
  if (codePoints(input) > MAX_NOTE_LENGTH) return fail("note", "메모는 3,000자까지 적을 수 있어요.");
  return { ok: true, value: input };
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// `today` is the Seoul calendar day of whoever checks: the screen for its form, the server for the request.
export function parsePurchaseDate(input: unknown, today: string): FieldResult<string | null> {
  if (input === null || input === "") return { ok: true, value: null };
  if (typeof input !== "string" || !isCalendarDate(input) || input < EARLIEST_PURCHASE_DATE) {
    return fail("date", "올바른 구매일을 입력해 주세요.");
  }
  if (input > today) return fail("date", "구매일은 오늘까지 입력할 수 있어요.");
  return { ok: true, value: input };
}

// Empty means not recorded and differs from 0. Only whole won are accepted for now.
export function parsePaidPrice(input: unknown): FieldResult<PaidPrice | null> {
  const invalid = fail("price", "실구매가는 0 이상의 정수로 입력해 주세요.");
  if (typeof input !== "string") return invalid;
  const digits = input.trim();
  if (!digits) return { ok: true, value: null };
  if (!/^\d+$/.test(digits)) return invalid;
  const amountMinor = Number(digits);
  if (!Number.isSafeInteger(amountMinor)) return invalid;
  return { ok: true, value: { amountMinor, currency: "KRW" } };
}

const seoulDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });

export function seoulToday(now: Date): string {
  return seoulDay.format(now);
}
