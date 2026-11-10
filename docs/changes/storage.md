# 영구 보관함의 저장 계약과 테스트 준비

사용자가 담은 링크와 선택 컬렉션을 새 세션에서도 읽을 수 있게 하는 첫 저장 단위다. 이 기록은 SQL 기능 구현 전 체크포인트다. 영구 저장이나 실제 Google OAuth를 검증했다고 보고하지 않는다.

## 현재 구현과 책임

`src/features/wishlist/link.ts`가 목업과 실제 서비스의 링크 규칙을 함께 소유한다. 원문은 양끝 공백만 제거해 보관한다. 중복 판별 URL은 `utm_*`, `gclid`, `fbclid`, `msclkid`를 제거하고 query 키를 정렬한다. 상품 옵션 query와 fragment는 남긴다. 옵션은 trim과 NFC 정규화를 적용한다. URL은 4096자, 옵션은 120자까지 허용하며 Unicode code point로 센다. 잘못된 Unicode, URL 내부 제어문자와 NUL 옵션을 거절한다. 기존 입력 화면의 `maxLength`는 UTF-16 기준이어서 일부 문자에서는 더 보수적으로 제한한다.

`src/features/library/domain.ts`(현재 `domain/library.ts`와 `application/commands.ts`)가 상품, 컬렉션, 구매 정보와 저장 명령을 정의한다. 수집 상태와 마지막 성공 가격을 별도 값으로 둔다. 금액은 통화와 최소 단위의 정수로 표현한다. `0`과 미입력 `null`을 구분한다. UUID와 revision을 포함하며 메타데이터 generation은 별도로 보존한다.

서비스는 `createLibraryService(store)`로 구성한다. 저장소는 `createSupabaseLibraryStore(client)`로 구성하며 Supabase의 실제 HTTP RPC를 호출한다. DB 행은 어댑터에서 검증하고 도메인 값으로 바꾼다. 화면이나 호출자에게 소유자 ID, 해시와 DB 열 이름을 반환하지 않는다.

| 연산 | 입력과 결과 |
| --- | --- |
| `snapshot()` | `{ products, collections }` |
| `saveLink({ url, option, collectionIds })` | `{ kind: "added" 또는 "duplicate", product }` |
| `createCollection(name)` | 저장한 컬렉션. 링크 저장과 별도 커밋이다. |

서비스는 컬렉션 ID를 UUID로 검증하고 중복을 제거한다. 한 명령은 컬렉션 ID를 최대 100개 받는다. 컬렉션 이름은 trim과 NFC 정규화 뒤 1~40자다. 저장소의 `saveLink`는 이미 준비한 `SaveLinkCommand`를 받으며 원문, 판별 URL, 옵션, 표시할 쇼핑몰과 컬렉션 ID를 포함한다.

## DB 구현 담당자에게 넘길 계약

스키마와 RPC 선언은 `supabase/migrations/20261111000000_library.sql`에 있다. 세 RPC 본문은 현재 SQLSTATE `0A000`으로 기능 미구현을 알린다. RLS 정책과 실제 저장 명령은 아직 없다. 이 상태는 의미있는 DB Red를 실행하기 위한 중간 상태이며 병합 대상의 최종 동작이 아니다.

`moti.owner_config`는 `singleton = true`, `owner_id`, `google_subject`를 가진다. 설정한 사용자와 실제 `auth.uid()`가 같아야 한다. 같은 사용자에게 설정한 subject의 Google identity가 있어야 한다. 설정 누락, 익명, 다른 사용자, Google identity 누락과 subject 불일치는 모두 거절한다. RPC 함수 역할은 테이블 소유자와 달라야 하며 `BYPASSRLS`나 superuser 권한을 가져서는 안 된다. 다섯 저장 테이블 모두 FORCE RLS를 유지한다.

상품, 선택 소속과 초기 수집 작업은 하나의 RPC에서 커밋한다. 유효하지 않거나 다른 사용자의 컬렉션이 하나라도 있으면 쓰기를 남기지 않는다. 중복 요청도 컬렉션 입력을 검증한다. 같은 링크와 옵션의 동시 요청은 상품 하나와 작업 하나를 남기고, 중복 결과가 기존 원문·메모·소속·revision을 바꾸면 안 된다.

`identity_hash`는 generated SHA-256 열이다. 입력은 `char_length(identity_url)::text || ':' || identity_url || option`이다. 길이 접두사가 URL과 옵션의 경계를 구분한다. 고유 인덱스는 소유자와 해시를 사용해 긴 URL의 B-tree 크기 제한을 피한다. 같은 해시를 찾았을 때는 `identity_url`과 `option`의 완전한 값도 비교한다. 실제 SHA-256 충돌을 만드는 테스트는 없으므로 이 비교 경로는 SQL 코드 리뷰로 확인해야 한다.

