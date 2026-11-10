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

Vitest는 persistence와 service 파일을 한 번에 하나씩 실행한다. 소유자 설정이 하나인 앱의 성격에 맞춘 격리다. JSON 결과에서 두 계층의 실제 통과 개수를 확인하고 테스트 0개·skip·todo·실패를 거절한다. DB 시작·마이그레이션·정리가 실패해도 검증은 실패한다. Ctrl-C나 종료 신호에는 시작 프로세스가 실제로 닫힌 뒤 소유한 스택을 정리한다. CI의 `database` 작업이 같은 명령을 실행한다.

현재 개발 세션에서는 native Supabase 기동과 Auth health HTTP 200까지 확인했다. 직접 DB 연결은 로컬 권한 제한에 막혔고 권한 확대 요청도 자동 거절됐다. 해당 오류를 기능 테스트의 Red나 저장 검증 완료로 기록하지 않는다. 최초 RPC 요구사항의 Red와 구현 후 Green은 CI에서 확인할 예정이다.
