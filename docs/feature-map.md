# 기능 지도

세 화면 경로가 있다. `/`는 허용한 Google 계정의 실제 보관함이다. `/login`은 로그인 진입과 실패 안내다. `/demo`는 예시 데이터 목업이며 상태가 새로고침할 때 초기화된다. 실제 보관함은 상품 이름·가격과 사진 사본을 수집하고, 소유자가 상품을 정리하고 구매를 기록하며, 보관함을 파일로 내려받고 그 파일로 복원한다. iPhone 공유 단축어가 추가 전용 저장 키로 링크를 담는다. GitHub Actions가 전용 작업 키로 하루 세 번 아직 가져오지 못한 상품 정보를 가져오고, 위시 상품의 가격을 서울 날짜 하루 한 번 다시 확인한다(소유자가 GitHub에 값을 넣은 뒤). 소유자가 보관함을 열 때마다 어떤 상품도 쓰지 않는 사진 사본을 지운다.

## 실제 보관함 (`/`, `/login`)

| 사용자 동작 | 진입점과 관찰 결과 | 상태 소유자 | 검증 |
| --- | --- | --- | --- |
| 로그인 | `/login` → Google 계정으로 계속하기(`/auth/login`). 오류 코드(`forbidden`, `unconfigured`, `unavailable`, `cancelled`, `callback`)마다 원인과 다음 행동을 보여준다. 알 수 없는 값은 원문을 출력하지 않는다. | `auth/presentation/login-error.ts`의 코드, `auth/screen/login-notice.ts` | Vitest, Playwright(설정 없음) |
| 보관함 열기 | `/`가 브라우저에서 `GET /api/library`를 호출한다. 세션 없음은 `/login`, 허용하지 않은 계정은 `/login?error=forbidden`, 소유자 설정 없음은 `/login?error=unconfigured`로 이동한다. 저장소 오류는 다시 불러오기를 제공한다. | `library/screen/screen-state.ts`의 `transition`, `library-api.ts`의 오류 대응표 | Vitest, Playwright(설정 없음), 실제 Supabase 브라우저 |
| 링크 담기 | 링크 추가 → 링크·옵션·컬렉션 선택 → 위시에 담기. 선택 창에서 없는 컬렉션을 바로 만든다. 저장 뒤 상세가 열린다. 저장 응답 직후 서버가 상품 페이지를 읽어 이름과 가격(하나로 분명할 때만)을 채우고 사진의 비공개 사본을 만든다. 화면은 수집이 끝날 때까지 다시 읽는다. 같은 링크는 기존 상품을 열어 이미 담았다고 알린다. 선택한 컬렉션이 사라졌으면 안내 후 목록을 새로 불러오고 입력을 유지한다. | 같음. 링크와 컬렉션 이름 규칙은 `wishlist/link.ts`, `wishlist/collection-name.ts`를 서버와 함께 쓴다. | Vitest, 실제 Supabase 브라우저(재접속·새 세션 유지 포함) |
| 컬렉션 만들기와 거르기 | 사이드바 또는 모바일 칩의 컬렉션 만들기. 만든 컬렉션으로 바로 거른다. 거르기 상태는 화면 안에만 있어 새로고침하면 전체로 돌아간다. | 같음 | Vitest, 실제 Supabase 브라우저 |
| 정보 수집 실패와 재시도 | 실패하면 링크는 남고 원인(차단 주소, 쇼핑몰 차단, 시간 초과, 상품 정보 없음 등)을 보여준다. 실패했거나 60초 넘게 멈춘 상품은 상세의 "다시 가져오기"로 재시도한다. 화면은 보관함을 처음 받을 때마다(뒤로 가기 캐시 복귀 포함) 깨우기를 보내고, 서버는 한 번도 시작하지 않은 대기 상품(공유 키로 담은 상품, 복원 창을 넘긴 상품)과 예약 실행이 사진을 남겨 둔 상품을 응답 뒤 수집한다. | `metadata/` 수집 실행기, DB의 임대·세대 RPC, `screen-state.ts`의 재시도·다시 읽기 | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저 |
| 상품 사진 | 카드와 상세가 비공개 사본을 보인다. 이미지 주소는 같은 출처의 `/api/products/{productId}/picture?v=…`이고 서버가 짧은 서명 주소로 보낸다. 사본이 없으면 중립 회색 자리표시가 가져오는 중·가져오지 못함·링크만 담음을 말하고, 불러오지 못하면 자리표시로 바뀐다. 사진만 실패하면 상세가 이유와 "다시 가져오기"를 보여주고 이름·가격은 남는다. | `metadata/application/picture-copy.ts` 복사기, `domain/picture.ts` 판별, sharp 정규화, DB의 예약 이름·Storage 정책, `screen/product-view.ts`·`ProductPicture.tsx` | Vitest(sharp·로컬 서버 포함), 실제 DB·Storage, 실제 HTTP, 실제 Supabase 브라우저 |
| 남은 사진 정리 | 같은 깨우기의 응답 뒤 서버가 소유자 토큰으로, 어떤 상품도 쓰지 않고 수집 중인 작업의 이번 시도도 아니며 만든 지 10분이 지난 사본을 200개까지 지운다. Storage의 지우기 정책이 한 번 더 확인한다. 화면에 보이는 사본은 지우지 않고, 화면의 변화는 자동 확인의 안내 한 줄이다. 남은 사본은 3b의 끊긴 실행·예외를 던진 정산·서명 업로드 주소와 4b의 실패한 지우기에서 생긴다. 작업자는 Storage에 닿지 못해 정리하지 않는다. | `library/application/picture-sweep.ts`의 `sweepPictures`, 소유자 RPC `moti_picture_orphans`(`moti.stored_pictures`가 Storage를 읽음), Storage 정책 `moti_storage.may_discard` | Vitest, 실제 DB·Storage, 실제 HTTP, 실제 Supabase 브라우저 |
| 상품 보기 | 카드 → 상세. 원본 링크(http·https만), 옵션, 담은 날, 수집 상태와 마지막 확인 가격을 보여주고 아래에 정리 칸이 있다. 가격이 없으면 "가격 확인 전"이다. 매일 가격 확인이 이전 가격을 지켰으면 위시 상품의 상세가 가격 아래에 "{서울 날짜}에 가격을 다시 확인하지 못해 이전 가격을 보여줘요."와 이유를 중립 색으로 보인다(카드는 그대로). 예시 가격은 실제 화면에 없다. | `library/screen/product-view.ts`(`priceKept`, `failureReason`) | Vitest, 실제 Supabase 브라우저 |
| 상품 정리 | 상세 → 상품 이름·메모·컬렉션 체크 → 변경사항 저장(바뀐 칸이 있을 때만 켜짐) → "변경사항을 저장했어요". 고친 이름은 이후 수집이 지우지 않는다. 다른 곳에서 먼저 바뀌었으면(409) 최신 내용을 다시 읽고 입력한 칸을 지킨 채 안내한다. 새로고침·새 세션에서도 유지된다. | `screen-state.ts`의 손댄 칸 초안과 `mergeProduct`, 규칙은 `wishlist/product-fields.ts`, 전환은 SQL RPC `moti_edit_product` | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저 |
| 구매 기록 | 위시 카드의 구매완료 버튼 또는 상세의 "구매완료로 이동" → "구매완료 목록으로 옮겼어요" 알림과 실행 취소. 구매완료 상품의 상세에서 구매일(서울 기준 오늘까지)과 실구매가(원)를 적고 구매 정보 저장. 빈 값은 "실구매가 미입력", 0은 "₩0"이다. "위시로 되돌리기"는 구매 기록을 지우고 메모·컬렉션을 남긴다. 실행 취소는 구매 뒤 상품이 다시 바뀌지 않았을 때만 보인다. | 같음. 전환은 SQL RPC `moti_purchase_product`·`moti_record_purchase`·`moti_return_to_wish` | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저 |
| 보기 전환 | 사이드바 또는 모바일 하단의 위시리스트·구매완료·공유 저장. 컬렉션 거르기와 함께 쓰며 제목·개수·빈 상태가 보기를 따른다. 공유 저장 보기에서 컬렉션을 고르면 위시 보기로 간다. 화면 안의 상태라 새로고침하면 위시리스트 전체로 돌아간다. | `screen-state.ts`의 `view`, `visibleProducts` | Vitest, 실제 Supabase 브라우저 |
| 컬렉션 이름 바꾸기 | 컬렉션을 고른 뒤 제목 옆 "컬렉션 이름 바꾸기" → 이름 저장. 이름이 그대로면 호출 없이 닫고, 다른 컬렉션과 대소문자만 다른 이름은 거절한다. 소속 상품과 거르기는 유지된다. | 같음. 이름 규칙은 `wishlist/collection-name.ts`, 전환은 SQL RPC `moti_rename_collection` | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저 |
| 백업과 복원 | 사이드바 로그아웃 위 또는 모바일 상단 아이콘의 "백업과 복원". "백업 만들기" → 확인한 백업의 "내려받기" 링크(`moti-backup-YYYYMMDD-HHmm.json`, 사진 없음). "백업 파일 선택" → 요청 전에 파일을 검사하고 지금과 파일의 상품·컬렉션 수, 파일에 없어 지워질 상품 수를 보인 뒤 "취소"에 초점 → "보관함 바꾸기". 바꾸는 중에는 닫히지 않는다. 성공하면 위시 전체 보기와 알림, 바뀐 파일·백업이 아닌 파일·서버 거절은 바뀌지 않았다는 오류, 503·연결 끊김은 결과를 모른다고 알리고 다시 읽는다. 링크가 같은 상품은 사진과 id를 지키고, 새 상품은 응답 뒤 수집한다. | 형식과 읽기 함수는 `presentation/library-backup.ts`(화면과 서버가 함께 씀), 대화상자 전환은 `screen-state.ts`, 교체는 SQL RPC `moti_restore_library`, 응답 뒤 작업은 `application/restore-follow-up.ts` | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저 |
| 공유 저장 설정 | 사이드바 또는 모바일 하단의 "공유 저장". 단축어를 손으로 만드는 다섯 동작, 이 배포의 주소와 "주소 복사", 단축어가 보여줄 메시지. 저장 키 패널: "저장 키 만들기" → `Bearer moti_sk_…`를 한 번만 보이고 "헤더 값 복사"·"붙여 넣었어요" → 끝 네 글자·만든 날·"마지막으로 이 키를 쓴 때"(없으면 "아직 이 키를 쓴 적이 없어요."). "새 키로 바꾸기"·"키 폐기"는 패널 안 확인이 "취소"에 초점을 두고 Esc로 닫힌다. 폐기하면 언제 폐기했는지 보이고, 다른 곳에서 만든 새 키가 있으면 다시 읽어 보인다. 비밀은 붙여 넣었다고 하거나 보기를 떠나거나 뒤로 가기 캐시에서 돌아오면 사라진다. 다른 곳에서 키가 바뀌었으면 다시 읽고 알린다. "연결됨"·"설치 완료"는 어디에도 없다. | `screen/key-panel-state.ts`의 패널 전환(엔드포인트 `share`), `KeyPanel.tsx`, `screen/share-view.ts`의 문구, `ShareView.tsx`, 키 SQL RPC `moti_share_key_read`·`issue`·`revoke` | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저 |
| iPhone에서 공유해 담기 | 단축어가 `POST /api/share/links`에 `Authorization: Bearer <키>`와 `{"url"}`을 보내면 담았음(201)·이미 담음(200)·링크 아님(400)·키 거절(401)·한 시간 30번(429)을 한국어 `message`로 받는다. 상품은 수집 없이 "정보 수집 대기"로 들어가고, 소유자가 보관함을 열면 화면이 `POST /api/library/metadata`로 깨워 응답 뒤 수집한다. 실제 iPhone은 검증하지 않았다. | `share/` 기능 폴더, 쿠키 없는 `_server/share-context.ts`, 익명 RPC `moti_share_add`(전용 역할 `moti_share`), 깨우기 RPC `moti_metadata_wake` | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저(Node `fetch`로 단축어 흉내) |
| 자동 확인 | 사이드바의 "백업과 복원" 아래 또는 모바일 상단 아이콘의 "자동 확인" 대화상자. 하루 세 번의 예약과 GitHub이 늦추거나 건너뛸 수 있다는 안내, 작업 키 패널(공유 저장과 같은 로직: "작업 키 만들기" → `moti_wk_…`를 한 번만 보이고 "키 복사"·"붙여 넣었어요" → 끝 네 글자·만든 날·"마지막으로 이 키로 실행을 시작한 때", 바꾸기·폐기 확인은 "취소"에 초점이고 진행 중인 실행도 멈춘다고 말함), GitHub 비밀값 `MOTI_WORKER_TOKEN`·변수 `MOTI_WORKER_URL`(이 배포의 주소)과 "이름 복사"·"주소 복사", 최근 실행 다섯 개(서울 시각, "수집 3 · 실패 1 · 가격 확인 12 (이전 가격 유지 2)"처럼 수집·실패·가격 확인 셈, 멈춘 이유, 수집 실패와 가격을 지킨 이유별 셈. `cut`만 오류 색), 활성 키인데 26시간 넘게 실행이 없으면 알림, 마지막 안내 "사진 복사와 남은 사진 정리는 moti를 열 때 해요.". 비밀은 창을 닫으면 사라진다. "연결됨"·"설치 완료"는 어디에도 없다. | `screen/key-panel-state.ts`(엔드포인트 `worker`), `screen/worker-view.ts`, `WorkerDialog.tsx`, 키 SQL RPC `moti_worker_read`·`moti_worker_key_issue`·`moti_worker_key_revoke` | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저(Node `fetch`로 GitHub 흉내) |
| 예약 수집 | GitHub Actions가 한국 시간 06:17·14:17·22:17에 `POST /api/scheduled-runs`를 작업 키로 부른다. 대기·멈춤·한 시간 지난 재시도 가능 실패인 위시 상품을 세 줄로 20초 동안 골라(최대 60개) 이름과 가격을 쓰고 사진은 "사진을 가져오는 중"으로 둔다. 수집이 이 실행의 가격 확인도 대신한다. 소유자가 보관함을 열면 화면이 깨워 사진을 복사한다. 두 값을 넣기 전에는 워크플로가 알림만 남기고 건너뛴다. 공개 저장소라 로그에는 정해진 문구만 남기고 셈은 자동 확인에만 있다. 실제 GitHub 예약 실행과 호스팅은 검증하지 않았다. | `worker/` 기능 폴더, 쿠키 없는 `_server/worker-context.ts`, 익명 RPC `moti_worker_begin`·`next`·`complete`·`fail`·`finish`(전용 역할 `moti_worker`), 깨우기 RPC `moti_metadata_wake`, `.github/workflows/scheduled-run.yml`·`scripts/scheduled-run.sh` | Vitest(스크립트는 가짜 curl), 실제 DB, 실제 HTTP, 실제 Supabase 브라우저 |
| 매일 가격 확인 | 같은 예약 실행에서 남은 수집 다음에, 수집이 끝났고 서울 날짜로 오늘 확인하지도 가격을 얻지도 않은 위시 상품을 확인한 적 없는 것부터, 그다음 가장 오래전에 확인한 것부터 고른다(수집과 함께 최대 60개). 페이지에 상품 이름이 있고 서로 다른 가격이 하나이며 저장한 가격과 같은 통화(또는 저장한 가격 없음)일 때만 마지막 확인 가격과 시각을 바꾼다. 가격이 여럿이거나 없음(`no_single_price`), 상품 페이지가 아님(`no_product_data`), 다른 통화(`other_currency`), 가져오기 실패는 이전 가격과 시각을 지키고 이유를 남긴다. 이름·소유자 이름·사진·구매완료 상품은 건드리지 않고, 고른 뒤 구매완료로 옮긴 상품은 쓰지 않는다. 실제 쇼핑몰·GitHub 예약 실행은 검증하지 않았다. | `worker/domain/price-check.ts`의 `decidePriceCheck`, 실행의 가격 분기(`application/scheduled-run.ts`), 익명 RPC `moti_worker_next`(가격 분기)·`moti_worker_price`, 상품 열 `price_checked_at`·`price_check_code` | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저 |
| 로그아웃 | 사이드바 또는 모바일 상단의 로그아웃 → 같은 출처 POST `/auth/logout` → `/login`. | 서버 세션 | 실제 Supabase 브라우저 |

