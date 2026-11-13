import { z } from "zod";
import { MAX_JSON_BYTES } from "../../shared/presentation/http";
import { libraryBackupSchema } from "./library-backup";
import {
  collectionCreateRequestSchema,
  collectionCreateResponseSchema,
  collectionRenameRequestSchema,
  collectionRenameResponseSchema,
  errorResponseSchema,
  libraryReadResponseSchema,
  linkSaveRequestSchema,
  linkSaveResponseSchema,
  metadataRetryRequestSchema,
  metadataRetryResponseSchema,
  productChangeRequestSchema,
  productChangeResponseSchema,
} from "./library-dto";

type Route = {
  method: "get" | "post" | "patch";
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
    method: "get",
    path: "/api/library/backup",
    summary: "보관함을 백업 파일(moti.library-backup v1)로 내려받는다. 링크·옵션, 수집한 이름과 소유자 이름, 메모, 컬렉션 이름과 소속(이름), 담은 시각, 구매 상태·구매일·실구매가, 마지막 확인 가격을 담는다. id·revision·수집 상태·사진은 담지 않는다.",
    responses: {
      200: {
        description: "LibraryBackupResponse. 앱이 저장하는 값만 담는다(정리된 링크·이름·메모, 대소문자를 무시하고 겹치지 않는 컬렉션 이름, 파일 안의 이름으로만 이루어진 소속, 겹치지 않는 링크). 이 규칙은 스키마 밖의 검사라 문서에 나타나지 않는다.",
        schema: libraryBackupSchema,
        headers: { "Content-Disposition": 'attachment; filename="moti-backup-YYYYMMDD-HHmm.json" (서울 시각)' },
      },
      ...denied,
    },
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
    method: "patch",
    path: "/api/collections/{collectionId}",
    summary: "컬렉션 이름을 바꾼다. 소속 상품은 그대로다. 저장된 이름과 같으면 revision과 관계없이 바꾸지 않는다.",
    parameters: [{ name: "collectionId", description: "컬렉션 ID", schema: z.uuid() }],
    request: collectionRenameRequestSchema,
    responses: {
      200: { description: "CollectionRenameResponse. 이름이 바뀌었으면 revision이 1 오른다.", schema: collectionRenameResponseSchema },
      ...writeFailures,
      ...denied,
      409: { description: "대소문자를 무시한 같은 이름의 다른 컬렉션이 있거나(collection_duplicate) 화면이 본 revision 뒤에 바뀌었다(revision_conflict).", schema: errorResponseSchema },
      422: { description: "컬렉션이 없다.", schema: errorResponseSchema },
    },
  },
  {
    method: "patch",
    path: "/api/products/{productId}",
    summary: "소유자가 상품을 정리한다. details는 이름(null이면 그대로)·메모·컬렉션, purchase는 구매완료, purchase.record는 구매일·실구매가(null은 미입력, 0은 0원), wish는 위시로 되돌리기다. 구매와 되돌리기는 메모·컬렉션을 바꾸지 않고, 되돌리면 구매 기록을 지운다. 저장된 값과 같은 변경은 revision과 관계없이 바꾸지 않고 지금 상품을 돌려준다.",
    parameters: [{ name: "productId", description: "상품 ID", schema: z.uuid() }],
    request: productChangeRequestSchema,
    responses: {
      200: { description: "ProductChangeResponse. 값이 바뀌었으면 revision이 1 오른다.", schema: productChangeResponseSchema },
      ...writeFailures,
      ...denied,
      404: { description: "상품이 없다.", schema: errorResponseSchema },
      409: { description: "화면이 본 revision 뒤에 다른 곳에서 상품이 바뀌었다(revision_conflict).", schema: errorResponseSchema },
      422: { description: "선택한 컬렉션이 없다.", schema: errorResponseSchema },
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
