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

  it("다시 가져오기 경로는 UUID 경로 변수와 202·404·409 응답을 문서에 남긴다", () => {
    const operation = buildApiDocument().paths["/api/products/{productId}/metadata"]?.post as {
      parameters: { name: string; in: string; required: boolean; schema: { format?: string } }[];
      responses: Record<string, unknown>;
    };
    expect(operation.parameters).toEqual([expect.objectContaining({ name: "productId", in: "path", required: true, schema: expect.objectContaining({ format: "uuid" }) })]);
    expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(["202", "400", "401", "403", "404", "409", "413", "415", "503"]));
  });
});