화면 모듈(`src/features/*/screen/`)은 API 계약(`presentation/library-dto.ts`, `library-backup.ts`, `login-error.ts`, `share/presentation/share-dto.ts`, `worker/presentation/worker-dto.ts`)과 공유 순수 규칙만 가져온다. 다른 계층, `_server`, Supabase와 목업 상태를 가져오면 ESLint가 실패한다.

## 예시 데이터 목업 (`/demo`)

모든 목업 경로는 `/demo`의 버튼으로 이동한다.

| 사용자 동작 | 진입점과 관찰 결과 | 상태 소유자 | 검증 |
| --- | --- | --- | --- |
| 위시 찾기 | 상품 검색, 카테고리, 정렬 메뉴를 조합한다. 정렬 메뉴는 클릭과 키보드로 선택하고 Escape·바깥 클릭·Tab으로 닫는다. 빈 결과에서 초기화한다. | `selectProducts`, 화면 필터, `SortMenu`의 펼침·초점 | Vitest, Playwright |
| 링크 담기 | 링크 추가 → 상품 링크·컬렉션 드롭다운 → 위시에 담기. 컬렉션을 검색·복수 선택하고 없는 이름은 즉시 생성·선택한다. 현재 컬렉션을 기본 선택하며 모두 해제해도 된다. 생성과 입력 오류 후 링크·옵션·선택을 유지한다. 중복 링크는 기존 소속을 보존한 상세를 연다. 옵션이 다르면 별도 상품이다. | `link.add`, 추가 모달의 선택 ID, `AddLink`의 링크·옵션 초안 | 도메인·앱 상태 단위 검사, 브라우저 검색·생성·입력·중복 검사 |
| 수집 실패 확인 | 새 링크 상세 → 실패 결과 보기. 원본 링크가 남고 이름을 직접 수정할 수 있다. | `Metadata`와 수집 명령 | Vitest, Playwright |
| 상품 정리 | 상세 → 메모·컬렉션 선택 → 변경사항 저장. 다시 열어 값을 확인한다. | 상품 한 배열과 컬렉션 ID | Playwright |
| 구매 기록 | 구매완료로 이동 → 구매완료 메뉴. 구매일·실구매가는 선택 입력이다. 실행 취소와 위시 복원은 메모·컬렉션을 보존한다. | `Purchase`, 구매 명령 | Vitest, Playwright |
| 컬렉션 묶기 | 컬렉션 → 새 컬렉션. 이름을 바꾸어도 소속 상품을 유지한다. 빈 이름과 중복 이름을 거절한다. | 컬렉션 배열과 상품의 소속 ID | Vitest, Playwright |
| 공유 흐름 체험 | 공유 저장 → 공유 저장 체험하기. 성공·중복·실패 예시를 선택한다. | 대화상자 임시 상태 | Playwright |

