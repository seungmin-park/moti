# 목업 검증 기록

CI 작업 `mockup`은 `app`으로, Supabase 없는 브라우저 검사 `test:e2e`는 `test:ui`로 이름을 바꿨다([변경 기록](changes/naming.md)). 아래 이전 항목의 "브라우저 e2e"는 지금의 `npm run test:ui`다.

상품 정리와 구매 기록(4a)의 검증은 [변경 기록](changes/organize.md)에 있다. 단위 804개, 실제 DB 168개(persistence 126, service 42), 실제 HTTP 23개, 실제 스택 브라우저 30개, `tests/ui` 50개가 통과했다. 실제 스택 브라우저 검사는 동작을 만든 뒤 작성했다. 실제 Google OAuth·실제 iPhone·배포는 검증하지 않았다.

상품 사진의 비공개 사본(3b)의 검증은 [변경 기록](changes/pictures.md)에 있다. 단위 615개, 실제 DB 118개, 실제 HTTP 18개, 실제 스택 브라우저 20개, `tests/ui` 50개가 통과했다. 실제 쇼핑몰 사진 결과는 [real-pages.md](evidence/pictures/real-pages.md)에 있다.

저장 뒤 상품 정보 수집(3a)의 검증은 [변경 기록](changes/metadata.md)에 있다. 단위 517개, 실제 DB 85개, 실제 HTTP 14개, 실제 스택 브라우저 16개, 브라우저 e2e 50개가 통과했다.

실제 보관함 화면·로그인·`/demo` 이동(2b)의 검증은 [변경 기록](changes/screen.md)에 있다. 단위 267개, 실제 DB 43개, 실제 HTTP 10개, 실제 스택 브라우저 14개, 브라우저 e2e 50개가 통과했다. 목업은 이제 `/demo`에서 검토한다.

최신 정렬·입력·컬렉션 개선 검증은 [변경 기록](changes/controls.md)에 있다. 중립 팔레트와 컬렉션 드롭다운·즉시 생성까지 반영한 뒤 순수 단위 33개와 PC·모바일 브라우저 40개를 통과했다. 최신 화면은 [정렬 메뉴](evidence/controls/desktop-sort.png)와 [컬렉션 생성](evidence/controls/mobile-create.png), 미리보기 주소는 `http://localhost:3105`다. 아래는 최초 목업 구현 시점의 기록이다.

2026-11-11, Node 24.21.0과 잠금 파일의 의존성으로 검증했다. 실제 저장·인증·수집을 연결하기 전의 세션 메모리 목업이다.

## 실행 결과

| 검사 | 실제 명령 또는 실행 | 결과 |
| --- | --- | --- |
| pstack 원본 | `npm run verify:pstack` | 원본 스킬 58개, 파일 572개 무결성 일치 |
| 정적 검사 | `npm run lint`, `npm run typecheck` | 통과 |
| 순수 단위 | `npm test` | 19개 통과 |
| 프로덕션 빌드 | `npm run build` | 통과, `/` 정적 페이지 생성 |
| 사용자 흐름 | `npm exec -- playwright test --headed --workers=1` | PC Chromium 11개, iPhone 크기 WebKit 11개, 총 22개 통과 |
| 반응형 화면 | `scripts/capture-preview.mjs`를 최종 프로덕션 서버에 실행 | 1440·900·390px에서 넘침·깨진 이미지·페이지 오류 없음, Pretendard 로드 확인 |
| 자동 접근성 | `scripts/check-a11y.mjs`를 같은 서버에 실행 | 1440·390px 목록과 상세의 WCAG A/AA 위반 0개 |
| 검증 스킬 | skill-creator의 `quick_validate.py tools/verify-moti` | 통과. 스킬의 실행·브라우저·화면 검사 명령도 실제 사용 |

브라우저 테스트는 새 프로덕션 서버를 3101 포트에 시작했다. 기존 개발 서버를 재사용하지 않았다. 최종 미리보기는 별도로 시작한 3103 포트의 프로덕션 서버다. 화면 캡처는 [PC](evidence/desktop.png), [태블릿](evidence/tablet.png), [모바일](evidence/mobile.png), [상세](evidence/detail.png)에 있다. [레이아웃 결과](evidence/layout.json)도 보존했다.

