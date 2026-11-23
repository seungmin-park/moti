# moti

사용자가 제공한 전역 개발 원칙을 따른다. 비단순 변경에는 agent-engineering을 적용한다.

## 현재 범위

Next.js와 TypeScript로 만드는 개인 위시리스트다. UI 목업 피드백을 반영했고 사용자가 실제 기능의 연속 구현을 승인했다. Supabase PostgreSQL·Auth·비공개 Storage로 저장·단일 Google 계정 인증·정보 수집·가격 추적을 연결한다. 현재 화면의 예시 데이터와 실제 저장 기능은 구분한다. 배포에는 별도 승인이 필요하다. 다음 작업의 기준선과 남은 범위는 `docs/implementation-checkpoint.md`와 `docs/backend-implementation.md`에 있다.

## pstack

사용자가 지정한 원본은 https://github.com/cursor/plugins/tree/main/pstack 이다.
프로젝트 설치본은 `tools/pstack/skills`에 있다. 다음 작업에서도 `tools/pstack/skills/poteto-mode/SKILL.md`를 먼저 읽고 필요한 스킬을 적용한다. 설치 출처와 고정 커밋은 `tools/pstack/source.json`에 기록한다.
이 경로는 프로젝트 지침으로 읽는 설치본이다. 전역 스킬이나 Codex 플러그인 등록을 뜻하지 않는다.
사용자 지침과 실행 환경의 권한은 스킬보다 우선한다. 제공되지 않는 모델과 Cursor 전용 도구를 사용했다고 보고하지 않는다.

## 검증과 전달

UI 팔레트는 흰색·중립 회색·차콜을 사용한다. 사용자가 초록·세이지 색상을 원하지 않으므로 브랜드, 선택 상태와 포커스에 다시 도입하지 않는다. 상품 사진과 의미 있는 오류 색상은 별도다. 입력 포커스는 중립적인 배경·하단 강조로 표시하고 키보드 위치 표시는 유지한다.

동작은 Red, Green, Refactor 순서로 구현한다. 사용자 입력과 실패 상태를 검증한다. 단위 테스트는 Vitest, 브라우저 테스트는 Playwright를 사용한다.
프로젝트 명령과 실제 사용자 경로는 `tools/verify-moti/SKILL.md`와 `docs/feature-map.md`를 따른다.
기능 단위 PR은 로컬 검사, 현재 head의 CI와 리뷰 확인, 실제 병합 확인까지 진행한다. 보호 규칙이나 검사를 우회하지 않는다.
`main`은 GitHub Actions의 `pstack`, `app`, `database`를 필수로 요구하고 최신 base 반영·대화 해결·관리자 적용을 강제한다. 저장소의 GitHub 자동 병합을 켜 두었다. 각 기능을 구현·검토한 뒤 PR에서 squash 자동 병합을 예약하고 실제 `MERGED` 상태까지 확인한다. 설정이 없다는 이유로 수동 병합으로 대체하지 않는다. 정책이 달라졌으면 먼저 조회하고 원인을 해결한다. 기능을 여러 개 모은 뒤 한꺼번에 PR을 만들지 않는다.
실제 iPhone 공유 메뉴·Google OAuth·호스팅 설정 검증과 로컬 테스트의 범위를 구분해 보고한다. 로컬·CI에서 실제 DB를 검증해도 실제 기기나 배포 검증으로 보고하지 않는다.

## API 연결 시 테스트 원칙

기존 Next.js API·Supabase 계획을 유지한다. API 계약 테스트와 문서의 일치를 CI에서 검증하고 실제 HTTP 요청으로 통합 동작을 확인한다. 요청 처리 경계의 Mock 테스트는 Given–When–Then으로 입력, 검증 실패, 인증과 오류 응답을 표현한다. Spring 도구를 요청한 사용자의 목적을 현재 스택에 적용한다.
계층별 상세 규칙은 `docs/testing.md`를 따른다.
코드 계층과 데이터 객체 이름 규칙(`Request/Response`·`Command/Result`·도메인 명사·`Row`)은 `docs/architecture.md`의 "계층과 데이터 객체"를 따른다. import 방향은 ESLint가 검사한다. Domain은 순수 단위 테스트, Persistence는 전체 앱 없이 실제 DB를 쓰는 슬라이스 테스트, Service는 테스트용 트랜잭션 자동 롤백 없이 실제 저장을 검증하고 `afterEach`로 데이터를 정리한다.

## Code Review Rules

- 리뷰는 한국어로 작성한다. 이번 diff가 새로 만든 문제에 집중하고 발생 입력·실행 경로·영향과 변경 줄의 근거를 제시한다. 취향·서식·추측성 리팩터링은 지적하지 않는다. CI가 담당하는 lint·타입 검사는 중복 지적하지 않는다.
- **단일 소유자 데이터 경계:** 인증되지 않은 요청이나 다른 Google 계정이 위시리스트, 비공개 Storage의 사진, 공유 경로의 데이터를 읽거나 바꿀 수 있는 회귀를 찾는다. Supabase 정책과 서버 쪽 권한 확인이 함께 유지되는지 본다.
- **외부 링크 수집과 가격:** 공유된 URL의 수집이 실패하거나 차단됐을 때 기존 상품 정보·가격을 빈 값이나 틀린 값으로 덮어쓰지 않는지, 신뢰할 수 없는 URL이 내부 주소로 요청되지 않는지 확인한다.
- **저장과 계층:** 부분 저장, 마이그레이션의 기존 데이터 호환, `docs/architecture.md`의 계층 규칙 위반을 찾는다. 테스트가 실제 저장 없이 통과하게 만든 변경을 지적한다.
- `tools/pstack/`, 생성 파일, lock 파일은 리뷰하지 않는다. 예시 데이터와 실제 저장 기능을 혼동한 변경은 지적한다.

## 리뷰 봇

- 구현과 로컬 검증 뒤 PR 전에 `/common-review`를 실행한다. 0단계는 모두 고치고 1단계는 고치거나 보류 이유를 남긴다.
- PR을 올리면 `pr-bot` 체크가 자동으로 돈다. 자동 병합은 현재 head의 `pr-bot`이 끝난 것을 확인한 뒤 예약한다.
- 스레드마다 지적을 코드로 먼저 확인한다. 맞으면 고쳐서 push하고, 틀리면 근거를 답글로 달고 닫는다.
- `[사람 확인 필요]` 스레드는 에이전트가 닫지 않는다. 멈추고 사용자에게 보고한다.
- 수정 라운드는 최대 3번이다. 넘으면 멈추고 보고한다.
- 명령과 세부 절차는 `~/.claude/skills/common-review/references/responding.md`에 있다.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
