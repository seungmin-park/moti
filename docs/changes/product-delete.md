# 상품 삭제

소유자가 실제 보관함(`/`)의 상품 상세에서 상품 하나를 지우는 단위다. 운영에서 써 보니 쓸모없는 상품이 남았다. 네이버 스마트스토어·쿠팡처럼 페이지 읽기를 막는 쇼핑몰의 상품과, naver.me 짧은 주소로 한 번 더 담긴 같은 상품이다. 지금까지는 지울 방법이 복원뿐이었다. 가장 작은 변경으로 "상품 삭제" 명령 하나를 DB RPC → 저장소 → 서비스 → HTTP 경로 → 화면까지 만들고 계층마다 검사했다. 컬렉션 삭제는 이 단위가 아니다.

## 바뀐 동작

- 새 RPC `public.moti_delete_product(p_product_id uuid, p_revision integer) returns jsonb`(마이그레이션 `20261120000000_product_delete.sql`). 정리 RPC와 같은 틀이다. `moti_rpc` 소유의 보안 정의자이고 `set search_path = ''`, `moti.require_owner()`를 거치며 `authenticated`만 실행한다(`public`·`anon`·`service_role`은 권한 없음). 내부 함수 `moti.delete_product`는 `moti_rpc`에만 실행 권한이 있다.
- 결과와 오류는 정리 RPC의 규칙을 그대로 쓴다. 성공하면 `{"id": <상품 id>}`를 돌려준다. 검사 순서는 입력(`M0002`, revision이 null이거나 1보다 작음) → 대상 없음(`M0006`, `moti.product_for_change`) → 오래된 revision(`M0008`, `moti.require_revision`) → 삭제다. 이미 지운 상품, 없는 상품, 다른 소유자의 상품은 모두 `M0006`이다. 소유자가 아닌 세션은 `M0001`, 익명은 `42501`이다. 정리 RPC의 "같은 값이면 revision과 상관없이 성공"은 삭제에 없다. 삭제는 늘 무언가를 바꾸므로 오래된 revision은 언제나 충돌이고, 소유자는 화면이 보여준 상품을 지우거나 먼저 바뀐 상품을 확인한다.
- 소속(`product_collections`)과 수집 작업(`metadata_jobs`)은 상품 외래키의 `on delete cascade`로 함께 지워진다. persistence 검사가 `pg_constraint`에서 두 외래키의 `confdeltype = 'c'`를 확인한다. 컬렉션은 남는다.
- 잠금 순서는 `settling_product`·`metadata_retry`와 같은 작업 → 상품이다. 상품의 작업 행을 먼저 `for update`로 잡고 상품을 잡은 뒤 지운다. 진행 중인 수집의 완료·실패는 먼저 끝나거나, 작업이 사라진 것을 보고 `stale`로 답한다. 예약 실행의 `moti_worker_complete`·`moti_worker_fail`·`moti_worker_price`도 행이 없으면 `stale`이고 실행 셈을 올리지 않는다. `moti_worker_next`는 지운 상품을 고르지 않는다. 지운 상품의 "다시 가져오기"는 `M0006`이다. 어떤 경로도 상품을 되살리지 않는다.
- 식별자 유일성(`unique (owner_id, identity_hash)`)이 풀려 같은 링크를 다시 담으면 새 id·revision 1의 새 상품이 된다.
- 사진 사본은 바로 지우지 않는다. 삭제로 상품과 작업 행이 사라지면 그 사본은 어떤 상품도 쓰지 않고 수집 중인 작업의 이번 시도도 아니게 된다. 기존 `moti_picture_orphans`가 그 이름을 돌려주고(10분 여유는 삭제 시각이 아니라 사본을 만든 시각 기준이다), 소유자가 moti를 열 때의 남은 사본 정리(5c)가 Storage에서 지운다. 새 Storage 코드는 없다.
- 응용 계층은 `ProductDeleteCommand { productId, revision }`과 `ProductDeleteResult { productId }`, `toProductDeleteCommand`(UUID와 revision 범위 검사, 기존 `parseRevision`), `LibraryStore.deleteProduct`, `LibraryService.deleteProduct`다. 저장소 어댑터는 응답을 `{ id: uuid }`로 검사하고 기존 `databaseErrors` 표로 `M0006`→`product_missing`, `M0008`→`revision_conflict`를 바꾼다.
- HTTP는 `DELETE /api/products/{productId}`다. 본문은 PATCH처럼 화면이 본 revision을 담은 JSON `ProductDeleteRequest { revision }`(정수 1~2147483647, 다른 필드 거절)이고, 응답은 200 `ProductDeleteResponse { id }`다. 기존 쓰기 경계(같은 출처, `application/json`, 16KiB, `no-store`)를 그대로 지난다. 오류는 400 `invalid_input`, 401, 403(`forbidden`·`cross_origin`), 404 `product_missing`, 409 `revision_conflict`, 413, 415, 503이다. 422는 없다. `library-api-document.ts`에 경로를 더하고 `docs/api/openapi.json`을 다시 생성했다.
- 화면은 상세의 "구매완료로 이동"(또는 "위시로 되돌리기") 아래에 "삭제" 버튼을 둔다. 누르면 아무것도 보내지 않고 상세 안에서 "이 상품을 삭제할까요? 메모, 컬렉션 소속과 구매 기록도 함께 지워지고 되돌릴 수 없어요."를 묻는다(`window.confirm` 없음). 초점은 "취소"에 먼저 가고, "취소"나 Esc는 확인만 닫고 초점을 "삭제"로 돌려준다. "삭제하기"만 요청을 보낸다. 보내는 동안 상세를 닫거나 다른 쓰기를 할 수 없다. 성공하면 상세를 닫고 목록과 컬렉션 개수에서 그 상품을 빼며 "상품을 삭제했어요" 알림을 띄운다. 다시 읽지 않는다. 충돌(409)은 다른 정리와 같은 종류의 문구 "다른 곳에서 먼저 바뀌었어요. 최신 내용을 불러왔어요. 확인 후 다시 삭제해 주세요."를 상세에 보이고 다시 읽는다. 404는 "상품을 찾을 수 없어요. 목록을 새로 불러왔어요."이고, 다시 읽은 보관함에 상품이 없어 상세가 닫히면 같은 문구를 알림으로 옮긴다. 이 옮기기는 다른 정리의 404에도 적용된다. 전에는 상세가 아무 말 없이 닫혔다.
- 색은 흰색·중립 회색·차콜이다. 확인 상자의 테두리는 중립 회색, "삭제하기"는 차콜이다. 빨간색은 오류 문구에만 쓴다. `/demo` 목업은 바뀌지 않았다(목업 계약에 삭제가 없다).

