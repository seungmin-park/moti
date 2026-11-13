import { z } from "zod";
import { MAX_JSON_BYTES } from "../../shared/presentation/http";
import {
  collectionCreateRequestSchema,
  collectionCreateResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveRequestSchema,
  linkSaveResponseSchema,
  metadataRetryRequestSchema,
  metadataRetryResponseSchema,
} from "./library-dto";

type Route = {
  method: "get" | "post";
  path: string;
  summary: string;
  parameters?: { name: string; in?: "path" | "query"; description: string; schema: z.ZodType }[];
  request?: z.ZodType;
  responses: Record<number, { description: string; schema?: z.ZodType; headers?: Record<string, string> }>;
};

const denied = {
  401: { description: "로그인 세션이 없다.", schema: errorResponseSchema },
  403: { description: "허용한 Google 계정이 아니면 세션을 종료한다. 다른 출처의 쓰기 요청도 거절한다.", schema: errorResponseSchema },
  503: { description: "소유자 설정이 없거나 저장소·인증 서버를 사용할 수 없다.", schema: errorResponseSchema },
};
const writeFailures = {
  400: { description: "입력이 유효하지 않다.", schema: errorResponseSchema },
  413: { description: `본문이 ${MAX_JSON_BYTES}바이트를 넘는다.`, schema: errorResponseSchema },
  415: { description: "본문이 application/json이 아니다.", schema: errorResponseSchema },
};

export const libraryRoutes: Route[] = [
  {
    method: "get",
    path: "/api/library",
    summary: "보관함의 상품과 컬렉션을 읽는다.",
    responses: { 200: { description: "LibraryReadResponse", schema: libraryReadResponseSchema }, ...denied },
  },
  {
    method: "post",
    path: "/api/links",
    summary: "링크를 저장한다. 같은 링크·옵션이면 기존 상품을 바꾸지 않고 돌려준다.",
    request: linkSaveRequestSchema,
    responses: {
      201: { description: "LinkSaveResponse. 새 상품", schema: linkSaveResponseSchema },
      200: { description: "LinkSaveResponse. 이미 있는 상품", schema: linkSaveResponseSchema },
      ...writeFailures,
      ...denied,
      409: { description: "식별자 충돌", schema: errorResponseSchema },
      422: { description: "선택한 컬렉션이 없다.", schema: errorResponseSchema },
    },
  },
  {
    method: "post",
    path: "/api/collections",
    summary: "컬렉션을 만든다.",
    request: collectionCreateRequestSchema,
    responses: {
      201: { description: "CollectionCreateResponse", schema: collectionCreateResponseSchema },
      ...writeFailures,
      ...denied,
      409: { description: "대소문자를 무시한 같은 이름이 있다.", schema: errorResponseSchema },
    },
  },
  {
    method: "post",
    path: "/api/products/{productId}/metadata",
    summary: "수집에 실패했거나 멈춘 상품의 정보를 다시 가져온다. 수집은 응답 뒤에 실행한다.",
    parameters: [{ name: "productId", description: "상품 ID", schema: z.uuid() }],
    request: metadataRetryRequestSchema,
    responses: {
      202: { description: "MetadataRetryResponse. 실패했거나 시도를 다 쓴 상품은 다음 세대로 대기하고, 시도가 남은 멈춘 작업은 같은 세대로 다시 시작한다.", schema: metadataRetryResponseSchema },
      ...writeFailures,
      ...denied,
      404: { description: "상품이 없다.", schema: errorResponseSchema },
      409: { description: "화면의 세대가 다르거나 이미 수집 중·대기 중·완료 상태다.", schema: errorResponseSchema },
    },
  },
  {
    method: "get",
    path: "/api/products/{productId}/picture",
    summary: "상품의 현재 사진 사본으로 보낸다. 화면의 이미지 주소이며 요청마다 비공개 사본의 1시간짜리 서명 주소를 새로 만든다.",
    parameters: [
      { name: "productId", in: "path", description: "상품 ID", schema: z.uuid() },
      { name: "v", in: "query", description: "사본 버전. 캐시 키로만 쓰고 서버는 언제나 현재 사본으로 보낸다.", schema: z.uuid() },
    ],
    responses: {
      302: {
        description: "본문 없이 서명한 Storage 주소로 이동한다.",
        headers: { Location: "서명한 Storage 주소. 1시간 뒤 만료한다.", "Cache-Control": "private, max-age=3000" },
      },
      400: { description: "상품 ID가 UUID가 아니다.", schema: errorResponseSchema },
      ...denied,
      404: { description: "상품이 없거나(product_missing) 보여줄 사본이 없다(picture_missing).", schema: errorResponseSchema },
    },
  },
];

export function buildApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of libraryRoutes) {
    paths[route.path] ??= {};
    paths[route.path][route.method] = {
      summary: route.summary,
      ...(route.parameters && {
        parameters: route.parameters.map((parameter) => ({
          name: parameter.name,
          in: parameter.in ?? "path",
          required: (parameter.in ?? "path") === "path",
          description: parameter.description,
          schema: z.toJSONSchema(parameter.schema),
        })),
      }),
      ...(route.request && {
        requestBody: {
          required: true,
          content: { "application/json": { schema: z.toJSONSchema(route.request) } },
        },
      }),
      responses: Object.fromEntries(Object.entries(route.responses)
        .toSorted(([a], [b]) => Number(a) - Number(b))
        .map(([status, response]) => [status, {
          description: response.description,
          ...(response.headers && {
            headers: Object.fromEntries(Object.entries(response.headers)
              .map(([name, description]) => [name, { description, schema: { type: "string" } }])),
          }),
          ...(response.schema && { content: { "application/json": { schema: z.toJSONSchema(response.schema) } } }),
        }])),
    };
  }
  return { openapi: "3.1.0", info: { title: "moti library API", version: "1" }, paths };
}
