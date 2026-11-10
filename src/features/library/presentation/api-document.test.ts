import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApiDocument } from "./library-api-document";

const file = resolve(import.meta.dirname, "../../../../docs/api/openapi.json");

describe("API 문서", () => {
  it("커밋한 OpenAPI 문서가 실행 계약에서 생성한 문서와 같다", () => {
    const generated = `${JSON.stringify(buildApiDocument(), null, 2)}\n`;
    if (process.env.UPDATE_API_DOC === "1") writeFileSync(file, generated);
    expect(readFileSync(file, "utf8"), "npm run api:doc으로 문서를 다시 생성하세요.").toBe(generated);
  });
});