## 설계 선택

- 요청 모양: `DELETE` 본문에 revision을 담았다. 같은 자원의 PATCH가 본문의 `revision`으로 충돌을 검사하므로 처리기·검사·화면 클라이언트를 같은 틀로 쓴다. 질의 문자열(`?revision=`)이나 `If-Match` 헤더도 가능하지만 이 앱에 그런 경로가 없어 두 번째 방식을 만들게 된다. `fetch`와 Next.js 경로 처리기는 DELETE 본문을 그대로 전달하고, 실제 HTTP 검사가 빌드한 앱에서 확인한다.
- 결과: 지운 상품의 `id`만 돌려준다. 화면은 이미 상품과 컬렉션을 들고 있어 그 id를 빼기만 하면 목록과 개수가 맞는다. 컬렉션 개수는 상품의 소속에서 계산하므로 컬렉션을 따로 받을 필요가 없다.
- 반복 삭제: 이미 지운 상품은 `M0006`(404)이다. 정리 RPC가 없는 상품에 쓰는 코드를 그대로 쓰고, 화면은 다시 읽어 상품이 없음을 확인한다.
- 사진: 지우는 요청이 Storage를 부르지 않는다. 남은 사본 정리가 이미 같은 조건(참조 없음, 수집 중 아님, 10분)을 지키고 Storage 정책이 다시 확인하므로, 삭제가 사본을 지우는 두 번째 경로를 만들지 않았다.

## 검증

| 검사 | 결과 |
| --- | --- |
| 단위 (`npm test`) | 1,439개 통과 (이전 1,385개) |
| 실제 DB | persistence 296개, service 63개 통과 (이전 276·57개) |
| 실제 HTTP | 53개 통과 (이전 46개) |
| 실제 스택 브라우저 (PC Chromium, iPhone 크기 WebKit) | 56개 통과 (이전 50개) |
| Supabase 없는 브라우저 (`tests/ui`) | 50개 통과 (이전 50개) |

로컬 `npm run verify`로 개수를 확인했다(종료 코드 0).

