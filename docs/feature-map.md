# 기능 지도

세 화면 경로가 있다. `/`는 허용한 Google 계정의 실제 보관함이다. `/login`은 로그인 진입과 실패 안내다. `/demo`는 예시 데이터 목업이며 상태가 새로고침할 때 초기화된다. 외부 정보 수집, 가격 추적, 공유 저장은 아직 연결하지 않았다.

## 실제 보관함 (`/`, `/login`)

| 사용자 동작 | 진입점과 관찰 결과 | 상태 소유자 | 검증 |
| --- | --- | --- | --- |
| 로그인 | `/login` → Google 계정으로 계속하기(`/auth/login`). 오류 코드(`forbidden`, `unconfigured`, `unavailable`, `cancelled`, `callback`)마다 원인과 다음 행동을 보여준다. 알 수 없는 값은 원문을 출력하지 않는다. | `auth/presentation/login-error.ts`의 코드, `auth/screen/login-notice.ts` | Vitest, Playwright(설정 없음) |
| 보관함 열기 | `/`가 브라우저에서 `GET /api/library`를 호출한다. 세션 없음은 `/login`, 허용하지 않은 계정은 `/login?error=forbidden`, 소유자 설정 없음은 `/login?error=unconfigured`로 이동한다. 저장소 오류는 다시 불러오기를 제공한다. | `library/screen/screen-state.ts`의 `transition`, `library-api.ts`의 오류 대응표 | Vitest, Playwright(설정 없음), 실제 Supabase 브라우저 |
| 링크 담기 | 링크 추가 → 링크·옵션·컬렉션 선택 → 위시에 담기. 선택 창에서 없는 컬렉션을 바로 만든다. 저장 뒤 상세가 열린다. 저장 응답 직후 서버가 상품 페이지를 읽어 이름과 가격(하나로 분명할 때만)을 채우고, 화면은 수집이 끝날 때까지 다시 읽는다. 같은 링크는 기존 상품을 열어 이미 담았다고 알린다. 선택한 컬렉션이 사라졌으면 안내 후 목록을 새로 불러오고 입력을 유지한다. | 같음. 링크와 컬렉션 이름 규칙은 `wishlist/link.ts`, `wishlist/collection-name.ts`를 서버와 함께 쓴다. | Vitest, 실제 Supabase 브라우저(재접속·새 세션 유지 포함) |
| 컬렉션 만들기와 거르기 | 사이드바 또는 모바일 칩의 컬렉션 만들기. 만든 컬렉션으로 바로 거른다. 거르기 상태는 화면 안에만 있어 새로고침하면 전체로 돌아간다. | 같음 | Vitest, 실제 Supabase 브라우저 |
| 정보 수집 실패와 재시도 | 실패하면 링크는 남고 원인(차단 주소, 쇼핑몰 차단, 시간 초과, 상품 정보 없음 등)을 보여준다. 실패했거나 60초 넘게 멈춘 상품은 상세의 "다시 가져오기"로 재시도한다. | `metadata/` 수집 실행기, DB의 임대·세대 RPC, `screen-state.ts`의 재시도·다시 읽기 | Vitest, 실제 DB, 실제 HTTP, 실제 Supabase 브라우저 |
| 상품 보기 | 카드 → 읽기 전용 상세. 원본 링크(http·https만), 옵션, 컬렉션, 담은 날, 메모를 보여준다. 가격이 없으면 "가격 확인 전"이다. 예시 가격과 수정·구매 기능은 실제 화면에 없다. | `library/screen/product-view.ts` | Vitest, 실제 Supabase 브라우저 |
| 로그아웃 | 사이드바 또는 모바일 상단의 로그아웃 → 같은 출처 POST `/auth/logout` → `/login`. | 서버 세션 | 실제 Supabase 브라우저 |

화면 모듈(`src/features/*/screen/`)은 API 계약(`presentation/library-dto.ts`, `login-error.ts`)과 공유 순수 규칙만 가져온다. 다른 계층, `_server`, Supabase와 목업 상태를 가져오면 ESLint가 실패한다.

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
| `GET /api/library` | `LibraryReadResponse` | `library/presentation` → `application` → `infrastructure` | handler, 실제 HTTP |
| `POST /api/links` | `LinkSaveRequest` → 201 새 상품, 200 중복 | 같음 | handler, 실제 HTTP |
| `POST /api/collections` | `CollectionCreateRequest` → 201 | 같음 | handler, 실제 HTTP |

요청·응답·오류 계약은 [OpenAPI 문서](api/openapi.json)에 있다.
