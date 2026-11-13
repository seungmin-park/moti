import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectionErrorCodes, collectionErrors } from "./collection-error";

const migration = readFileSync(new URL("../../../../supabase/migrations/20261117000000_scheduled_runs.sql", import.meta.url), "utf8");

describe("작업자가 다시 집는 수집 실패", () => {
  it("SQL의 목록은 다시 시도할 수 있는 이유에서 시도 소진을 뺀 것과 같다", () => {
    const list = /j\.error_code in \(([^)]*)\)/.exec(migration)?.[1] ?? "";
    const inSql = [...list.matchAll(/'([a-z_]+)'/g)].map(([, code]) => code).toSorted();
    const retryable = collectionErrorCodes.filter((code) => collectionErrors[code].retryable && code !== "attempts_exhausted").toSorted();
    expect(inSql).toEqual(retryable);
    expect(inSql.length).toBeGreaterThan(0);
  });
});