- persistence(`tests/persistence/product-delete.test.ts`, 20개): 삭제와 연쇄 삭제, 외래키의 cascade 확인, 오래된 revision `M0008`, 없는·지운·다른 소유자의 상품 `M0006`, revision 0·음수·null `M0002`, 같은 revision의 동시 삭제 8번 중 하나만 성공, 지운 뒤 같은 링크의 새 상품, 수집 중 삭제 뒤 완료·실패의 `stale`, 삭제와 완료를 동시에 6쌍 보내도 교착 없음, 지운 상품의 다시 가져오기 `M0006`, 예약 실행의 대기·가격 고르기 제외와 늦은 완료·실패·가격 결과의 `stale`(실행 셈 그대로), 보이던 사본과 수집 중 올린 사본이 10분 여유 뒤에만 남은 사본이 되고 소유자가 Storage에서 지울 수 있음, 익명 `42501`·다른 계정 `M0001`, 함수 소유자·보안 정의자·`search_path`·실행 권한.
- service(`tests/service/product-delete.test.ts`, 6개): 실제 저장소로 삭제 뒤 다시 읽기, `revision_conflict`, `product_missing`, `unauthorized`, 같은 링크 다시 담기, 기존 `sweepPictures`가 지운 상품의 사본을 10분 뒤 Storage에서 지움.
- 처리기 Mock(Given–When–Then): 성공(소문자 id로 서비스 호출), 깨진 JSON·빈 본문·revision 누락·모르는 필드·0·소수·문자열·범위 초과, UUID 아님, 저장소 거절별 상태(409·404·400·503), 다른 출처, 세션 없음·설정 없음·다른 Google 계정·DB의 소유자 거절, JSON 아님(415).
- API 문서: DELETE의 경로 변수, revision만 담은 필수 본문, 200의 `id`, 응답 코드 목록과 422 없음. 커밋한 OpenAPI가 생성 결과와 같음.
- 실제 HTTP(`tests/http/product-delete.test.ts`, 7개): 200과 새 세션에서 사라진 상품·남은 컬렉션, 409 뒤 최신 revision으로 200, 다시 지우면 404, 같은 링크 다시 담기 201, 400·415, 다른 출처 403, 세션 없음 401.
- 실제 스택 브라우저(`tests/browser/product-delete.spec.ts`, 3개 × 두 기기): 키보드로 확인 열기·Esc로 닫기·초점 복귀·확정, 목록과 컬렉션 개수(2 → 1)에서 바로 사라지고 새로고침해도 없음, 확인 상자의 axe 검사와 중립 색, 충돌 안내와 오류 색, 최신 내용을 본 뒤 삭제, 다른 곳에서 이미 지운 상품의 알림.

Red는 `docs/evidence/product-delete/red.txt`에 있다.

- 단위: 구현 전 53개 실패(명령 6, 처리기 20, API 문서 1, 화면 API 클라이언트 19, 화면 상태 7).
- 실제 DB: 마이그레이션과 저장소 없이 persistence 19개와 service 6개 실패. 대부분 RPC가 없어 PostgREST가 `PGRST202`를 돌려준 것이다. 외래키 cascade 확인은 기존 스키마를 확인하는 검사라 Red 때도 통과했다. 공개 RPC 목록을 고정하는 `library-security.test.ts`에는 Red 실행 뒤 `moti_delete_product`를 더했다.
- 실제 HTTP: DB·서비스를 구현하고 경로에 `DELETE`를 내보내지 않은 빌드에서 7개 모두 405로 실패했다.
- 실제 스택 브라우저: 구현 전에 작성했지만 HTTP 단계가 실패하면 검사 스크립트가 브라우저 단계 전에 멈춰 별도 Red 출력이 없다. 구현 뒤 첫 실행에서 두 기기 6개가 모두 통과했다.

## 남은 범위

- 컬렉션 삭제는 만들지 않았다.
- 실행 취소는 없다. 확인 단계가 유일한 보호다. 지운 상품은 백업 파일로만 되돌릴 수 있다.
- 지운 상품의 사진 사본은 소유자가 다음에 moti를 열 때 지워진다. 만든 지 10분이 안 된 사본은 그다음 열기까지 남는다. 그 전까지 Storage에 남는다. 쌓인 남은 사본은 열 때마다 200개씩 줄어든다(5c와 같음).
- 다른 탭은 새로고침하거나 그 상품을 고치려 할 때(404) 삭제를 안다. 다른 탭의 화면을 바로 맞추지 않는다.
- 응답을 잃은 삭제(503·연결 끊김)는 다시 읽지 않고 "잠시 뒤 다시 시도해 주세요."를 보인다. 실제로 지워졌다면 다음 시도가 404로 다시 읽어 맞춘다.
- 실제 Google OAuth, 실제 iPhone, 운영 Supabase와 호스팅에서는 확인하지 않았다. 브라우저 검사는 로컬 Auth 세션과 iPhone 크기 WebKit이다. 배포는 별도 승인이다.
