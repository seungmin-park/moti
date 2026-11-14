# 인계: 실제 사용자 흐름과 외부 설정

기능 단위 1~5c의 구현과 병합이 끝났다. 기준은 `main`의 `d63f86d`(PR #16)이다. 이 문서는 pstack 순서의 마지막 단계(Verify and hand back)다. 세 가지를 정리한다. 완료 판정의 근거, 소유자가 실제로 겪을 흐름과 각 흐름을 어디까지 검증했는지, 배포 전에 필요한 외부 설정과 승인 항목이다.

검증은 모두 로컬과 CI에서 했다. 로컬과 CI 모두 격리된 native Supabase 스택(PostgreSQL·PostgREST·Auth·Storage)과 빌드한 앱을 쓴다. 로그인은 로컬 Auth 세션이고, iPhone은 iPhone 크기 WebKit이다. 실제 Google OAuth, 실제 iPhone, 운영 Supabase, 호스팅은 한 번도 확인하지 않았다. GitHub 예약은 값을 넣기 전의 건너뛰기만 한 번 관찰했다. 배포와 외부 계정 설정은 별도 승인 대상이다.

## 완료 판정

[backend-implementation.md](backend-implementation.md#완료-판정)의 기준과 그 근거다. PR #16 head의 로컬 전체 검증과 CI 결과는 단위 1,385개, 실제 DB 333개(persistence 276, service 57), 실제 HTTP 46개, 실제 스택 브라우저 50개, `tests/ui` 50개다. 각 PR의 병합 증거는 [verification.md](verification.md)와 변경 기록에 있다.

| 기준 | 근거(대표 검사) | 남은 확인 |
| --- | --- | --- |
| 허용한 Google 계정으로 저장한 링크와 원본·옵션·메모·컬렉션·구매 기록을 새 세션에서도 읽는다 | `tests/http/library-api.test.ts`(다시 로그인한 새 세션), `tests/http/library-organize.test.ts`, `tests/browser/library-screen.spec.ts`·`library-organize.spec.ts`(새로고침과 새 세션) | 실제 Google 로그인 |
| 정보 수집이 실패해도 링크가 남는다 | `tests/http/metadata-collection.test.ts`(막힌 주소를 기록해도 링크는 남음, 다시 가져오기) | 실제 쇼핑몰 |
| 비허용 계정·폐기한 추가 키·사설망 URL을 거절한다 | `tests/http/library-api.test.ts`(다른 Google 계정 403과 세션 폐기), `tests/http/share-links.test.ts`(폐기한 키 401), `tests/fetcher/safe-fetch.test.ts`·`safe-image.test.ts`(사설 주소·리디렉션·DNS) | 실제 Google의 다른 계정 |
| 유효하지 않은 복원 파일은 보관함을 일부도 바꾸지 않는다 | `tests/http/library-backup.test.ts`(바뀐 파일 거절), `tests/persistence/library-restore.test.ts`(DB가 전체를 먼저 검사, 잠금 시간 초과) | 호스팅의 응답 한도 |
| 가격 갱신은 비교 가능한 위시 상품만 처리하고 실패 때 이전 값을 지킨다 | `tests/persistence/worker-price.test.ts`(구매완료·수집 전 상품 제외, 다른 통화·실패는 이전 가격과 시각 유지), `tests/service/scheduled-run.test.ts` | GitHub 예약 실행, 실제 쇼핑몰 |

## 소유자의 흐름과 검증 범위

"로컬·CI"는 위의 실제 스택에서 확인했다는 뜻이다. "확인 안 함"은 배포 뒤에만 확인할 수 있다.

1. **로그인.** `/login`에서 Google로 로그인하면 `/auth/callback`이 세션을 만든다. 앱은 `MOTI_OWNER_GOOGLE_SUBJECT`로, DB는 `moti.owner_config`로 소유자를 다시 확인한다. 다른 계정은 403을 받고 세션이 끝난다. 설정이 없으면 아무도 들어오지 못한다. 로컬·CI는 Auth 세션 쿠키로 확인했다. 실제 Google 동의 화면과 리디렉션은 확인 안 함.
2. **링크 담기와 수집.** 링크를 담으면 곧바로 "정보 수집 대기"로 저장된다. 응답 뒤 서버가 이름·가격·사진을 가져온다. 사설망 주소와 리디렉션 우회는 막는다. 실패해도 링크는 남고 "다시 가져오기"가 있다. 로컬·CI는 로컬 페이지 서버로 확인했다. 실제 쇼핑몰은 `node scripts/check-real-pages.mjs <url...>`로 따로 확인한다. 데이터센터 IP를 막는 쇼핑몰은 확인 안 함.
3. **사진.** 쇼핑몰 사진을 바이트로 판별하고 sharp로 WebP를 다시 만든다. 그 결과는 비공개 Storage(`product-pictures`)에 둔다. 화면은 같은 출처 경로가 만드는 짧은 서명 주소로 보인다. 로컬·CI에서 확인했다. 호스팅 함수에 sharp가 포함되는지와 메모리는 확인 안 함.
4. **정리와 구매 기록.** 이름·메모·컬렉션을 고치고 구매완료·실행 취소·위시로 되돌리기를 쓰고, 구매일과 실구매가를 남긴다. 로컬·CI에서 확인했다.
5. **백업과 복원.** 파일 하나(`moti.library-backup` v1)로 내려받고 되돌린다. 잘못된 파일은 아무것도 바꾸지 않는다. 로컬·CI에서 확인했다. 실제 iPhone의 내려받기와 파일 선택, 호스팅의 응답 크기 한도는 확인 안 함.
6. **iPhone 공유 단축어.** "공유 저장"에서 저장 키를 만들고, 화면의 다섯 동작으로 단축어를 만든다. 단축어는 Safari나 쇼핑 앱의 공유 메뉴에서 `POST /api/share/links`로 링크만 담는다. 키는 링크 추가만 할 수 있고 화면에서 바꾸거나 폐기한다. 로컬·CI는 같은 요청을 HTTP로 보내 확인했다. 단축어 앱의 동작 이름, 공유 메뉴, 쇼핑 앱이 넘기는 값은 확인 안 함.
7. **자동 확인.** "자동 확인"에서 작업 키를 만들어 GitHub에 넣으면 하루 세 번(서울 06:17·14:17·22:17) 예약 실행이 `POST /api/scheduled-runs`를 부른다. 실행은 남은 수집을 먼저 하고, 수집이 끝난 위시 상품의 가격을 서울 날짜로 하루 한 번 확인한다. 화면은 최근 실행 다섯 개와 26시간 넘게 실행이 없을 때의 알림을 보인다. 로컬·CI는 같은 요청과 스크립트(`tests/service/scheduled-run.test.ts`, `tests/http/scheduled-runs.test.ts`)로 확인했다. GitHub는 `main`의 예약으로 워크플로를 한 번 실행했다(2026-11-14T01:27:47Z, run 43540729861). 값을 넣기 전이라 건너뜀 알림만 남겼다. 값을 넣은 실제 실행, 예약의 지연·누락, 60일 비활성 정지는 확인 안 함. 수동 실행은 하지 않았다.
8. **moti를 열 때.** 화면은 보관함을 처음 받을 때마다 깨우기를 보낸다. 서버는 응답 뒤 다음 세 가지를 한다. 아무도 시작하지 않은 수집(단축어로 담은 상품 등)을 시작하고, 예약 실행이 남긴 사진을 복사하고, 어떤 상품도 쓰지 않는 사진 사본을 200개까지 지운다. 로컬·CI에서 확인했다. 운영 Storage의 정책 평가와 호스팅의 `after()`가 60초 안에 끝나는지는 확인 안 함.

## 외부 설정과 배포

아래 순서대로 진행한다. "승인"이 붙은 단계는 사용자가 결정하거나 승인해야 한다. 비밀 값은 저장소에 넣지 않는다. 서비스 역할 키는 앱에 넣지 않는다(코드가 쓰지 않는다).

### 1. Supabase 프로젝트 (승인: 리전·요금제)

- 프로젝트를 만든다. 서울 리전과 Free 요금제로 시작하기를 추천했다. 무료 한도와 비활동 정지는 Supabase 정책을 따르고, moti는 가용성을 보장하지 않는다.
- 저장소의 마이그레이션 아홉 개를 적용한다(운영 DB 쓰기, 승인 필요). 예: `npx supabase link --project-ref <ref>` 뒤 `npx supabase db push`. 마이그레이션이 비공개 버킷 `product-pictures`, Storage 정책, 역할(`moti_rpc`·`moti_share`·`moti_worker`)과 RPC를 만든다.
- Data API의 노출 스키마에 `moti`를 더하지 않는다. 앱은 `public`의 RPC만 부른다.
- 배포 전에 확인한다. 운영 프로젝트가 RPC 인자(공유 키·작업 키의 평문)를 Postgres·API 로그에 남기는지(4c·5a의 열린 항목), `authenticated` 문 시간 제한이 복원의 5초 잠금 대기보다 긴지(로컬은 8초)를 본다.

### 2. Google 로그인 (승인: Google Cloud 계정)

- Google Cloud에서 OAuth 클라이언트(웹 애플리케이션)를 만든다. 승인된 리디렉션 URI에는 Supabase의 콜백(`https://<project-ref>.supabase.co/auth/v1/callback`)을 넣는다.
- Supabase Auth의 Providers에서 Google을 켜고 클라이언트 ID와 비밀을 넣는다. 이메일·비밀번호 로그인과 익명 로그인은 끈다. 로컬 테스트 스택(`supabase/config.toml`)은 가입과 익명 로그인을 닫는다. 대신 관리 API로 만든 사용자의 Auth 세션을 쓰려고 이메일 로그인은 켜 둔다. 이 설정은 운영에 옮기지 않는다.

### 3. 호스팅 (승인: 배포)

원래 계획은 Vercel이다. 다른 호스팅이어도 아래 조건을 확인한다.

- 저장소를 연결하고 Node 24로 빌드한다(`npm run build`).
- 환경변수는 셋이고 모두 서버 전용이다. `NEXT_PUBLIC_`를 붙이지 않는다.
  - `SUPABASE_URL`: 프로젝트 주소
  - `SUPABASE_ANON_KEY`: anon(publishable) 키
  - `MOTI_OWNER_GOOGLE_SUBJECT`: 처음에는 비운다. 5단계에서 넣는다.
- 배포한 뒤 Supabase Auth의 URL 설정에서 Site URL을 배포 주소로 바꾸고, Redirect URLs에 `<배포 주소>/auth/callback`을 더한다.
- 배포 뒤 확인할 것
  - 함수에 sharp가 포함되는지, `maxDuration = 60`이 요금제에서 허용되는지, `after()`가 응답 뒤 끝까지 도는지(수집·복원·깨우기 경로)
  - 단축어(`/api/share/links`)와 예약 실행(`/api/scheduled-runs`)은 브라우저 세션 없이 `Authorization` 헤더로 부른다. 배포 보호(로그인 요구)가 이 두 POST를 막지 않는지, 프록시가 헤더를 앱까지 넘기는지 본다. 미리보기 배포는 주소가 달라 단축어와 GitHub에 넣지 않는다.
  - 응답 크기 한도(Vercel 4.5MB)를 넘는 보관함은 내려받기가 실패할 수 있다([backup.md](changes/backup.md)).

### 4. 소유자 지정 (승인: 운영 DB 쓰기)

1. Supabase Auth에서 새 가입을 잠시 허용한다.
2. 소유자가 배포 주소에서 Google로 한 번 로그인한다. 아직 설정 전이라 앱은 들여보내지 않지만 Auth에 사용자 행이 생긴다.
3. SQL 편집기에서 소유자의 Google subject를 찾는다. `select user_id, provider_id, email from auth.identities where provider = 'google';`
4. `insert into moti.owner_config (owner_id, google_subject) values ('<user_id>', '<provider_id>');`로 DB의 소유자를 정한다.
5. 호스팅의 `MOTI_OWNER_GOOGLE_SUBJECT`에 같은 `provider_id`를 넣고 다시 배포한다. 두 값이 다르면 DB가 거절하고 API는 403이다.
6. 새 가입을 다시 끈다. 끄면 다른 Google 계정이 Auth에 사용자 행을 만들지 못할 것으로 본다. 실제 프로젝트에서 확인한다. 끄지 않아도 데이터와 세션은 막히지만, 행은 생긴다.
7. 소유자로 다시 로그인해 보관함이 열리는지, 다른 Google 계정이 403과 로그아웃으로 끝나는지 확인한다.

### 5. 실제 흐름 확인

- 대표 쇼핑몰 링크 몇 개를 담아 이름·가격·사진이 들어오는지 본다. 먼저 로컬에서 `node scripts/check-real-pages.mjs <url...>`로 결과를 기록한다. 막힌 쇼핑몰은 통과가 아니다.
- 정리·구매 기록, 백업 내려받기와 같은 파일의 복원을 한 번씩 왕복한다.
- PC와 실제 iPhone Safari에서 화면을 연다.

### 6. iPhone 공유 단축어

- "공유 저장"에서 저장 키를 만든다. 키는 한 번만 보인다.
- 화면에 적힌 다섯 동작과 배포 주소로 단축어를 만들고 키를 넣는다. 동작 이름은 기기에서 확인하지 않았다고 화면에도 적혀 있다.
- Safari와 쇼핑 앱에서 공유해 보관함에 담기는지 본다. 폐기한 키는 401로 거절되는지도 본다. 담긴 상품의 수집은 moti를 열 때 시작한다.

### 7. 예약 실행 (승인: GitHub 비밀값·변수)

- "자동 확인"에서 작업 키를 만든다.
- 저장소의 Settings → Secrets and variables → Actions에서 두 값을 넣는다.
  - 비밀값 `MOTI_WORKER_TOKEN`: 작업 키
  - 변수 `MOTI_WORKER_URL`: `https://`로 시작하고 경로가 없는 운영 배포 주소
- 두 값을 넣기 전에는 워크플로가 아무것도 하지 않고 건너뛴다. 다음 예약 시각 뒤 "자동 확인"의 최근 실행에 기록이 생기는지 본다. 수동 실행(`workflow_dispatch`)은 별도 승인 뒤에만 한다.
- 공개 저장소의 Actions 로그에는 시각과 성공 여부만 남고 셈·이유·링크·이름은 남지 않는다.

## 후속 과제

모두 기록만 하고 구현하지 않았다. 자세한 내용은 각 변경 기록의 "남은 범위"에 있다.

- 열어 둔 탭은 단축어로 담은 상품과 예약 실행의 결과를 새로고침해야 보인다. 화면이 다시 보일 때 다시 읽고 깨우는 일은 후속이다([share.md](changes/share.md)).
- 다른 Google 계정의 Auth 사용자 행. 4단계의 가입 닫기로 충분한지 확인하고, 부족하면 Auth의 사용자 생성 전 hook을 둔다.
- 작업 키 분리. 지금은 GitHub 비밀값 하나가 작업 키다. 키를 호스팅 환경변수에 두고 GitHub에는 실행 신호만 두면 유출 범위가 줄지만 키를 바꿀 때마다 다시 배포해야 한다.
- 예약 실행이 읽은 페이지를 소유자가 열 때 사진 때문에 한 번 더 읽는다([scheduled-runs.md](changes/scheduled-runs.md)).
- 링크가 다른 상품 페이지로 넘어가면 그 페이지의 같은 통화 가격을 쓴다. 작업자 수집이 지킨 가격의 셈, 이유 줄 합치기, 서울 자정에 걸치는 DB 검사([price-check.md](changes/price-check.md))도 후속이다.
- 완료 뒤 서명 업로드로 바뀐 사본은 상품이 가리켜 남는다. 쌓인 사본은 열 때마다 200개씩 줄어든다([picture-sweep.md](changes/picture-sweep.md)).
- 응답 뒤 작업(`after()`)의 실패는 어디에도 기록하지 않는다.
- 상품 삭제와 컬렉션 삭제는 목업에 없어 만들지 않았다. 유출된 키로 담긴 링크는 복원으로만 지울 수 있다.
- 4MiB를 넘는 보관함은 한 번에 복원할 수 없다.

5a의 남은 범위에 있던 "정리(5c 전까지)"와 "가격(5b 전까지)"은 5b·5c에서 끝났다.
