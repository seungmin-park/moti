# 목업의 상태 소유권

상품은 한 배열에 남는다. 위시와 구매완료 화면은 같은 상품을 구매 상태로 걸러 보여준다. 구매완료와 실행 취소는 구매 정보만 바꾸므로 메모, 원본 URL과 컬렉션이 사라지지 않는다.

`src/features/wishlist/model.ts`의 순수 reducer가 상태와 검증 규칙을 소유한다. React는 명령을 전달하고 결과를 렌더링한다. 검색어, 열린 대화상자와 저장 전 입력값은 화면 안에 둔다. 수집 결과는 명시적인 예시이며 외부 URL을 요청하지 않는다.

```text
사용자 입력 → 화면 이벤트 → 도메인 reducer → 현재 세션 상태 → 목록과 상세
```

## 설계 비교

| 기준 | A. reducer | B. Wishlist 클래스 |
| --- | --- | --- |
| 상태 소유권 | React reducer 한 곳 | 외부 snapshot과 구독 관리 |
| 중복과 실패 규칙 | 순수 전환과 결과 상태 | 메서드의 동기 반환값 |
| 구매 복원 | 구매 필드만 복원 | 구매 리비전으로 복원 |
| 테스트 | 순수 함수 직접 실행 | 인스턴스와 구독 검증 필요 |
| 목업 복잡도 | 별도 구독 없음 | snapshot 캐시와 구독 추가 |

A를 선택했다. B에서 가격 미상은 정렬의 끝에 두는 규칙과 오래된 실행 취소를 무시하는 규칙을 반영한다. 데이터가 적은 목업에 외부 저장소와 구독 프로토콜을 추가하지 않는다. 양쪽 모두 배열 하나, 보수적인 URL 비교, 선택적 구매 정보, 수집 실패 시 링크 보존에 동의했다.

두 후보는 현재 환경의 같은 모델에서 독립적으로 작성했다. 다른 모델 계열은 제공되지 않아 pstack의 교차 모델 심사는 생략했다. 부모 에이전트가 두 설계 전체를 비교했다.

## 작업 분리

- Blocking first steps. 인수 기준, 두 설계 비교, Node와 테스트 도구 준비를 먼저 끝낸다.
- Independent workstreams. 구현 담당자는 `src`와 `tests/ui`를 소유한다. 조정자는 설정, 정적 이미지, 문서, CI와 전달을 소유한다.
- Shared mutable state. 코드 상태는 구현 담당자만 수정한다. 검증 후 수정 시 소유권을 명시적으로 넘긴다.
- Smallest safe decomposition. 상품과 컬렉션 UI는 하나의 동작이므로 한 구현 담당자가 테스트부터 작성한다. 조정자는 실제 화면과 결과를 별도로 검증한다.

## 화면 방향

design-taste-frontend의 Editorial greeting, seed 1304296013을 사용했다. 개인 보관함에 맞는 밝은 배경과 넓은 이미지 영역을 선택했다. 한글 본문은 로컬 Pretendard를 사용한다. 제목은 28px로 제한한다. 카드 그림자는 쓰지 않고, 모바일에서는 두 열과 하단 탐색으로 바뀐다. 브랜드는 작은 moti 워드마크와 북마크 모양을 사용한다.

화면이 먼저 답하는 질문은 내가 담아둔 물건이 무엇인지다. 큰 상품 이미지가 이 질문에 답한다. 다음 행동은 링크 추가다. 예시 가격과 시각은 데이터에서 읽고, 목록 개수는 현재 데이터에서 계산한다.

## 계층과 데이터 객체

실제 저장 기능은 기능 폴더 안을 계층별로 나눈다. 각 계층은 자기 데이터 객체만 소유하고, 경계에서 `to<대상 타입>` 함수로 변환한다. ESLint가 import 방향을 강제한다.

| 계층 | 폴더 | 데이터 객체 | 책임 | import 금지 |
| --- | --- | --- | --- | --- |
| Presentation | `presentation/` | `<대상><동작>Request`, `<대상><동작>Response`, 하위 `<대상>Response`, `ErrorResponse` | HTTP 본문의 형태 검증, 상태 코드, 공개 API 계약 | `infrastructure/`, Supabase SDK, `pg` |
| Application | `application/` | `<대상><동작>Command`, `<대상><동작>Result` | 업무 입력 정규화와 유스케이스 실행, 저장소 포트 정의 | `infrastructure/`, `presentation/`, Next, React, Supabase SDK |
| Domain | `domain/` | 접미사 없는 명사 (`Product`, `Collection`, `Library`) | 업무 개념과 규칙. 외부 표현과 무관하다. | 다른 모든 계층, 프레임워크, zod |
| Infrastructure | `infrastructure/` | `<대상>Row` | DB·외부 서비스 응답 형태의 검증과 도메인 변환 | `presentation/`, Next, React |
| Screen | `screen/` | 화면 상태(`LibraryScreenState`, `ScreenEvent`)와 표시 값(`ProductCardView`) | 브라우저에서 공개 API를 호출하는 클라이언트. 응답을 계약 스키마로 검증하고 오류 코드를 화면 결과로 바꾼다. | `application/`, `domain/`, `infrastructure/`, `_server`, Supabase, `next/headers`, 공개 계약이 아닌 `presentation/`, 목업 상태 |

