# 실제 보관함 화면과 로그인 (2b)

허용한 Google 계정 하나가 로그인해 실제로 저장된 보관함을 보고, 링크와 컬렉션을 더하는 단위다. 2a에서 API와 인증을 병합했지만 `/`는 예시 목업이었고 `/login`이 없어 모든 로그인 오류 이동이 404였다.

## 바뀐 동작

- `/`는 브라우저에서 `GET /api/library`를 호출하는 실제 보관함이다. 링크 추가(컬렉션 즉시 생성 포함), 컬렉션 만들기와 거르기, 읽기 전용 상세, 로그아웃을 제공한다. 실제 API에 없는 구매·수정·공유는 화면에 만들지 않는다. 가격이 없으면 "가격 확인 전"이고 예시 값을 쓰지 않는다.
- 세션 없음은 `/login`, 허용하지 않은 계정은 `/login?error=forbidden`, 소유자 설정 없음은 `/login?error=unconfigured`로 이동한다. 저장소 오류는 데이터를 유지한 채 다시 시도하게 한다.
- `/login`은 오류 코드마다 원인과 다음 행동을 보여주는 Server Component다. 알 수 없는 값은 원문을 출력하지 않는다. Google 로그인은 일반 링크다. `next/link`의 미리 가져오기가 OAuth를 시작하지 않게 하기 위해서다.
- 목업은 동작 변경 없이 `/demo`로 옮겼다. 일반 대화상자 틀은 `wishlist/Dialog.tsx`로 분리해 함께 쓴다.
- 인증 처리기의 로그인 오류 코드와 화면 안내는 `auth/presentation/login-error.ts` 하나에서 나온다. 컬렉션 이름 규칙은 `wishlist/collection-name.ts` 하나를 서버 명령과 화면이 함께 쓴다.

설계 비교와 선택 근거는 [architecture.md](../architecture.md#실제-보관함-화면)에 있다.

## Red와 Green

환경·문법·누락 import 오류는 Red로 세지 않았다. 각 Red 출력은 `docs/evidence/screen/`에 있다.

| 검사 | Red | 증거 |
| --- | --- | --- |
| 브라우저 보고서 검사 | skip·flaky·프로젝트 누락을 받아들여 9개 중 1개 실패 | `red-browser-report.txt` |
| 로그인 안내 | 구현 전 10개 모두 실패 | `red-login-notice.txt` |
| API 경계와 오류 대응표 | 48개 모두 실패 | `red-library-api.txt` |
| 화면 상태 전환 | 43개 중 42개 실패 | `red-screen-state.txt` |
| 상품 표시 | 17개 모두 실패 | `red-product-view.txt` |
| `/demo` 경로 | 404로 실패 | `red-demo-route.txt` |
| `/login` 화면 | 404로 실패 | `red-login-page.txt` |
| 설정 없는 `/` | 목업이 그대로 보여 실패 | `red-library-unconfigured.txt` |

토큰 갱신 검사는 기존 동작의 확인이라 처음부터 통과했다. 실제 스택 브라우저 7개 시나리오는 화면을 만든 뒤 작성해 별도 Red가 없다. 원본 링크를 http·https일 때만 여는 검사는 Red를 실행했지만 파일로 남기지 않았다.

## 실제로 실행한 검증

| 검사 | 명령 | 결과 |
| --- | --- | --- |
| 전체 | `npm run verify` (조정자가 구현 담당자와 별도로 실행) | 통과 |
| pstack 원본 | `npm run verify:pstack` | 스킬 58개, 파일 572개 무결성 일치 |
| 단위 | `npm test` | 18개 파일, 262개 통과 (이전 143개) |
| 실제 DB | `npm run test:database` | persistence 33개, service 10개 통과 |
| 실제 HTTP | 같은 명령 | 10개 통과. 만료한 접근 토큰을 Route Handler가 갱신하고 새 쿠키로 다음 요청이 통과하는 검사를 추가했다. |
| 실제 화면 | 같은 명령 | PC Chromium과 iPhone 크기 WebKit에서 7개씩, 14개 통과 |
| 브라우저 e2e | `npm run test:e2e` | 50개 통과. 목업 40개는 `/demo`에서, `/login`·설정 누락 5개는 두 프로젝트에서 실행 |

실제 화면 검사는 저장 후 DB 행 수, 새로고침과 새 세션의 유지, 중복, 다른 곳에서 지운 컬렉션, 대화상자에서 만든 컬렉션, 로그아웃, 거절 계정의 쿠키 삭제와 axe 접근성을 확인한다. 실행기는 JSON 결과에서 두 프로젝트의 실제 통과 수를 확인하고 skip·flaky·실패를 거절한다.

ESLint 경계는 화면 파일에서 `@supabase/ssr`, `wishlist/demo-data`, `domain`, 공개 계약이 아닌 `presentation`, `_server`, `next/headers`를 가져오면 실패한다. 결과는 `lint-boundary.txt`에 있다.

## 설계와 다른 선택

- 컬렉션 거르기는 화면 상태라 새로고침하면 전체로 돌아간다. 실제 화면 검사는 컬렉션이 남아 다시 고를 수 있는지 확인한다. 주소에 거르기를 담는 일은 하지 않았다.
- 상세의 원본 링크는 http·https일 때만 연다. API 계약이 `sourceUrl`을 일반 문자열로 정의하므로 화면 경계에서 막는다.
- 대화상자의 컬렉션 만들기는 같은 이름(대소문자 무시)이 있으면 서버를 호출하지 않는다. DB의 `lower(name)` 고유 제약과 같다.
- 새 상품은 모두 기본 제목이어서 카드 이름표에 쇼핑몰을 붙였다.
- Next의 경로 안내 요소가 `role="alert"`를 가지므로 화면 검사는 `main` 안의 알림만 찾는다.

## 남은 범위

실제 Google OAuth, 운영 Supabase 프로젝트, 호스팅과 실제 iPhone은 검증하지 않았다. 실제 화면 검사의 세션은 로컬 Auth에서 비밀번호로 만든 테스트 사용자 쿠키이며 Google 리다이렉트를 거치지 않는다.

목업과 함께 쓰는 `CollectionPicker`는 이름 길이를 UTF-16 기준으로 세어 이모지 21~40개 이름의 즉시 생성 버튼을 숨긴다. 서버와 컬렉션 대화상자는 code point 기준으로 허용한다. 목업 부품을 바꾸지 않으려고 남겼다. 로그아웃 뒤 브라우저의 뒤로 가기 캐시가 이전 목록을 잠시 보여줄 수 있다.

CI의 `database` 작업은 Chromium과 WebKit을 설치하므로 제한 시간을 20분에서 25분으로 늘렸다. 필수 검사 이름은 바뀌지 않았다.
