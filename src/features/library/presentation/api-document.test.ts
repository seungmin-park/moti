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

  it("사진 경로는 UUID 경로 변수, 선택 버전 값과 본문 없는 302를 문서에 남긴다", () => {
    const operation = buildApiDocument().paths["/api/products/{productId}/picture"]?.get as {
      parameters: { name: string; in: string; required: boolean }[];
      responses: Record<string, { content?: unknown; headers?: Record<string, unknown> }>;
    };
    expect(operation.parameters).toEqual([
      expect.objectContaining({ name: "productId", in: "path", required: true }),
      expect.objectContaining({ name: "v", in: "query", required: false }),
    ]);
    expect(operation.responses["302"].content).toBeUndefined();
    expect(Object.keys(operation.responses["302"].headers ?? {})).toEqual(["Location", "Cache-Control"]);
    expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(["302", "400", "401", "403", "404", "503"]));
  });

  it("상품 정리와 컬렉션 이름 바꾸기는 UUID 경로 변수의 PATCH로 200·400·404/422·409 응답을 문서에 남긴다", () => {
    const document = buildApiDocument();
    for (const [path, name] of [["/api/products/{productId}", "productId"], ["/api/collections/{collectionId}", "collectionId"]]) {
      const operation = document.paths[path]?.patch as {
        parameters: { name: string; in: string; required: boolean; schema: { format?: string } }[];
        requestBody: unknown;
        responses: Record<string, unknown>;
      };
      expect(operation.parameters).toEqual([expect.objectContaining({ name, in: "path", required: true, schema: expect.objectContaining({ format: "uuid" }) })]);
      expect(operation.requestBody).toBeDefined();
      expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(["200", "400", "401", "403", "409", "413", "415", "422", "503"]));
    }
  });

  it("백업 내려받기는 GET 200에 백업 파일 스키마와 첨부 이름 헤더를 문서에 남긴다", () => {
    const operation = buildApiDocument().paths["/api/library/backup"]?.get as {
      responses: Record<string, { content?: Record<string, { schema: { properties?: Record<string, unknown> } }>; headers?: Record<string, unknown> }>;
    };
    expect(Object.keys(operation.responses["200"].headers ?? {})).toEqual(["Content-Disposition"]);
    expect(Object.keys(operation.responses["200"].content?.["application/json"].schema.properties ?? {}))
      .toEqual(["format", "version", "exportedAt", "collections", "products"]);
    expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(["200", "401", "403", "503"]));
  });
});
