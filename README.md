# moti

갖고 싶은 물건을 모아두는 개인 위시리스트입니다. 링크를 담고, 컬렉션으로 묶고, 구매한 물건을 기록합니다.

Next.js와 TypeScript로 만들고 Supabase에 저장합니다. 화면은 세 경로입니다.

- `/`: 허용한 Google 계정 하나의 실제 보관함입니다. 링크와 컬렉션을 저장하고 다시 읽습니다. Supabase 설정(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `MOTI_OWNER_GOOGLE_SUBJECT`)이 없으면 로그인 화면의 설정 누락 안내로 이동합니다.
- `/login`: Google 로그인 진입과 실패 안내입니다.
- `/demo`: 예시 데이터 목업입니다. 모든 상품과 가격은 예시이며 새로고침하면 처음으로 돌아갑니다.

## 실행

Node.js 24를 사용합니다. asdf 사용자는 `.tool-versions`를 적용할 수 있습니다.

```sh
npm ci
npm run dev
```

[http://localhost:3100/demo](http://localhost:3100/demo)에서 위시리스트, 구매완료, 컬렉션과 공유 저장 안내를 조작할 수 있습니다. 실제 보관함은 Supabase와 Google 로그인 설정이 필요합니다.

## 검증

처음 실행할 때 브라우저를 설치합니다.

```sh
npx playwright install chromium webkit
npm run verify
```

`verify`는 원본 pstack 파일, ESLint, TypeScript, Vitest, 실제 Supabase 저장·HTTP·화면 테스트, 프로덕션 빌드와 Playwright를 확인합니다. DB 검증은 Docker 없이 공식 native runtime을 사용합니다. 실행 환경과 데이터 정리는 [실제 저장 테스트](docs/test-database.md)를 따릅니다. 브라우저 검사는 PC Chromium과 iPhone 크기의 WebKit에서 실행합니다. 실제 iPhone 기기나 iOS 공유 메뉴 검증을 뜻하지 않습니다.

Playwright는 개발 서버와 별개인 3101 포트에 프로덕션 서버를 시작합니다. [기능 지도](docs/feature-map.md)와 [프로젝트 검증 스킬](tools/verify-moti/SKILL.md)에 사용자 흐름과 재실행 방법이 있습니다.
Domain·Persistence·Service·API의 검증 범위와 데이터 정리는 [테스트 지침](docs/testing.md)을 따릅니다.

## 개발 지침

사용자가 지정한 [원본 pstack](https://github.com/cursor/plugins/tree/main/pstack)을 `tools/pstack`에 설치했습니다. [설치 범위](docs/pstack-installation.md)와 [프로젝트 지침](AGENTS.md)을 확인하세요. [목업 인수 기준](docs/mockup-contract.md)과 [상태 소유권](docs/architecture.md)에 사용자 동작과 설계 선택을 기록했습니다.

예시 상품은 `src/features/wishlist/demo-data.ts`에 있습니다. 사진과 폰트 출처는 [이미지 출처](docs/image-credits.md)에 있습니다.

## 다음 단계

실제 저장·단일 계정 인증·보관함 화면, 상품 정보와 사진 수집, 정리와 구매 기록, 백업과 복원, iPhone 공유 단축어의 추가 전용 저장 키, 전용 작업 키로 하루 세 번 부르는 정기 수집과 매일 가격 확인, 열 때 남은 사진 정리를 연결했습니다. 정기 실행은 저장소 소유자가 GitHub에 비밀값 `MOTI_WORKER_TOKEN`과 변수 `MOTI_WORKER_URL`을 넣기 전에는 건너뜁니다([정기 수집](docs/changes/scheduled-runs.md), [가격 확인](docs/changes/price-check.md)). 어떤 상품도 쓰지 않는 사진 사본은 소유자가 보관함을 열 때 지웁니다([남은 사진 정리](docs/changes/picture-sweep.md)). 실제 iPhone 단축어, Google 로그인과 운영 Supabase는 배포 전에 따로 확인합니다. [구현 순서](docs/backend-implementation.md)와 [체크포인트](docs/implementation-checkpoint.md)에 상태를 기록합니다. 배포 전 외부 설정의 순서와 흐름별 검증 범위는 [인계 문서](docs/hand-back.md)에 있습니다. 배포는 별도 승인 후 진행합니다.