RPC 응답은 다음 계약을 사용한다.

- `moti_snapshot()`은 `{ products: ProductRow[], collections: CollectionRow[] }`를 반환한다.
- `moti_save_link(p_source_url, p_identity_url, p_option, p_shop, p_collection_ids)`는 `{ kind, product: ProductRow }`를 반환한다.
- `moti_create_collection(p_name)`은 `CollectionRow`를 반환한다.
- `ProductRow`는 마이그레이션의 상품 열과 `collection_ids: uuid[]`를 포함한다. `CollectionRow`는 `id`, `name`, `revision`, `created_at`, `updated_at`를 포함한다. 시간은 시간대가 있는 ISO 문자열이다.
- `M0001`은 권한 거절, `M0002`는 잘못된 입력, `M0003`은 선택 컬렉션 부재, `M0004`는 컬렉션 이름 중복, `M0005`는 해시가 같지만 완전한 값이 다른 경우다. 어댑터는 이를 안정적인 `LibraryError.code`로 바꾼다.

현재 스키마의 `failed` 상태 CHECK는 오류 코드가 NULL일 때 SQL의 UNKNOWN을 허용한다. `library-security.test.ts`는 관리자 INSERT도 이 상태를 거절해야 한다고 단언한다. CI에서 Red를 확인한 뒤 `metadata_error_code IS NOT NULL`을 명시해 고친다.

## 실제로 실행한 검증

| 명령 | 결과 |
| --- | --- |
| `npm test -- src/features/wishlist/link.test.ts` | 구현 전 11개 중 7개 실패. 과도한 옵션, URL 제어문자와 잘못된 Unicode가 저장되는 것을 재현했다. |
| `npm test -- src/features/library/domain.test.ts` | 명령 파서 선언만 있는 상태에서 23개 실패. 정상 명령 생성과 안정적인 검증 오류가 아직 없는 것이 원인이었다. |
| `npm test -- src/features/library/domain.test.ts src/features/wishlist/link.test.ts src/features/wishlist/model.test.ts src/features/wishlist/app-state.test.ts` | 구현 후 4개 파일, 63개 통과. |
| `npm run lint` | 통과. |
| `npm run typecheck` | 통과. |
| `npm test` | 9개 파일, 81개 통과. 부모가 작성한 실행기 설정 검사도 포함한다. |
| `npm exec -- vitest list --config vitest.database.config.ts --json` | DB 테스트 선언 목록 생성 성공. 테스트 본문이나 DB 접속은 실행하지 않았다. |

DB 테스트는 persistence 33개, service 10개, 총 43개 사례로 작성했다. 실제 실행 수와 통과 여부는 아직 확인하지 않았다. `npm run test:database`를 CI의 새 테스트 Supabase에서 실행해야 한다. DB 초기화, fixture, 인증 또는 import 실패는 Red 증거가 아니다. SQL 기능 미구현이나 명시한 불변식 위반 때문에 테스트 본문에서 실패해야 한다.

테스트는 `tests/support/database.ts`의 fixture를 사용한다. 실제 로컬 Auth 사용자와 JWT를 만들고 테스트 DB에 Google identity를 추가한다. 실제 Google OAuth 로그인을 검증하는 방식은 아니다. 매 테스트의 `afterEach`가 자신의 fixture 사용자를 DELETE하고 FK cascade로 저장 데이터를 정리한다. 서비스 테스트 전체를 롤백하는 트랜잭션은 사용하지 않는다. 초기 작업 삽입 실패 테스트만 테스트 DB에 거절 트리거를 설치하고 `finally`에서 제거해 제품 RPC의 원자성을 확인한다.

## 남은 검증

로컬 직접 PostgreSQL 접속과 권한 확대가 거절된 상태를 우회하지 않았다. SQL 마이그레이션, Auth fixture와 43개 DB 사례는 CI에서 Red와 Green을 확인해야 한다. 이 단위는 실제 웹 화면, Google OAuth, 수집 실행, 가격 갱신이나 iPhone 공유 흐름을 아직 연결하지 않는다. 수정 명령의 revision 충돌과 오래된 수집 완료 처리도 후속 명령 구현에서 검증한다. PR, 현재 head의 CI·리뷰와 실제 병합은 부모 작업이 이어서 수행한다.

Model the Domain 원칙은 구매·수집·가격을 별도 타입으로 나누는 선택에 적용했다. Boundary Discipline 원칙은 외부 입력 검증과 DB 행 변환을 경계에 모으는 선택에 적용했다. Test Behavior, Not Implementation 원칙은 실제 RPC 결과와 커밋한 행을 관찰하는 테스트에 적용했다. 관련 원칙의 설치본을 읽었으며 제공되지 않는 Cursor 모델이나 도구는 사용하지 않았다.
