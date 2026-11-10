# moti 목업 인수 기준

## 목적과 범위

개인 사용자가 사고 싶은 물건을 링크로 모으고, 구매한 물건과 컬렉션을 한곳에서 관리하는 흐름을 검증한다. 첫 결과물은 Next.js와 TypeScript로 구현한 반응형 목업이다. 화면 승인을 받기 전에는 Supabase, Google 인증, 수집 서버, 가격 추적, 실제 iOS 단축어를 연결하지 않는다.

기존 코드와 저장소, A안의 이미지 파일은 없다. A안은 이미지 중심 카드와 밝고 차분한 개인 보관함으로 해석한다. PC에서 왼쪽 탐색, 모바일에서 하단 탐색을 제공한다. 예시 상품과 예시 가격임을 표시한다. 조작은 메모리에만 남고 새로고침하면 초기 예시로 돌아간다.

## 동작

1. 위시 목록에서 상품 이미지, 이름, 쇼핑몰, 원화 가격, 컬렉션을 확인한다. 검색, 카테고리, 정렬을 조합하고 초기화할 수 있다. 일치하는 상품이 없으면 검색 초기화 행동을 제공한다.
2. 링크 추가는 HTTP 또는 HTTPS URL을 검사한다. URL과 선택 옵션을 먼저 보관한다. 추적 파라미터만 다른 링크는 중복으로 안내하고 기존 상품을 연다. 옵션이 다르면 별도 상품으로 둔다.
3. 정보 수집 중, 성공, 실패는 명시적인 데모 상태다. 실패해도 링크를 유지한다. 재시도나 직접 제목 수정이 가능하다. 실제 수집을 했다고 표시하지 않는다.
4. 상품 상세에서 원본 링크, 예시 가격과 확인 시각, 메모, 컬렉션을 읽고 수정한다. 닫았다 다시 열어도 현재 세션의 변경을 유지한다.
5. 구매완료는 즉시 상태를 바꾼다. 선택 입력인 구매일과 실구매가는 별도로 기록한다. 빈 값과 0원을 구분한다. 실행 취소와 위시로 되돌리기는 컬렉션과 메모를 보존한다.
6. 컬렉션 생성과 이름 변경, 상품 묶기, 컬렉션별 필터가 동작한다. 빈 이름과 중복 이름을 안내한다. 빈 컬렉션에서 상품을 추가할 수 있다.
7. iPhone 공유 저장 안내는 최초 연결 과정과 저장 성공, 중복, 실패 결과를 체험할 수 있는 데모다. 설치 또는 연결 완료를 거짓으로 표시하지 않는다.
8. 모바일 390×844와 PC 1440×900에서 주요 흐름을 직접 조작한다. 375px와 태블릿에서도 가로 넘침이 없어야 한다. 대화상자는 키보드로 열고 닫으며 초점을 가두고 원래 위치로 복원한다.

## 책임과 검증

상품과 컬렉션의 현재 세션 상태는 한 도메인 모듈이 소유한다. 화면은 상태를 읽고 명시적인 명령을 전달한다. HTTP 요청과 저장소 연결은 목업의 책임 밖이다. 외부 URL 검사와 상품 중복 정책은 화면 코드에 복제하지 않는다.

Vitest로 URL, 중복과 옵션, 구매완료와 복원, 컬렉션과 메모의 불변 조건을 검증한다. Playwright로 실제 사용자 입력부터 UI 결과까지 모바일과 PC에서 검증한다. 테스트는 행동 구현 전에 작성하고 행동 부재로 실패하는 로그를 남긴다.

## pstack 적용 기록

원본 `cursor/plugins/pstack`의 고정 커밋은 `tools/pstack/source.json`에 있다. Cursor 전용 모델은 이 환경에서 제공되지 않으므로 사용 가능한 기본 모델로 독립적인 설계 후보를 만든다. 서로 다른 모델 계열의 심사였다고 보고하지 않는다. Cursor 전용 control-ui와 deslop은 제공되지 않아 실제 Playwright 조작과 직접 diff 검토로 수행한다.

## 작업 목록

- [x] `how` over the affected subsystem. Greenfield. 폴더가 비어 있고 연동 대상은 없다.
- [x] `architect` for parallel design exploration.
- [x] Write the throughput checkpoint as four todo items.
- [x] Delegate code-writing to a subagent with the agreed contract.
- [x] Verify on the matching surface. PC Chromium과 iPhone 크기 WebKit에서 headed E2E 22개 통과, 375px 긴 입력과 화면 캡처 확인.
- [ ] Rebase into small, ordered commits. Stack follow-ups.
- [x] If the design is contested, `interrogate` before shipping. skip: 설계 이견이 없어 별도 논쟁 심사는 하지 않았다.
- [ ] Run **Opening a PR**.

Architect. Ground, Sketch, Agree와 Implement를 완료했다. 후보와 선택은 `architecture.md`에 기록했다. Scrap은 설계 충돌이 없어 적용하지 않았다.
Arena. Frame, Fan out, Pick과 Graft를 완료했다. Cross-judge는 다른 모델 계열이 없어 생략했다. 부모 에이전트의 설계 비교와 구현 담당자 외의 독립 동작 검토를 수행했다.

검토 기준은 상태 소유권, 실패 시 링크 보존, 구매 복원 시 메모와 컬렉션 보존, 테스트 가능성, 목업에 필요한 최소 복잡도다.
