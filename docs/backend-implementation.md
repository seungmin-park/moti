# 실제 기능 구현 순서

## 완료 판정

허용한 Google 계정으로 링크를 저장한 뒤 새 세션에서도 원본·옵션·메모·컬렉션·구매 기록을 읽을 수 있어야 한다. 정보 수집 실패에도 링크가 남고, 비허용 계정·폐기한 추가 키·사설망 URL은 거절돼야 한다. 복원은 유효하지 않은 파일에서 데이터를 일부만 바꾸지 않아야 한다. 가격 갱신은 비교 가능한 위시 상품만 처리하고 실패 때 이전 값을 보존해야 한다. 각 기능의 실제 DB·HTTP·화면 검사와 현재 PR의 CI·병합 증거로 판정한다.

배포와 실제 Google 계정·Supabase 프로젝트·iPhone 공유 메뉴 검증은 외부 설정이 필요한 최종 단계다. 비밀 값이 없다는 이유로 인증을 우회하거나 목업 저장을 영구 저장으로 보고하지 않는다.

## pstack 실행 순서

- [x] poteto-mode의 Principles와 figure-it-out을 읽는다.
- [x] Frame. 기존 UI 33개 단위·40개 브라우저 검사와 PR #3 병합을 기준선으로 고정한다.
- [x] Design the workflow. 직접 SQL 트랜잭션과 Supabase SDK·RPC를 비교하고 SDK·RPC를 선택한다. 아래의 저장 경계와 최초 단위를 따른다.
- [x] Run the loop. 아래 기능 단위마다 Red → Green → Refactor와 실제 병합까지 확인한다. 5c(PR #16, `d63f86d`)로 모든 단위가 병합됐다.
- [x] Keep the audit trail. 중요한 결정과 검증 근거를 `backend-decisions.tsv`에 계속 추가한다.
- [x] Verify and hand back. 전체 실제 사용자 흐름과 외부 설정·배포 승인 항목을 구체적으로 정리한다. [인계 문서](hand-back.md)에 있다. 배포와 실제 기기 검증은 승인 뒤 남은 단계다.

## 기능 단위

| 순서 | 결과 | 검증과 경계 |
| --- | --- | --- |
| 1 | 영구 저장 모델·마이그레이션·저장소·서비스 | 실제 PostgreSQL 슬라이스, 고유 제약·원자성·권한·수정 충돌, 서비스 `afterEach` 삭제. 전체 웹 앱 없이 실행한다. |
| 2a | Google 단일 계정 인증·HTTP API | 아래 "인증과 HTTP 경계". 화면 연결은 2b로 분리한다. |
| 2b | 실제 화면 연결 | 허용·거절·설정 누락, BDD handler Mock, 실제 HTTP 요청, 실행 계약과 API 문서 일치, 재접속 후 데이터 유지. 기존 UI는 `/demo`에서도 검토할 수 있게 보존한다. |
| 3a | 링크 우선 저장 뒤 안전한 비동기 정보 수집 | 저장 직후 응답, 지속되는 작업·재시도·실패, SSRF와 리다이렉트/DNS 검증, 크기·시간 제한, 지원 페이지 실제 검증. 기록은 [changes/metadata.md](changes/metadata.md). |
| 3b | 비공개 이미지 사본 | 같은 수집 실행에서 사진을 같은 안전 경로로 받아 바이트로 판별하고 sharp로 WebP로 다시 만든 뒤 소유자 토큰으로 비공개 Storage에 저장한다. 화면은 같은 출처 경로가 만드는 짧은 서명 주소로 표시한다. [변경 기록](changes/pictures.md) |
| 4a | 상품 정리·구매 기록 | 이름·메모·컬렉션 수정, 구매완료와 실행 취소, 구매일·실구매가(빈 값과 0원 구분), 위시 복원, 컬렉션 이름 바꾸기, 위시·구매완료 보기. SQL이 의도별 전환과 revision 충돌을 정하고 메모·컬렉션은 모든 구매 전환에서 남는다. [변경 기록](changes/organize.md) |
| 4b | 내보내기·복원 | 4a까지 저장한 모든 값(소유자 이름 `owner_title` 포함)의 왕복 보존, 잘못된 복원 입력의 원자적 거절. 파일 하나(`moti.library-backup` v1)를 화면과 서버가 같은 읽기 함수로 검사하고, SQL 함수 하나가 한 트랜잭션에서 보관함을 바꾼다. 링크가 같은 상품과 이름이 같은 컬렉션은 id·사진을 지킨다. [변경 기록](changes/backup.md) |
| 4c | 추가 전용 공유 키 | 키 해시·권한 제한·폐기, 로그인 권한과 분리. |
| 5a | 인증된 예약 작업과 정기 수집 | 전용 작업 키(해시만 저장, 화면에서 교체·폐기)와 전용 역할 `moti_worker`, DB 실행 임대·중복 실행 방지·하루 8번·30일 실행 기록, 소유자와 나누는 시도 세 번, 한국 시간 3회 예약 호출(값을 넣기 전에는 건너뜀). 작업자는 Storage에 닿지 않고 사진은 소유자가 열 때 복사한다. [변경 기록](changes/scheduled-runs.md) |
| 5b | 일일 가격 확인 | 같은 예약 실행에서 수집 다음에, 수집이 끝난 위시 상품을 서울 날짜 하루 한 번(확인한 적 없는 것, 가장 오래전 확인부터) 확인한다. 페이지에 하나뿐인 가격이고 저장한 통화와 같을 때만 바꾸고, 실패·다른 통화·여러 가격은 이전 가격과 시각을 지키며 이유를 남긴다. 고른 뒤 구매완료로 옮긴 상품은 쓰지 않고, 이름·소유자 이름·사진은 건드리지 않는다. 상세가 지킨 가격을 날짜와 이유로 알린다. [변경 기록](changes/price-check.md) |
| 5c | 남은 사진 정리 | 화면이 보관함을 처음 받을 때마다 깨우고, 그 응답 뒤 소유자 토큰으로 어떤 상품도 쓰지 않고 수집 중인 작업의 이번 시도도 아닌 10분 지난 사본을 200개까지 지운다. 소유자 RPC `moti_picture_orphans`가 이름만 돌려주고 Storage의 `may_discard`가 다시 확인한다. 작업자는 Storage에 닿지 않는다. [변경 기록](changes/picture-sweep.md) |

총 다섯 기능 단위로 시작했고, 3단위는 외부 요청 경계가 페이지와 이미지 두 곳이라 3a·3b로 나눴다. 4단위는 정리·구매 기록, 내보내기·복원, 공유 키가 서로 다른 경계(소유자 쓰기, 전체 데이터 왕복, 로그인과 분리한 권한)라 4a·4b·4c로 나눴다. 5단위는 예약 작업과 수집(5a), 가격 확인(5b), 사진 정리(5c)로 나눴다. 각각 경계(새 자격과 역할, 가격 규칙, 소유자 세션의 Storage 정리)가 달라 따로 검증한다. 상품 삭제와 컬렉션 삭제는 목업에 없어 어느 단위에도 넣지 않았다. 설계에서 독립적으로 검증하기 어려운 경계가 발견되면 그 근거를 남겨 단위를 조정한다. 인증·외부 URL·복원·정기 작업은 데이터와 권한을 다루므로 실패 조건을 우선 검증한다. UI 스타일 변경은 기존 화면 회귀로 검증한다.

## 병렬 작업과 공유 상태

초기 두 설계 작업은 대화 이력 없는 새 작업 컨텍스트에서 읽기 전용으로 진행한다. 선택 후 하나의 기능 구현 담당자가 해당 소스·테스트를 소유한다. 조정자는 독립 실행, 문서·CI·Git 전달을 담당한다. 같은 파일이나 DB 데이터를 동시에 수정하지 않는다. 기능 사이에는 실제 병합 상태와 체크포인트를 넘기고 새 구현 컨텍스트를 사용한다.

운영 DB는 원래 계획의 Supabase PostgreSQL이다. 로컬 PostgreSQL은 격리된 테스트를 위한 실행 환경이다. Docker는 필수 의존성이 아니며 현재 소켓 접근 거절을 우회하지 않는다. 공식 Supabase CLI 3.1.0의 native runtime으로 실제 서비스를 기동했고 Auth health의 HTTP 200을 확인했다. 로컬 DB 테스트는 실행기의 macOS 경로 수정 뒤 정상 실행된다. CI의 실제 Supabase에서도 마이그레이션·RPC·권한 검증을 필수로 실행한다. 환경 오류를 Red로 세지 않는다.

## 선택한 저장 경계

직접 SQL 방식은 TypeScript에 트랜잭션을 집중할 수 있지만 Vercel의 연결 풀과 별도 런타임 DB 자격증명을 관리해야 한다. Supabase SDK·RPC 방식은 운영과 테스트가 같은 HTTP 저장 경계를 사용하며 원자적인 명령만 SQL 함수에 둔다. 후자를 선택한다. Docker 사용 여부는 선택 근거가 아니다. native runtime의 RPC·RLS 검증은 완료 조건으로 남아 있다.

`src/features/wishlist/link.ts`는 순수 링크·옵션 정규화를 소유하고 기존 목업과 실제 서비스가 함께 사용한다. `src/features/library/domain/library.ts`는 영구 상품·컬렉션·수집 상태 타입을 소유한다. 실패 상태와 마지막 성공 가격은 서로 독립적이다. `application/commands.ts`가 입력을 검증해 `LinkSaveCommand`·`CollectionCreateCommand`를 만들고, `application/library-service.ts`가 명령을 저장소 포트에 전달한다. `infrastructure/supabase-library-store.ts`는 SDK/RPC와 도메인 사이의 유일한 저장 어댑터다. 화면과 Route Handler에는 DB 행을 노출하지 않는다. 계층과 이름 규칙은 [architecture.md](architecture.md#계층과-데이터-객체)를 따른다.

첫 단위의 공개 연산은 `snapshot()`, `saveLink({ url, option, collectionIds })`, `createCollection(name)`이다. `saveLink`는 `{ kind: "added" | "duplicate", product }`를 반환한다. DB 함수는 상품·선택 컬렉션·수집 대기 작업을 함께 커밋한다. 같은 링크·옵션은 동시 요청에도 하나만 남으며 기존 메모·컬렉션을 변경하지 않는다. 긴 URL은 전체 문자열을 고유 인덱스로 삼지 않고 SHA-256 식별자를 사용하고 충돌 시 원문을 비교한다.

테이블은 비공개 `moti` 스키마에 둔다. 공개 스키마에는 필요한 RPC만 노출한다. 익명 함수 실행은 취소한다. 예외는 두 묶음이다. iPhone 공유 단축어의 `public.moti_share_add`(4c)와 예약 실행의 작업 단계 `public.moti_worker_begin`·`moti_worker_next`·`moti_worker_complete`·`moti_worker_fail`·`moti_worker_finish`(5a)와 매일 가격 확인의 `public.moti_worker_price`(5b)만 `anon`이 실행하고 `authenticated`는 실행하지 못한다. 작업 단계는 전용 역할 `moti_worker`(로그인 불가, 상속 없음, RLS 우회 없음, 구성원은 `postgres`뿐)가 소유하고, 그 역할의 권한(소유자 설정 읽기, 자기 활성 작업 키와 실행 행, 수집 작업과 상품의 이름 붙은 열, 가격 확인의 두 열, 제약조건 검사 함수)을 `tests/persistence/worker-runs.test.ts`가 정확한 목록으로 고정한다. 익명이 실행하는 전체 목록은 `tests/persistence/share-add.test.ts`가 고정한다. `moti_share_add`는 전용 역할 `moti_share`(로그인 불가, 상속 없음, RLS 우회 없음)가 소유한다. 그 역할의 권한은 소유자 설정 읽기, 자기 활성 키 찾기와 사용 기록, 중복 확인에 필요한 상품 열 읽기, 상품과 첫 수집 작업 넣기, 링크 추가와 제약조건 검사 함수 실행뿐이고 catalog 테스트(`tests/persistence/share-add.test.ts`)가 정확한 목록을 고정한다. 키 확인·링크 검사·사용 한도는 PostgREST로 직접 불러도 지켜지도록 모두 SQL에 있다. RPC 소유 역할은 테이블 소유자와 다르고 RLS 우회 권한이 없다. 소유자 설정 누락·비허용 사용자·잘못된 컬렉션은 쓰기를 남기지 않는다. 지정 소유자는 운영자가 명시적으로 설정하며 첫 가입자를 자동 등록하지 않는다.

## 첫 단위 작업 분리

- Blocking first steps. 기존 33개 단위·40개 브라우저 검사를 보존하고 실제 Supabase 테스트 실행기를 먼저 준비한다.
- Independent workstreams. 구현 담당자는 공유 순수 규칙·저장 소스·마이그레이션·해당 테스트를 소유한다. 조정자는 의존성·CLI 설정·테스트 실행기·CI·문서·Git 전달을 소유한다.
- Shared mutable state. 테스트 스택은 하나를 순차 사용한다. 테스트는 자신의 fixture만 `afterEach`로 삭제한다. 운영 주소를 받으면 실행기가 거절한다.
- Smallest safe decomposition. 저장 명령과 제약조건은 하나의 담당자가 구현한다. 부모와 독립 검토자가 실제 결과·권한·동시성을 확인한다. 이 단위를 검증·병합한 뒤 인증·화면 연결로 넘어간다.

## 인증과 HTTP 경계

허용 판정은 `auth/domain/access.ts`의 `decideAccess` 하나가 결정한다. 소유자 subject가 비었으면 누구도 허용하지 않는다(`unconfigured`). 세션이 없으면 `signed_out`, Google identity 중 소유자 subject가 없으면 `forbidden`이다. 앱은 `MOTI_OWNER_GOOGLE_SUBJECT`로 판정하고, DB는 `moti.owner_config`로 데이터 접근을 다시 막는다. 두 값이 어긋나면 DB가 거절하고 API는 403과 세션 종료로 응답한다. 앱 설정만으로 데이터가 열리지 않게 하려는 이중 경계다.

Route Handler는 `src/app`에서 의존 객체를 조립한다. 쓰기 요청은 `Origin`의 host가 `x-forwarded-host` 또는 `Host`와 같아야 한다. Next가 Route Handler에 넘기는 `request.url`은 내부 주소(`localhost`)일 수 있어 쓰지 않는다. 이 차이는 실제 HTTP 테스트에서 발견했다. 본문은 `application/json`, 16KiB 이하만 받는다. 모든 응답은 `no-store`다.

허용하지 않은 계정은 세션을 종료한다. Supabase는 로그인 시 refresh 세션을 폐기하므로 같은 쿠키의 다음 요청은 401이다. 이 동작은 실제 HTTP 테스트가 확인한다.

운영 설정과 남은 위험:

- Supabase Auth에서 Google provider를 켜고 이메일·비밀번호 로그인은 끈다. Redirect URL에 `<배포 주소>/auth/callback`을 등록한다.
- 처음 로그인한 소유자의 Google subject를 `MOTI_OWNER_GOOGLE_SUBJECT`와 `moti.owner_config`에 넣는다. 운영자가 직접 설정한다. subject가 비어 있으면 `/auth/login`이 Google 로그인을 시작하지 않는다. 그래서 첫 로그인 전에는 임시 값을 둔다. 순서는 [인계 문서](hand-back.md)의 "소유자 지정"에 있다.
- 현재는 다른 Google 계정도 Supabase에 사용자 행이 생긴다. 데이터 접근과 세션은 막지만 행 생성 자체를 막으려면 Auth의 사용자 생성 전 hook이 필요하다. 별도 작업으로 남긴다.
- `/login` 화면과 실제 보관함 화면은 2b에서 연결했다. 화면 구조와 선택 근거는 [architecture.md](architecture.md#실제-보관함-화면)에 있다.
