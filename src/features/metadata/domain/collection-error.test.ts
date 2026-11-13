import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectionErrorCodes, collectionErrors, priceCheckCodes } from "./collection-error";

const directory = new URL("../../../../supabase/migrations/", import.meta.url);
// Later migrations replace earlier definitions, so the last match is the one the database runs.
const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).toSorted()
  .map((name) => readFileSync(new URL(name, directory), "utf8")).join("\n");
const lastList = (pattern: RegExp) => {
  const list = [...migrations.matchAll(pattern)].at(-1)?.[1] ?? "";
  return [...list.matchAll(/'([a-z_]+)'/g)].map(([, code]) => code).toSorted();
};

describe("작업자가 다시 집는 수집 실패", () => {
  it("SQL의 목록은 다시 시도할 수 있는 이유에서 시도 소진을 뺀 것과 같다", () => {
    const inSql = lastList(/j\.error_code in \(([^)]*)\)/g);
    const retryable = collectionErrorCodes.filter((code) => collectionErrors[code].retryable && code !== "attempts_exhausted").toSorted();
    expect(inSql).toEqual(retryable);
    expect(inSql.length).toBeGreaterThan(0);
  });
});

describe("가격 확인이 이전 가격을 지킨 이유", () => {
  it("상품 열이 받는 목록은 TypeScript의 가격 확인 이유와 같다", () => {
    expect(lastList(/price_check_code in \(([^)]*)\)/g)).toEqual(priceCheckCodes.toSorted());
  });

  it("작업자가 보낼 수 있는 목록은 거기서 DB만 정하는 other_currency를 뺀 것이다", () => {
    expect(lastList(/p_code not in \(([^)]*)\)/g)).toEqual(priceCheckCodes.filter((code) => code !== "other_currency").toSorted());
  });
});
