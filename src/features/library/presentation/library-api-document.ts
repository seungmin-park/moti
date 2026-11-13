import { z } from "zod";
import { MAX_JSON_BYTES } from "../../shared/presentation/http";
import {
  MAX_SHARE_BYTES,
  SHARE_LINKS_PATH,
  shareLinkAddRequestSchema,
  shareLinkAddResponseSchema,
  shareKeyIssueRequestSchema,
  shareKeyIssueResponseSchema,
  shareKeyReadResponseSchema,
  shareKeyRevokeResponseSchema,
  shareLinkErrorResponseSchema,
} from "../../share/presentation/share-dto";
import {
  SCHEDULED_RUNS_PATH,
  scheduledRunErrorResponseSchema,
  scheduledRunResponseSchema,
  workerKeyIssueRequestSchema,
  workerKeyIssueResponseSchema,
  workerKeyRevokeResponseSchema,
  workerReadResponseSchema,
} from "../../worker/presentation/worker-dto";
import { MAX_BACKUP_BYTES, libraryBackupSchema } from "./library-backup";
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
  metadataWakeRequestSchema,
  metadataWakeResponseSchema,
  productChangeRequestSchema,
  productChangeResponseSchema,
} from "./library-dto";

type Route = {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  // Routes without it use the owner's cookie session.
  security?: "shareKey" | "workerKey";
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
    path: "/api/library/restore",
    summary: "백업 파일로 보관함 전체를 바꾼다. 파일 전체를 먼저 검사하고 한 트랜잭션에서 바꾸므로 실패하면 아무것도 바뀌지 않는다. 링크가 같은 상품은 id·사진·수집한 이름·마지막 확인 가격을 지키고 소유자 값(이름·메모·소속·구매·담은 시각)을 파일로 바꾸며 revision이 오른다. 이름이 같은(대소문자 무시) 컬렉션은 id를 지킨다. 파일에 없는 상품·컬렉션은 지우고, 새 상품은 수집을 기다린다. 응답 뒤 지운 상품의 사진 사본을 버리고 새 상품을 수집한다.",
    request: libraryBackupSchema,
    responses: {
      200: { description: "LibraryReadResponse. 바꾼 보관함", schema: libraryReadResponseSchema },
      400: { description: "백업 파일이 아니거나(not_backup), 더 새로운 버전이거나, 앱이 저장하지 않는 값·겹치는 링크·이름·없는 소속이 있거나, 구매일이 서버의 서울 날짜 뒤다. field는 첫 문제의 위치(products.3.sourceUrl)다.", schema: errorResponseSchema },
      413: { description: `본문이 ${MAX_BACKUP_BYTES}바이트를 넘는다.`, schema: errorResponseSchema },
      415: writeFailures[415],
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
    method: "post",
    path: "/api/library/metadata",
    summary: "아직 한 번도 시작하지 않은 수집(저장 키로 담은 상품, 복원 뒤 시간 안에 못 끝낸 상품 등)을 깨운다. 지금 세대에서 대기 중이고 시도가 0인 작업을 최신 상품부터 8개까지 다시 대기열 앞에 두고 응답 뒤에 수집한다. 다른 요청이 잡고 있는 작업은 건너뛴다.",
    request: metadataWakeRequestSchema,
    responses: {
      202: { description: "MetadataWakeResponse. 깨운 상품. 없으면 빈 목록이다.", schema: metadataWakeResponseSchema },
      ...writeFailures,
      ...denied,
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
  {
    method: "get",
    path: "/api/share-keys",
    summary: "공유 저장 키를 읽는다. 활성 키가 있으면 그것을, 없으면 마지막으로 폐기한 키를, 키를 만든 적이 없으면 null을 돌려준다. 끝 네 글자와 만든·마지막으로 담은·폐기한 시각만 보이고 비밀이나 해시는 보이지 않는다.",
    responses: { 200: { description: "ShareKeyReadResponse", schema: shareKeyReadResponseSchema }, ...denied },
  },
  {
    method: "post",
    path: "/api/share-keys",
    summary: "새 저장 키를 만든다. replaces는 화면이 본 활성 키(없었으면 null)이며, 그 키를 폐기하고 새 키를 한 트랜잭션에서 만든다. 비밀은 이 응답에만 한 번 담긴다.",
    request: shareKeyIssueRequestSchema,
    responses: {
      201: { description: "ShareKeyIssueResponse. secret은 moti_sk_ 뒤에 base64url 43자다.", schema: shareKeyIssueResponseSchema },
      ...writeFailures,
      ...denied,
      409: { description: "화면이 본 뒤 다른 곳에서 키가 바뀌었다(revision_conflict). 아무것도 바꾸지 않는다.", schema: errorResponseSchema },
    },
  },
  {
    method: "delete",
    path: "/api/share-keys/{keyId}",
    summary: "저장 키를 폐기한다. 이미 폐기한 키는 처음 폐기한 시각 그대로 돌려준다. 폐기가 끝나면 그 키로는 담을 수 없다.",
    parameters: [{ name: "keyId", description: "저장 키 ID", schema: z.uuid() }],
    responses: {
      200: { description: "ShareKeyRevokeResponse. revokedAt이 있다.", schema: shareKeyRevokeResponseSchema },
      400: { description: "키 ID가 UUID가 아니다.", schema: errorResponseSchema },
      ...denied,
      404: { description: "소유자의 키가 아니다(share_key_missing).", schema: errorResponseSchema },
    },
  },
  {
    method: "get",
    path: "/api/worker-keys",
    summary: "예약 실행의 작업 키와 최근 실행 다섯 개를 읽는다. 키는 활성 키, 없으면 마지막으로 폐기한 키, 만든 적이 없으면 null이고 끝 네 글자와 만든·마지막으로 실행한·폐기한 시각만 보인다. 실행은 상태(running·done·deadline·cut·revoked)와 셈, 이유별 실패 횟수만 보인다.",
    responses: { 200: { description: "WorkerReadResponse", schema: workerReadResponseSchema }, ...denied },
  },
  {
    method: "post",
    path: "/api/worker-keys",
    summary: "새 작업 키를 만든다. replaces는 화면이 본 활성 키(없었으면 null)이며, 그 키를 폐기하고 열린 실행을 멈춘 뒤 새 키를 한 트랜잭션에서 만든다. 비밀은 이 응답에만 한 번 담긴다.",
    request: workerKeyIssueRequestSchema,
    responses: {
      201: { description: "WorkerKeyIssueResponse. secret은 moti_wk_ 뒤에 base64url 43자다.", schema: workerKeyIssueResponseSchema },
      ...writeFailures,
      ...denied,
      409: { description: "화면이 본 뒤 다른 곳에서 키가 바뀌었다(revision_conflict). 아무것도 바꾸지 않는다.", schema: errorResponseSchema },
    },
  },
  {
    method: "delete",
    path: "/api/worker-keys/{keyId}",
    summary: "작업 키를 폐기하고 그 키의 열린 실행을 멈춘다. 이미 폐기한 키는 처음 폐기한 시각 그대로 돌려준다.",
    parameters: [{ name: "keyId", description: "작업 키 ID", schema: z.uuid() }],
    responses: {
      200: { description: "WorkerKeyRevokeResponse. revokedAt이 있다.", schema: workerKeyRevokeResponseSchema },
      400: { description: "키 ID가 UUID가 아니다.", schema: errorResponseSchema },
      ...denied,
      404: { description: "소유자의 키가 아니다(worker_key_missing).", schema: errorResponseSchema },
    },
  },
  // The Shortcut's route: the share key is its only credential, and every answer carries the message the Shortcut shows.
  {
    method: "post",
    path: SHARE_LINKS_PATH,
    summary: "iPhone 공유 단축어가 저장 키로 링크 하나를 담는다. 쿠키 세션은 인증이 아니고 출처도 묻지 않으며 CORS 허용 헤더가 없다. 응답은 결과와 단축어가 보여줄 message뿐이고 상품 정보는 돌려주지 않는다. 상품 정보 수집은 소유자가 moti를 열 때 시작한다.",
    security: "shareKey",
    request: shareLinkAddRequestSchema,
    responses: {
      201: { description: "ShareLinkAddResponse. 새로 담았다(added).", schema: shareLinkAddResponseSchema },
      200: { description: "ShareLinkAddResponse. 이미 담겨 있다(duplicate). 아무것도 바꾸지 않는다.", schema: shareLinkAddResponseSchema },
      400: { description: "본문이 url 하나만 담은 JSON 객체가 아니거나 상품 링크가 아니다(invalid_link).", schema: shareLinkErrorResponseSchema },
      401: {
        description: "키가 없거나 형식이 다르거나 모르는 키이거나 폐기한 키다. 모두 같은 본문이다(share_key_rejected).",
        schema: shareLinkErrorResponseSchema,
        headers: { "WWW-Authenticate": "Bearer" },
      },
      409: { description: "같은 링크인지 확인하지 못했다(identity_conflict).", schema: shareLinkErrorResponseSchema },
      413: { description: `본문이 ${MAX_SHARE_BYTES}바이트를 넘는다(payload_too_large).`, schema: shareLinkErrorResponseSchema },
      415: { description: "본문이 application/json이 아니다(unsupported_media_type).", schema: shareLinkErrorResponseSchema },
      429: { description: "이 키로 지난 한 시간 동안 30번 담았다(share_key_busy). 이미 담은 링크도 센다.", schema: shareLinkErrorResponseSchema },
      503: { description: "설정이 없거나(unconfigured) 저장소를 쓸 수 없다(unavailable).", schema: shareLinkErrorResponseSchema },
    },
  },
  // GitHub's scheduled call: the worker key is its only credential, and the run happens inside the request.
  {
    method: "post",
    path: SCHEDULED_RUNS_PATH,
    summary: "예약 실행 한 번. GitHub Actions가 작업 키로 부른다. 본문과 쿠키를 읽지 않고 출처도 묻지 않으며 CORS 허용 헤더가 없다. 수집이 끝나지 않은 위시 상품을 세 줄로 20초 동안 고르고(최대 60개) 이름과 가격만 쓴다. 사진은 소유자가 moti를 열 때 가져온다. 응답은 멈춘 이유와 셈, 이유별 실패 횟수뿐이다.",
    security: "workerKey",
    responses: {
      200: { description: "ScheduledRunResponse. done은 남은 일이 없고, deadline은 남은 일을 다음 실행에 넘겼다.", schema: scheduledRunResponseSchema },
      401: {
        description: "키가 없거나 형식이 다르거나 모르는 키이거나 폐기한 키다. 실행 중 폐기도 같다. 모두 같은 본문이다(worker_key_rejected).",
        schema: scheduledRunErrorResponseSchema,
        headers: { "WWW-Authenticate": "Bearer" },
      },
      409: { description: "다른 실행이 임대를 쥐고 있거나(run_busy) 실행 중 임대를 잃었다(run_lost).", schema: scheduledRunErrorResponseSchema },
      429: { description: "지난 24시간에 여덟 번 시작했다(run_limit).", schema: scheduledRunErrorResponseSchema },
      503: { description: "설정이 없거나(unconfigured) 저장소를 쓸 수 없다(unavailable).", schema: scheduledRunErrorResponseSchema },
    },
  },
];

export function buildApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of libraryRoutes) {
    paths[route.path] ??= {};
    paths[route.path][route.method] = {
      summary: route.summary,
      ...(route.security && { security: [{ [route.security]: [] }] }),
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
  return {
    openapi: "3.1.0",
    info: { title: "moti library API", version: "1" },
    paths,
    components: {
      securitySchemes: {
        shareKey: {
          type: "http",
          scheme: "bearer",
          description: "공유 저장 화면에서 만든 추가 전용 키(moti_sk_ 뒤에 base64url 43자). 링크 추가에만 쓰고 세션이 되지 않는다.",
        },
        workerKey: {
          type: "http",
          scheme: "bearer",
          description: "자동 확인 화면에서 만든 작업 키(moti_wk_ 뒤에 base64url 43자). 예약 실행에만 쓰고 세션이 되지 않으며 공유 키와 서로 대신하지 않는다.",
        },
      },
    },
  };
}