한 요청은 `LinkSaveRequest → LinkSaveCommand → Product ↔ ProductRow → LinkSaveResult → LinkSaveResponse` 순서로 이름이 바뀐다. 어간(`LinkSave`)을 계층 사이에서 유지해 한 유스케이스의 객체를 이름으로 찾는다. Presentation은 사용자가 정한 `<대상><동작>Request/Response` 형식을 따른다. Infrastructure는 Supabase RPC가 돌려주는 JSON 행이라 `Row`를 쓴다. `Entity`는 도메인 엔티티와 혼동되므로 쓰지 않는다.

계층과 무관한 순수 규칙(`src/features/wishlist/link.ts`, `collection-name.ts`)은 목업, 서버 명령과 실제 화면이 함께 쓴다. 규칙을 화면에 복사하지 않는다. 의존 객체를 조립하는 위치는 `src/app`의 Route Handler다. 같은 이름의 응답 객체가 도메인 객체와 모양이 같아도 직접 반환하지 않고 변환 함수를 거친다. 도메인 변경이 공개 API로 새지 않게 하기 위해서다.

## 실제 보관함 화면

`/`는 정적 화면을 보낸 뒤 브라우저에서 `GET /api/library`를 호출한다. Server Component는 쿠키를 쓸 수 없다. Supabase는 만료된 접근 토큰을 갱신할 때 쿠키를 쓰므로, 화면 렌더링 중 세션을 읽으면 갱신 결과를 잃는다. Route Handler는 갱신 쿠키를 응답에 싣는다. 실제 HTTP 테스트가 이 동작을 확인한다. 접근 판정, 출처 검사와 오류 계약은 API 한 곳에 남는다.

화면 상태는 `screen-state.ts`의 순수 `transition(state, event) → { state, call }`이 소유한다. 단계는 `loading`, `failed`, `ready`, `leaving`이다. 저장 중인 대화상자는 닫히지 않고 두 번 제출되지 않는다. `leaving`은 로그인 이동을 시작한 뒤 늦게 도착한 응답을 무시한다. `useLibraryScreen`은 호출 결과를 다시 사건으로 넣는 얇은 연결이다.

```text
화면 사건 → transition → 새 상태 + API 호출 → library-api(계약 검증·오류 대응표) → 결과 사건 → transition
```

| 기준 | A. 별도 화면 모듈 | B. 목업과 공유하는 화면 틀 |
| --- | --- | --- |
| 변경 크기(후보 추정) | 약 1,700줄 추가, 목업 변경 거의 없음 | 약 2,400줄 추가·1,000줄 이동 |
| 목업 회귀 위험 | 낮음. `Dialog` 분리만 | 중간. 목업 화면 세 파일 재구성 |
| 없는 기능 처리 | 실제 화면에 만들지 않음 | 빈 slot으로 생략 |
| 이후 단위 | 이미지·가격·구매가 붙을 때 표시 코드가 일부 겹칠 수 있음 | 어댑터와 slot으로 추가 |

A를 선택했다. 2b의 실제 화면은 조회·링크 담기·컬렉션 만들기만 제공하므로 공유 틀의 이득이 비용보다 작다. B를 설계한 후보도 2b만 보면 더 비싸다고 평가했다. 일반 대화상자 틀은 복사하지 않고 `wishlist/Dialog.tsx`로 분리해 함께 쓴다. 3~5단위에서 실제 화면에 이미지·가격·구매가 붙을 때 공유 틀을 다시 검토한다.

두 후보는 같은 모델 계열에서 독립적으로 작성했다. 다른 계열 심사는 제공되지 않아 생략했다. 두 후보는 브라우저 호출, Server Component 로그인 화면, 순수 전환, 오류 코드 대응표와 실제 스택 브라우저 검사에 동의했다.

## 상품 정보 수집

`src/features/metadata/`가 수집을 소유한다. 도메인은 이름·가격 규칙과 오류 코드, 응용 계층은 `PageSource`·`CollectionJobStore` 포트와 결코 예외를 던지지 않는 실행기, 인프라는 안전한 가져오기·HTML 읽기·Supabase 어댑터다. Presentation은 `next/server`와 `next/headers`를 가져오지 않는다. `after()`는 `src/app`의 조립 위치에서만 부른다.

```text
POST /api/links → 저장 → 응답 → after(): claim → 안전한 가져오기 → 읽기 → complete | fail
화면: 대기·수집 중 상품이 있으면 GET /api/library를 다시 읽고 세대·단계가 앞선 결과만 반영
```

작업 상태의 원천은 DB다. 임대 토큰, 세대, 시도 횟수 검사는 SQL에만 있고 TypeScript에 복제하지 않는다. 설계 비교와 검증은 [changes/metadata.md](changes/metadata.md)에 있다.