설치된 디자인 검사 도구도 1440·900·390px에서 오류 없이 종료했다. 보조 텍스트의 12px 사용 비율에 대한 권고 1개는 남았다. 상품명·가격·입력과 주요 버튼을 더 크게 유지하고, 옵션·출처 등 보조 정보는 12px로 구분했다. 캡처를 직접 읽고 목록과 상세의 배치·대비·사진을 확인했다.

## Red와 독립 검토

첫 구현 전에 단위 테스트 15개가 요구 동작 부재로 실패했다. 빈 상태에 링크가 추가되지 않는 실패를 [도메인 Red](evidence/red-domain.txt)에 남겼다. 최소 화면에는 링크 추가 버튼이 없어 브라우저 테스트가 실패했고 [UI Red](evidence/red-ui.txt)에 기록했다. 환경 권한 오류는 Red로 세지 않았다.

독립 검토에서 다른 작업의 토스트가 이전 구매를 취소하는 문제, 표시 가격과 정렬 기준 불일치, 미입력 실구매가의 예시 가격 대체, 긴 유효 입력의 모바일 넘침을 재현했다. 수정 전에 단위 4개와 UI 4개가 실패했다. [추가 단위 Red](evidence/red-review-domain.txt)와 [추가 UI Red](evidence/red-review-ui.txt)를 보존했다. 수정 후 전체 검사를 통과했다. axe 검사는 스타일 수정 후 추가한 회귀 보호이며 테스트 선행 구현이라고 주장하지 않는다.

수정 후 별도의 코드 검토에서 추가 병합 차단 결함을 찾지 못했다. 주석 검토의 삭제 제안과 `MUST KILL`은 0개였다. Next.js가 생성하는 주석은 생성기 출처를 확인해 유지했다.

## 구조 검사

ESLint는 도메인 모델의 React·Next.js·Node 모듈 의존성과 `fetch`, `window`, `document`, 브라우저 저장소 접근을 금지한다. `lintText`로 모델 경로에 임시 `fetch` 사용을 검사했을 때 `no-restricted-globals` 오류가 발생함을 확인했다. 실제 코드에는 위반이 없고 최종 lint도 통과했다.

## 남은 범위와 환경 제약

실제 iPhone, iOS 공유 메뉴, 인증, 영구 저장, 외부 상품 수집, 가격 추적과 배포는 검증하지 않았다. 다음 단계의 계층별 검증은 [테스트 지침](testing.md)을 따른다.

cmux는 현재 세션의 연결 소켓을 찾지 못했고 컴퓨터 사용 브라우저 호스트도 사용할 수 없었다. 대신 로컬 Playwright를 headed 모드로 실행했다. 개발 서버 종료 요청은 환경의 자동 승인 정책에서 거부되어 최종 검증에는 별도 포트를 사용했다.

작업 폴더의 `.git` 생성이 권한상 거부되어, Git 전달은 별도의 쓰기 가능한 체크아웃에서 수행했다. 작업 폴더의 소스와 전달 파일을 일치시킨 뒤 PR을 만든다. GitHub 연결 도구의 PR 생성은 통합 권한 오류로 실패해 기존 로그인된 GitHub CLI를 사용했다.

의존성 검사에서 운영 의존성의 `npm audit --omit=dev` 결과는 0건이다. 전체 검사에는 개발용 TypeScript ESLint의 minimatch 경로에서 중간 등급 경고 7개가 보고된다. 모두 [하나의 glob 처리 서비스 거부 권고](https://github.com/advisories/GHSA-g3hv-75wg-m249)에서 파생된다. 일반 `npm audit fix`로 해소되지 않아 강제 버전 변경은 적용하지 않았다. ESLint 9.39.5는 Next.js의 lint 플러그인 호환 범위에 맞췄으며 지원 종료 경고가 남아 있다.

저장소에는 현재 필수 브랜치 보호와 리뷰 규칙이 없고 자동 병합도 꺼져 있다. 각 PR의 현재 head와 통합 후보에서 CI가 실제 실행됐는지 확인하고, 리뷰 결과를 확인한 뒤 검증한 head를 지정해 병합한다. [설치 PR](https://github.com/seungmin-park/moti/pull/1)의 실제 병합 정보는 [전달 기록](evidence/delivery.json)에 있다. 목업 PR의 CI와 병합 결과는 해당 PR 및 최종 전달 기록에 남긴다.
