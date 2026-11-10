# moti

사용자가 제공한 전역 개발 원칙을 따른다. 비단순 변경에는 agent-engineering을 적용한다.

## 현재 범위

Next.js와 TypeScript로 만드는 개인 위시리스트의 클릭 가능한 목업이다. 모든 상품, 가격과 저장 결과는 예시다. 계정 인증, 외부 상품 정보 수집, 서버 저장, 정기 가격 추적은 화면 피드백을 받은 뒤 연결한다. 배포에는 별도 승인이 필요하다.

## pstack

사용자가 지정한 원본은 https://github.com/cursor/plugins/tree/main/pstack 이다.
프로젝트 설치본은 `tools/pstack/skills`에 있다. 다음 작업에서도 `tools/pstack/skills/poteto-mode/SKILL.md`를 먼저 읽고 필요한 스킬을 적용한다. 설치 출처와 고정 커밋은 `tools/pstack/source.json`에 기록한다.
이 경로는 프로젝트 지침으로 읽는 설치본이다. 전역 스킬이나 Codex 플러그인 등록을 뜻하지 않는다.
사용자 지침과 실행 환경의 권한은 스킬보다 우선한다. 제공되지 않는 모델과 Cursor 전용 도구를 사용했다고 보고하지 않는다.

## 검증과 전달

동작은 Red, Green, Refactor 순서로 구현한다. 사용자 입력과 실패 상태를 검증한다. 단위 테스트는 Vitest, 브라우저 테스트는 Playwright를 사용한다.
기능 단위 PR은 로컬 검사, 현재 head의 CI와 리뷰 확인, 실제 병합 확인까지 진행한다. 보호 규칙이나 검사를 우회하지 않는다.
실제 iPhone 단축어와 인증, 영구 저장, 수집은 목업의 검증 범위가 아니다.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
