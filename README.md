# moti

갖고 싶은 물건을 모아두는 개인 위시리스트입니다. 링크를 담고, 컬렉션으로 묶고, 구매한 물건을 기록하는 흐름을 먼저 검토합니다.

현재 결과물은 Next.js와 TypeScript로 만든 클릭 가능한 목업입니다. 모든 상품과 가격은 예시입니다. 변경은 현재 화면의 메모리에만 남으며 새로고침하면 초기 예시로 돌아갑니다.

## 실행

Node.js 24를 사용합니다. asdf 사용자는 `.tool-versions`를 적용할 수 있습니다.

```sh
npm ci
npm run dev
```

[http://localhost:3100](http://localhost:3100)을 엽니다. 위시리스트, 구매완료, 컬렉션과 공유 저장 안내를 조작할 수 있습니다.

## 검증

처음 실행할 때 브라우저를 설치합니다.

```sh
npx playwright install chromium webkit
npm run verify
```

`verify`는 원본 pstack 파일, ESLint, TypeScript, Vitest, 프로덕션 빌드와 Playwright를 확인합니다. 브라우저 검사는 PC Chromium과 iPhone 크기의 WebKit에서 실행합니다. 실제 iPhone 기기나 iOS 공유 메뉴 검증을 뜻하지 않습니다.

Playwright는 개발 서버와 별개인 3101 포트에 프로덕션 서버를 시작합니다. [기능 지도](docs/feature-map.md)와 [프로젝트 검증 스킬](tools/verify-moti/SKILL.md)에 사용자 흐름과 재실행 방법이 있습니다.
Domain·Persistence·Service·API의 검증 범위와 데이터 정리는 [테스트 지침](docs/testing.md)을 따릅니다.

## 개발 지침

사용자가 지정한 [원본 pstack](https://github.com/cursor/plugins/tree/main/pstack)을 `tools/pstack`에 설치했습니다. [설치 범위](docs/pstack-installation.md)와 [프로젝트 지침](AGENTS.md)을 확인하세요. [목업 인수 기준](docs/mockup-contract.md)과 [상태 소유권](docs/architecture.md)에 사용자 동작과 설계 선택을 기록했습니다.

예시 상품은 `src/features/wishlist/demo-data.ts`에 있습니다. 사진과 폰트 출처는 [이미지 출처](docs/image-credits.md)에 있습니다.

## 다음 단계

화면 피드백을 반영한 뒤 실제 저장과 인증을 연결합니다. 현재는 외부 쇼핑몰에 요청하지 않으며, Google 로그인, Supabase, 가격 추적과 실제 단축어 연결은 제공하지 않습니다. [후속 계획](docs/roadmap.md)에 연결 순서를 기록했습니다. 배포는 별도 승인 후 진행합니다.
