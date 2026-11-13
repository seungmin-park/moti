# moti 구현 체크포인트

## 사용자 의도와 현재 범위

사용자는 2026-11-11에 현재 상태를 정리하고 중단 없이 구현을 계속하라고 요청했다. UI 피드백을 반영한 기존 Next.js·TypeScript 계획을 유지하고 실제 저장·인증·수집·가격 추적을 이어서 구현한다. 배포는 별도 승인 단계다. 대화 컨텍스트를 직접 초기화하는 도구는 없어 이 파일과 새 작업 컨텍스트로 이어간다.

- UI는 흰색·중립 회색·차콜이다. 브랜드·선택·포커스에 초록이나 세이지를 다시 넣지 않는다. 상품 사진과 오류색은 별도다.
- 정렬 메뉴는 균형 잡힌 여백과 키보드 이동을 제공한다.
- 링크 추가에서 컬렉션은 드롭다운으로 검색·복수 선택한다. 없는 이름은 즉시 생성하고 선택한다. 링크·옵션·기존 선택을 유지한다.
- 새 컬렉션은 생성 시점에 추가하므로 링크 창을 취소해도 남는다. 현재 목업은 새로고침 시 초기화된다.

## 전달 상태

소스 폴더 `/Users/seungmin/Desktop/repo/moti`는 2026-11-11 사용자 요청으로 `origin`(GitHub)에 연결한 Git 작업 트리다. 브랜치 작업과 push를 이 폴더에서 직접 한다. `/private/tmp/moti-delivery`는 이전 복사 전달용 체크아웃이며 더 이상 사용하지 않는다. 루트의 `docs/evidence/delivery.json`에는 병합 뒤 갱신한 로컬 증거가 있어 커밋하지 않은 변경으로 둔다.

- 공개 저장소는 https://github.com/seungmin-park/moti 이다.
- PR #1은 원본 cursor/plugins/pstack 프로젝트 설치, PR #2는 클릭 가능한 목업이다. 둘 다 병합됐다.
- UI 후속 PR은 https://github.com/seungmin-park/moti/pull/3 이다.
- 최신 PR head는 `4d3928e005db84cfd4676a2b8f6e312f28c95525`, base는 `617c773c4c3364736fbc57df27d361842b780440`이다.
- 최신 통합 후보는 `69cc1c5c90fb5f3463cc29a55d64f7ffb93591d1`, tree는 `577e6fe1b04f1bbd88bfe685eab432545aef90e6`이다.
- CI run `42883787163`에서 단위 33개·브라우저 40개가 통과했다. PR #3은 `2026-11-10T19:20:34Z`에 `b9b0ed063698b7b55ae26943f507bac9bb8d9103`으로 실제 병합됐다. 병합 tree가 검증한 통합 후보와 일치하며 전달 체크아웃 main은 깨끗하다.
- PR #3 당시에는 보호 규칙과 자동 병합 설정이 없었다. 사용자의 명시 요청으로 2026-11-11에 `main` 보호와 GitHub 자동 병합을 적용하고 API로 다시 읽어 확인했다. GitHub Actions app 15368의 `pstack`, `app`, `database`가 필수이며(2026-11-12에 사용자 승인으로 `mockup`을 `app`으로 바꿨다) strict base 갱신, 관리자 적용, 대화 해결, 선형 이력을 요구한다. 강제 push·branch 삭제는 금지한다. PR 경로는 필수이고 별도의 사람 승인 인원은 지정하지 않았다. 구현·독립 검토를 마친 각 기능 PR에서 squash 자동 병합을 예약하고 실제 병합을 확인한다.
- GitHub 연결 도구의 PR 생성은 통합 권한 오류여서 로그인된 `gh`를 사용한다.

첫 저장 기능은 PR https://github.com/seungmin-park/moti/pull/4 다. 초기 CI 실패 두 번은 SMTP 설정과 fixture의 identity 시각 누락이라는 환경 오류였다. fixture 수정 뒤 CI에서 RPC 미구현으로 36개 실패·7개 통과하는 실제 Red를 확인했다. 이어서 세 RPC·RLS 정책·소유자 확인을 구현했고 로컬 실제 DB에서 43개가 통과했다.