`src/features/wishlist/model.ts`는 React, 브라우저 API와 네트워크에 의존하지 않는다. ESLint가 이 경계를 검사한다. 화면 구성은 `Mockup.tsx`, 대화상자는 `Dialogs.tsx`, 상품 카드는 `ProductCard.tsx`가 담당한다.

`npm run verify`로 전체 검증을 실행한다. 구체적인 명령과 범위는 [검증 스킬](../tools/verify-moti/SKILL.md), 관찰 결과는 [검증 기록](verification.md)을 따른다. 브라우저 선택자는 사용자에게 보이는 역할과 한글 레이블을 사용한다.

## 실제 API

| 경로 | 결과 | 계층 | 검증 |
| --- | --- | --- | --- |
| `GET /auth/login` | 소유자 설정이 있으면 Google 인증으로 303 이동한다. | `auth/presentation`, `auth/infrastructure` | handler stub, 실제 HTTP |
| `GET /auth/callback` | code를 교환하고 소유자만 `/`로 보낸다. 다른 계정은 세션을 종료한다. | 같음 | handler stub·mock |
| `POST /auth/logout` | 같은 출처에서만 세션을 종료한다. | 같음 | handler, 실제 HTTP |
| `GET /api/library` | `LibraryReadResponse`. 상품마다 마지막 확인 가격과 마지막 매일 가격 확인(`priceCheck`: 시각, 이전 가격을 지킨 이유 또는 null) | `library/presentation` → `application` → `infrastructure` | handler, 실제 HTTP |
| `POST /api/links` | `LinkSaveRequest` → 201 새 상품, 200 중복 | 같음 | handler, 실제 HTTP |
| `POST /api/collections` | `CollectionCreateRequest` → 201 | 같음 | handler, 실제 HTTP |
| `POST /api/products/{productId}/metadata` | `MetadataRetryRequest` → 202. 실패·멈춤·사진만 실패한 상품을 다시 수집한다. | 같음 | handler, 실제 HTTP |
| `GET /api/products/{productId}/picture` | 302 서명한 Storage 주소(개인 캐시 50분), 404 `picture_missing` | 같음 | handler, 실제 DB, 실제 HTTP |
| `PATCH /api/products/{productId}` | `ProductChangeRequest`(`revision`, `change.type`: `details`·`purchase`·`purchase.record`·`wish`) → 200 `ProductChangeResponse`. 저장된 값과 같으면 revision과 상관없이 200, 오래된 revision은 409 `revision_conflict`, 위시 상품의 구매 기록과 미래 구매일은 400 | 같음 | handler, 실제 DB, 실제 HTTP |
| `GET /api/library/backup` | 200 백업 파일(`moti.library-backup` v1) 첨부, `no-store`·`nosniff`. 오류는 JSON | 같음 | handler, 실제 DB, 실제 HTTP |
| `POST /api/library/restore` | 본문은 백업 파일 글자 그대로(JSON, 4MiB 이하) → 200 `LibraryReadResponse`. 바뀐 파일·더 새로운 버전·서버 날짜보다 뒤의 구매일은 400(`field`는 첫 문제 위치), 4MiB 초과 413, 잠금 대기 초과 503. 실패하면 아무것도 바뀌지 않는다 | 같음 | handler, 실제 DB, 실제 HTTP |
| `POST /api/share/links` | 공유 단축어 전용. `Authorization: Bearer moti_sk_<43자>`, `{"url"}`(8KiB) → 201 `added`·200 `duplicate`, 400 `invalid_link`, 401 `share_key_rejected`(형식·모름·폐기 모두 같은 본문), 429 `share_key_busy`, 409, 413, 415, 503. 모든 응답에 `message`, 쿠키·CORS 헤더 없음 | `share/presentation` → `application` → `infrastructure`(익명 클라이언트) | handler, 실제 DB, 실제 HTTP |
| `GET /api/share-keys` | 200 `{ key }`(끝 네 글자·시각, 없으면 null) | `library/presentation`(보관함 관문) → `share/application` | handler, 실제 DB, 실제 HTTP |
| `POST /api/share-keys` | `{ replaces }` → 201 `{ key, secret }`(`no-store`), 화면이 본 키가 아니면 409 `revision_conflict` | 같음 | handler, 실제 DB, 실제 HTTP |
| `DELETE /api/share-keys/{keyId}` | 200 폐기한 키(멱등), 없는 키 404 `share_key_missing` | 같음 | handler, 실제 DB, 실제 HTTP |
| `POST /api/library/metadata` | `{}` → 202 깨운 상품(시도 0인 대기, 그다음 사진을 기다리는 상품을 새 세대로, 함께 최신부터 8개). 응답 뒤 두 개씩 40초 동안 수집하고, 따로 10분 지난 남은 사진 사본을 200개까지 지운다(응답 본문과 무관) | `library/presentation` → `metadata` | handler, 실제 DB, 실제 HTTP |
| `POST /api/scheduled-runs` | 예약 실행 전용. `Authorization: Bearer moti_wk_<43자>`, 본문·쿠키 읽지 않음 → 200 `{ stop, collections, prices, failures }`(`prices`는 확인한 가격·지킨 가격 셈, `failures`는 수집 실패와 가격을 지킨 이유별 셈), 401 `worker_key_rejected`(같은 본문), 409 `run_busy`·`run_lost`, 429 `run_limit`, 503. `maxDuration` 60 | `worker/presentation` → `application`(실행) → `infrastructure`(익명 클라이언트) | handler, 실제 DB, 실제 HTTP |
| `GET /api/worker-keys` | 200 `{ key, runs }`(끝 네 글자·시각, 최근 실행 다섯 개의 상태·셈) | `library/presentation`(보관함 관문) → `worker/application` | handler, 실제 DB, 실제 HTTP |
| `POST /api/worker-keys` | `{ replaces }` → 201 `{ key, secret }`(`no-store`), 화면이 본 키가 아니면 409 `revision_conflict` | 같음 | handler, 실제 DB, 실제 HTTP |
| `DELETE /api/worker-keys/{keyId}` | 200 폐기한 키(멱등, 열린 실행을 멈춤), 없는 키 404 `worker_key_missing` | 같음 | handler, 실제 DB, 실제 HTTP |
| `PATCH /api/collections/{collectionId}` | `CollectionRenameRequest`(`revision`, `name`) → 200 `CollectionRenameResponse`. 다른 컬렉션과 대소문자만 다른 이름은 409 `collection_duplicate`, 오래된 revision은 409 `revision_conflict`, 없는 컬렉션은 422 | 같음 | handler, 실제 DB, 실제 HTTP |

요청·응답·오류 계약은 [OpenAPI 문서](api/openapi.json)에 있다.
