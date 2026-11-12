# CI 작업과 브라우저 검사 이름 정리

동작은 바꾸지 않고 이름을 실제 역할에 맞췄다. 사용자가 2026-11-12에 두 이름 변경과 `main` 보호 규칙의 필수 검사 이름 변경을 승인했다.

| 이전 | 이후 | 실제 내용 |
| --- | --- | --- |
| CI 작업 `mockup` | `app` | lint, 타입 검사, 단위 테스트, 빌드, Supabase 없는 브라우저 검사. 목업만 검사하지 않는다. |
| `tests/e2e`, `npm run test:e2e` | `tests/ui`, `npm run test:ui` | Supabase 없이 `/demo`, `/login`, 설정 누락 화면을 PC Chromium과 iPhone 크기 WebKit에서 확인한다. |

`tests/browser`는 그대로 둔다. 실제 테스트 Supabase와 세션 쿠키로 `/`를 확인하는 검사이며 `npm run test:database`의 마지막 단계다. 이전에는 DB 없는 검사가 "e2e"이고 실제로 끝까지 연결된 검사가 "browser"여서 이름의 뜻이 거꾸로였다. `tests/browser`를 `e2e`로 바꾸지 않은 이유는 같은 이름이 예전 기록과 다른 뜻을 갖게 되기 때문이다.

## 세 필수 검사의 역할

| 작업 | 하는 일 | 없으면 생기는 공백 |
| --- | --- | --- |
| `pstack` | `tools/pstack` 스킬 파일을 지정한 원본 커밋의 해시와 비교한다. 약 5초. | 작업 방식의 기준인 설치본이 바뀌어도 알 수 없다. |
| `app` | lint(계층 import 규칙), 타입 검사, 단위 테스트(API 문서와 계약 일치, 실제 소켓의 외부 주소 차단 포함), 빌드, `tests/ui`. 약 3.5분. | 대부분의 규칙·계약 회귀와 목업·로그인 화면 회귀를 CI가 놓친다. |
| `database` | native Supabase 스택에서 persistence·service, 실제 HTTP, `tests/browser`. 약 3분. | RLS·RPC·마이그레이션·실제 HTTP·실제 화면을 CI가 확인하지 않는다. |

경로 필터로 필수 검사를 건너뛰게 하면 결과가 보고되지 않아 PR이 막히므로 세 작업 모두 항상 실행한다. 두 브라우저 작업은 `playwright install --with-deps`가 Ubuntu 패키지 서버에서 WebKit 의존성을 받는다. 2026-11-11에는 이 서버의 주소를 찾지 못해 두 작업이 함께 실패했다. WebKit 제외는 iPhone 대체 검증을 없애고, 두 작업 합치기는 같은 의존을 남기며, Playwright 컨테이너는 프로젝트의 Docker 미사용 결정과 PostgreSQL의 root 실행 거부와 충돌해 택하지 않았다.

## 남겨 둔 기록

`docs/changes`의 이전 변경 기록, `docs/verification.md`의 이전 항목, `docs/evidence`의 Red 출력은 당시 이름을 그대로 둔다. 그 시점의 명령과 결과를 기록한 것이기 때문이다.
