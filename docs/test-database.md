# 실제 저장 테스트

운영 저장소는 Supabase PostgreSQL이다. 테스트에서는 같은 Supabase의 PostgreSQL·Auth·PostgREST를 별도 임시 실행한다. Docker 설치는 필요하지 않다. 공식 CLI 3.1.0과 `supabase/supabase.lock`에 고정한 native 서비스를 사용한다. 이 모드는 실험적이며 지원 환경은 Apple Silicon macOS 14 이상과 glibc 2.35 이상 Linux다. [Supabase 공식 설명](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes)

```sh
npm ci
npm test
npm run test:database
```

`test:database`는 전체 Next.js 앱을 시작하지 않는다. 새 임시 폴더로 마이그레이션·CLI 설정을 복사하고 native Supabase를 시작한다. API는 `127.0.0.1:56321`, PostgreSQL은 `127.0.0.1:56322`를 사용한다. 포트가 사용 중이면 실패하므로 다른 프로세스를 자동 종료하지 않는다. 실행기가 생성한 스택만 종료하고 임시 데이터를 정리한다. 동시에 두 번 실행하지 않는다.

첫 실행에는 공식 서비스 배포 파일 다운로드가 필요하다. `SUPABASE_HOME`은 실행별 임시 폴더를 사용한다. 로그인된 운영 프로젝트나 `.env`의 DB 주소를 테스트 대상으로 받지 않는다. CLI가 생성한 연결 정보는 임시 파일에만 저장하며 공개 Git과 CI 로그에 출력하지 않는다. CLI native 상태 파일 형식은 고정 버전에 맞춰 읽고, 프로젝트 경로·스택명·런타임·포트를 확인한다.

실행기는 새 DB에 임의 실행 ID를 기록한다. Fixture는 파일의 실행 ID, 로컬 주소, DB의 실행 ID를 모두 확인한 뒤에만 데이터를 생성하거나 정리한다. 각 테스트의 두 사용자만 `afterEach`에서 삭제한다. 외래키 cascade가 해당 상품·소속·작업을 정리한다. 테스트를 트랜잭션으로 감싸 rollback하지 않는다. 실제 저장 명령의 내부 원자성은 별도 요구사항이다.

Auth fixture는 로컬 Auth의 관리자 API로 테스트 사용자를 만들고, 테스트 DB에 Google identity를 넣은 뒤 실제 로컬 JWT로 PostgREST를 호출한다. 운영 코드에는 테스트 인증 우회가 없다. 이 검사는 JWT·DB 접근 제한의 통합 검증이며 실제 Google OAuth 로그인을 검증했다는 뜻은 아니다.

실행은 세 단계다. 먼저 Next 없이 persistence와 service를 실행한다. 통과하면 미리 빌드한 앱(`npm run build`)을 `127.0.0.1:3180`에서 시작하고 `tests/http`로 실제 HTTP 요청을 보낸다. 앱은 같은 임시 Supabase에 연결하며 소유자 subject는 `moti-http-owner`로 고정한다. 빌드 결과가 없거나 포트가 사용 중이면 실패한다. 앱은 실행기가 직접 종료한다. native 스택은 설정한 포트 외에도 실행 중에 내부 포트를 고른다. 로컬에서 13635, 15702, 16461, 56353을 관찰했고 CI에서는 이전 앱 포트 56380이 이미 사용 중이어서 앱이 시작하지 못했다. 점유한 프로세스는 확인하지 못했다. 그래서 앱 포트는 OS 임시 포트 범위보다 낮은 3180을 쓴다. 세션 쿠키는 `@supabase/ssr`로 실제 로그인해 만든다. Google 리다이렉트만 거치지 않는다. HTTP 단계는 세션의 만료 시각을 과거로 바꾼 쿠키로 요청해 Route Handler가 새 토큰을 `Set-Cookie`로 돌려주는지도 확인한다. 실제 화면이 브라우저에서 API를 호출하는 설계가 이 동작에 의존한다.

HTTP 단계가 통과하면 같은 앱과 스택에 `playwright.database.config.ts`로 브라우저 검사를 실행한다. 같은 쿠키를 Playwright 컨텍스트에 넣고 `/`에서 링크·컬렉션 저장, 새로고침과 새 세션의 유지, 중복, 사라진 컬렉션, 로그아웃, 거절 계정과 접근성을 확인한다. PC Chromium과 iPhone 크기 WebKit에서 한 번에 하나씩 실행한다. JSON 결과에서 두 프로젝트의 실제 통과 개수를 확인하고 skip·flaky·실패·프로젝트 누락을 거절한다. 먼저 `npx playwright install chromium webkit`이 필요하다. CI의 `database` 작업도 브라우저를 설치하고 HTML 보고서를 보관한다.

Vitest는 persistence와 service 파일을 한 번에 하나씩 실행한다. 소유자 설정이 하나인 앱의 성격에 맞춘 격리다. JSON 결과에서 두 계층의 실제 통과 개수를 확인하고 테스트 0개·skip·todo·실패를 거절한다. DB 시작·마이그레이션·정리가 실패해도 검증은 실패한다. Ctrl-C나 종료 신호에는 시작 프로세스가 실제로 닫힌 뒤 소유한 스택을 정리한다. CI의 `database` 작업이 같은 명령을 실행한다.

macOS의 임시 폴더는 `/var`와 `/private/var` 두 경로로 보인다. CLI는 실제 경로를 기록하므로 실행기도 `realpath`로 만든 경로를 사용한다. 이전에 로컬 DB를 쓸 수 없다고 기록한 원인은 이 경로 불일치였다. 2026-11-11 Apple Silicon macOS에서 `npm run test:database`가 persistence 33개·service 10개를 실제로 통과했다.

`moti_rpc`는 Supabase의 `auth` 스키마 권한을 받을 수 없다. 사용자 ID는 PostgREST가 넣은 `request.jwt.claims`에서 읽고, Google identity 확인만 마이그레이션 소유자의 좁은 읽기 함수 `moti.has_google_identity`로 수행한다. 거절 검사는 원시 오류 코드 `M0001`까지 확인해 권한 오류가 우연히 `unauthorized`로 통과하지 않게 한다.
