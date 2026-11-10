import { z } from "zod";
import { MAX_JSON_BYTES } from "../../shared/presentation/http";
import {
  collectionCreateRequestSchema,
  collectionCreateResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveRequestSchema,
  linkSaveResponseSchema,
} from "./library-dto";

type Route = {
  method: "get" | "post";
  path: string;
  summary: string;
  request?: z.ZodType;
  responses: Record<number, { description: string; schema: z.ZodType }>;
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
];

export function buildApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of libraryRoutes) {
    paths[route.path] ??= {};
    paths[route.path][route.method] = {
      summary: route.summary,
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
          content: { "application/json": { schema: z.toJSONSchema(response.schema) } },
        }])),
    };
  }
  return { openapi: "3.1.0", info: { title: "moti library API", version: "1" }, paths };
}