2026-11-11 기준 1단계(PR #4), 계층 리팩터링(PR #5), 2a 인증·HTTP API(PR #6), 2b 화면 연결(PR #7)이 병합됐다. 3단위는 3a(정보 수집)와 3b(이미지 사본)로 나눴다. 3a는 PR #8로 2026-11-12에 병합됐다. 2026-11-11의 CI는 러너가 Ubuntu 패키지 서버 주소를 찾지 못해 브라우저 의존성 설치에서만 실패했고, 다음 날 같은 head를 다시 실행해 통과했다. 이어서 이름이 역할과 맞지 않던 CI 작업 `mockup`을 `app`으로, Supabase 없는 브라우저 검사 `tests/e2e`·`test:e2e`를 `tests/ui`·`test:ui`로 바꿨다([변경 기록](changes/naming.md)). 3a의 로컬 전체 검증에서 단위 517개, 실제 DB 85개, 실제 HTTP 14개, 실제 스택 브라우저 16개, 브라우저 e2e 50개가 통과했다. 상세 기록은 `docs/changes/metadata.md`에 있다. 3b(비공개 사진 사본)는 PR #10(https://github.com/seungmin-park/moti/pull/10)에서 초안으로 구현했다. 테스트 스택에서 Storage를 켜고, 마이그레이션이 비공개 버킷과 `moti_storage` 정책을 만들며, 수집 실행이 사진을 복사하고, 화면이 같은 출처 경로로 사본을 보인다. 로컬 전체 검증에서 단위 615개, 실제 DB 118개(persistence 86, service 32), 실제 HTTP 18개, 실제 스택 브라우저 20개, `tests/ui` 50개가 통과했고 CI의 Linux `database` 작업에서도 Storage native가 동작했다. 상세 기록은 `docs/changes/pictures.md`에 있다. 3b는 PR #10으로 병합됐다. 4단위는 4a(상품 정리·구매 기록), 4b(내보내기·복원), 4c(추가 전용 공유 키)로 나눴다. 4a는 PR #11(https://github.com/seungmin-park/moti/pull/11)에서 초안으로 구현했다. 소유자 이름을 수집 이름과 다른 열(`owner_title`)에 두고, 다섯 RPC가 이름·메모·컬렉션 수정, 구매완료, 구매 기록, 위시 복원, 컬렉션 이름 바꾸기를 의도별로 처리하며 `revision` 충돌(`revision_conflict`, 409)을 검사한다. HTTP는 `PATCH /api/products/{productId}`와 `PATCH /api/collections/{collectionId}`이고, 화면은 위시·구매완료 보기, 카드 구매와 실행 취소, 상세 수정·구매 기록, 컬렉션 이름 바꾸기를 제공한다. 로컬 전체 검증에서 단위 804개, 실제 DB 168개(persistence 126, service 42), 실제 HTTP 23개, 실제 스택 브라우저 30개, `tests/ui` 50개가 통과했다. 상세 기록은 `docs/changes/organize.md`에 있다. 4a는 PR #11로 병합됐다(`0950309`). 4b(내보내기·복원)는 PR #12(https://github.com/seungmin-park/moti/pull/12)에서 초안으로 구현했다. `GET /api/library/backup`이 수집한 이름과 소유자 이름을 따로 담은 백업 파일을 내려주고, `POST /api/library/restore`가 화면과 같은 읽기 함수로 파일을 다시 검사한 뒤 `moti_restore_library` 한 트랜잭션으로 보관함을 바꾼다. 링크가 같은 상품과 이름이 같은 컬렉션은 id·사진·수집 값을 지키고 revision이 오른다. 화면은 사이드바·모바일 상단의 "백업과 복원" 대화상자다. 로컬 전체 검증에서 단위 953개, 실제 DB 190개(persistence 145, service 45), 실제 HTTP 30개, 실제 스택 브라우저 36개, `tests/ui` 50개가 통과했다. 상세 기록은 `docs/changes/backup.md`에 있다. 독립 검토에서 병합 전 결함은 없었고, 복원 중 화면 상태의 쓰기 차단 등 권고를 반영했다. 4b는 PR #12로 병합됐다(`cd74056`). 4c(추가 전용 공유 키)는 PR #13(https://github.com/seungmin-park/moti/pull/13)에서 초안으로 구현했다. iPhone 단축어가 `POST /api/share/links`에 `Authorization: Bearer moti_sk_…`로 링크를 보내면 전용 역할 `moti_share`가 소유한 익명 RPC `moti_share_add`가 상품과 첫 수집 작업만 넣고 담았음·이미 담음만 돌려준다. 키는 SHA-256과 끝 네 글자만 저장하고 소유자당 하나이며, 실제 화면의 "공유 저장" 보기에서 한 번만 보이고 바꾸거나 폐기한다. 키 경로는 수집할 수 없어 소유자가 보관함을 열 때 화면이 시도 0인 대기 상품을 깨운다(`POST /api/library/metadata`). 로컬 전체 검증에서 단위 1,160개, 실제 DB 234개(persistence 185, service 49), 실제 HTTP 38개, 실제 스택 브라우저 42개, `tests/ui` 50개가 통과했다. 실제 iPhone 공유 메뉴·단축어 앱, Google OAuth, 호스팅과 운영 Supabase 로그는 검증하지 않았다. 상세 기록은 `docs/changes/share.md`에 있고 독립 검토 전이다. 다음은 5단위(정기 작업)다. Supabase 리전은 서울, 요금제는 Free에서 시작하는 것을 추천했으며 사용자 결정은 아직 없다. Vercel에서의 sharp·`maxDuration` 60초는 배포 승인 뒤 확인한다. 실제 Google OAuth와 운영 Supabase 설정은 아직 검증하지 않았다.

## 확인된 UI 검증

lint·typecheck·build 통과. 순수 단위 33개와 최종 headed Playwright 40개가 통과했다. PC Chromium과 iPhone 크기 WebKit에서 실행했다. 실제 iPhone·물리 IME는 미검증이다. 두 화면 크기의 28개 상태에서 초록 UI 스타일·가로 넘침·페이지 오류가 없고 정렬 메뉴·컬렉션 선택 창의 axe 위반은 0개다. 상세 증거는 `docs/changes/controls.md`와 `docs/evidence/controls`에 있다.

최신 프로덕션 미리보기는 `http://localhost:3105`다. 검증 때 3101을 새 서버로 사용하며 기존 프로세스를 재사용하지 않는다. 새 build 후에는 새 프로덕션 포트를 사용한다. 과거 서버의 종료가 승인 정책상 거절된 적이 있으므로 거절된 종료를 다른 수단으로 우회하지 않는다. cmux와 컴퓨터 사용 브라우저 호스트를 사용할 수 없어 로컬 headed Playwright를 사용했다.

## 구조와 작업 방식

`src/features/wishlist/model.ts`가 도메인 규칙을 소유한다. `app-state.ts`는 모달과 추가 창 선택 ID를 소유하는 순수 reducer다. `CollectionPicker`는 열림·검색·초점을 소유한다. 생성과 선택은 앱 reducer 한 번의 전환으로 처리한다. 드롭다운의 바깥 클릭은 원래 이벤트 경로로 판단하며 IME 키는 기본 동작을 취소하지 않는다.

전역 지침과 저장소 AGENTS를 따른다. 비단순 작업은 agent-engineering과 설치된 pstack을 사용한다. pstack 원본 파일은 수정하지 않는다. 두 설계 비교 후 선택한 구조를 구현 담당자 한 명에게 위임하고, 파일 소유권을 명시한다. 새 작업은 기본적으로 새 에이전트에서 수행한다. Cursor 지정 모델과 전용 도구는 없으므로 같은 제공 모델을 사용한 사실을 밝힌다.

동작은 Red → Green → Refactor다. 환경·문법·누락 import 오류를 Red로 세지 않는다. Domain은 순수 단위, Persistence는 전체 앱 없이 실제 PostgreSQL을 쓰는 슬라이스, Service는 실제 저장소를 쓰고 테스트 트랜잭션 자동 롤백 없이 `afterEach`로 삭제한다. 제품 원자성을 위한 트랜잭션은 허용한다. Handler Mock은 Given–When–Then, HTTP는 실제 요청, API 문서·계약 일치는 CI로 검증한다.

기능 단위의 구현·로컬 검증·PR·CI·리뷰·실제 병합까지 기본 승인 범위다. 배포와 필요한 외부 계정 설정은 별도다. 권한 거절을 우회하지 않는다.

## 다음 구현의 인수 기준

1. Supabase PostgreSQL·Auth·비공개 Storage를 사용한다. 지정한 Google 계정 하나만 허용하고 설정이 없으면 접근을 허용하지 않는다.
2. 링크를 먼저 영구 저장한다. 구조화 데이터·Open Graph 수집은 분리하고 실패해도 원본 링크를 보존한다. 옵션을 보존한 중복 처리와 이미지 사본을 구현한다.
3. 위시·구매완료·메모·컬렉션과 내보내기·복원을 영구 저장에 연결한다.
4. iOS 공유 추가 전용 키는 해시로 저장하고 폐기할 수 있어야 한다. 웹 로그인 권한과 분리한다.
5. 외부 URL의 사설망·루프백·메타데이터 주소, DNS 재바인딩과 리다이렉트 우회를 차단한다. 크기·시간·리다이렉트·재시도 한도를 둔다.
6. 지원하는 위시 상품을 하루 한 번 확인한다. 같은 옵션·통화·가격 조건만 비교한다. 실패 시 이전 가격과 확인 시각을 유지하고 구매완료 시 중단한다.
7. GitHub Actions는 한국 시간 06:17·14:17·22:17에 인증된 정기 작업을 호출한다. DB 점검·미완료 수집·가격 갱신, 제한된 재시도·중복 실행 방지·실패 기록을 포함한다. 무료 한도·예약 실행 가용성을 보장하지 않는다.
8. 가격 알림·내부 상품 발견·공개 공유·주문 자동 연동은 제외한다.

## 현재 외부 연동 준비 상태

프로젝트의 `.env*` 파일과 Supabase·Google·Vercel·DATABASE_URL 환경변수는 없다. Docker CLI는 `/usr/local/bin/docker`에 있다. psql·postgres·pg_ctl·Supabase·Vercel CLI는 경로에 없다. 실제 계정·클라우드 배포·기기 검증에 필요한 정보는 코드와 로컬 검증이 준비된 뒤 구체적으로 정리한다. 비밀 값이나 실제 상품 데이터는 공개 저장소에 넣지 않는다.

Docker는 사용하지 않는다. 공식 Supabase CLI 3.1.0 native runtime으로 `npm run test:database`가 로컬에서 실제 PostgreSQL·PostgREST·Auth를 띄워 실행된다. 이전의 "직접 연결 불가" 기록은 실행기의 macOS 임시 경로 불일치를 잘못 진단한 것이었다. CI도 같은 명령을 필수로 실행한다. 설계와 책임 경계는 `backend-implementation.md`에 있다.
