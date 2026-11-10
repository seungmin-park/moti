# 정렬·입력·컬렉션 선택 개선

## 인수 기준

- 정렬 메뉴는 같은 스타일의 펼침 목록, 균형 잡힌 좌우 여백과 별도 아래 화살표를 제공한다. 현재 선택을 보여준다.
- 추가 피드백에 따라 UI 전체의 세이지·초록 팔레트를 없앤다. 배경, 텍스트, 버튼, 선택 상태와 체크박스는 흰색·중립 회색·차콜을 사용한다. 상품 사진의 색상은 UI 팔레트에 포함하지 않는다.
- 포인터 클릭 때 초록 outline과 ring이 없다. 입력은 중립 배경·경계로, 키보드 이동은 중립 색상의 명확한 표시로 구분한다. 검색, URL, 옵션, 메모, 상품명, 구매 정보, 컬렉션 입력과 버튼·체크박스를 포함한다.
- 정렬은 클릭·키보드로 선택하고 Escape와 바깥 클릭으로 닫힌다. 선택 시 정렬 결과가 바뀌고 초점이 적절히 돌아간다.
- 링크 추가에서 기존 컬렉션 목록이 보이며 여러 컬렉션을 고를 수 있다. 현재 컬렉션에서 열면 기본 선택한다. 컬렉션 미선택도 허용한다. 입력 오류 후에도 선택을 유지하고, 중복 상품의 기존 정보는 보존한다.
- PC Chromium과 iPhone 크기 WebKit에서 동작한다. 좁은 화면의 넘침과 대화상자 내부 스크롤을 확인한다.

## 작업 순서

- [x] `how` over the affected subsystem. 현재 구현과 브라우저의 초록 테두리·누락된 컬렉션 선택을 확인했다.
- [x] `architect` for parallel design exploration.
- [x] Write the throughput checkpoint as four todo items.
- [x] Delegate code-writing to a subagent with the agreed contract.
- [x] Verify on the matching surface.
- [x] Rebase into small, ordered commits. Stack follow-ups. main과의 분기가 없어 rebase는 필요하지 않았다. 첫 UI 개선 뒤 추가 컬렉션 흐름을 같은 PR의 후속 커밋으로 묶는다.
- [x] If the design is contested, `interrogate` before shipping. skip: 두 설계를 비교한 뒤 미해결 설계 이견이 없다.
- [x] Run **Opening a PR**. [PR #3](https://github.com/seungmin-park/moti/pull/3)를 열었고 추가 피드백을 같은 PR에 반영한다. 실제 병합은 전달 기록으로 확인한다.

Architect. Ground, Sketch, Agree와 Implement를 완료하고 실제 화면을 검증했다. 구조를 폐기할 근거가 없어 Scrap은 적용하지 않았다.
Arena. Frame, Fan out과 Pick을 완료했다. 제공된 모델 계열이 같아 별도 계열의 Cross-judge는 생략했고 두 제안을 직접 비교했다. 컬렉션 모델과 팔레트 정책은 일치해 별도 Graft가 필요하지 않았다.

## 설계 선택

| 기준 | A. React 정렬 메뉴 | B. 기본 popover·radio |
| --- | --- | --- |
| 선택 확정 | 이동과 확정을 구분한다. Escape는 값을 보존한다. | 화살표가 즉시 정렬을 바꾼다. |
| 위치 | 트리거를 기준으로 CSS 배치 | top layer 위치 계산과 스크롤 대응 필요 |
| 범위 | 정렬용 컴포넌트 한 개에 초점·닫힘을 모은다. | 브라우저가 dismiss를 맡지만 위치와 선택 의미를 조정한다. |
| 의존성 | 추가 없음 | 추가 없음 |

A를 선택한다. `SortMenu`는 정렬값과 `onChange`만 받고 펼침·이동·닫힘을 소유한다. 정렬값은 `Mockup`, 실제 정렬 규칙은 기존 도메인에 남긴다. `AddLink`는 선택 ID 배열을 초안으로 소유하고 `link.add.collectionIds`로 전달한다. 도메인이 전체 ID 검증과 중복 제거를 담당한다. 단일 ID 명령은 호출자와 함께 변경한다.

Model the Domain에 따라 선택값과 메뉴 이동 상태를 분리했다. Experience First에 따라 전체 팔레트와 링크 저장 시 복수 컬렉션 선택을 함께 정리한다. Prove It Works에 따라 실제 브라우저 동작과 최종 색상을 직접 검사한다.

## 작업 분리

- Blocking first steps. 기존 화면 재현과 두 설계 비교 후 구현을 시작한다.
- Independent workstreams. 구현자는 `src`와 `tests/e2e`를 소유한다. 조정자는 문서, 독립 화면 검사와 Git 전달을 소유한다.
- Shared mutable state. 구현자가 소스 수정 완료를 알린 뒤 조정자에게 소유권을 돌려준다.
- Smallest safe decomposition. 공통 팔레트와 두 입력 흐름이 같은 화면을 바꾸므로 구현 담당자 한 명이 수정한다.

## 재현

최초 프로덕션 화면에서 검색 입력은 초록 경계와 2px outline, 정렬과 상품 링크는 초록 3px outline을 표시했다. 링크 추가 창의 컬렉션 선택 항목은 0개였다. 원본 상태는 변경하지 않고 별도 브라우저 세션에서 재현했다.

## 첫 번째 UI 정리의 검증

2026-11-11에 최종 소스를 새 프로덕션 서버에서 실행했다. 기존 미리보기와 분리한 주소는 `http://localhost:3104`다.

- Red. 복수 컬렉션 저장과 존재하지 않는 ID의 원자적 거절이 단위 테스트에서 실패했다. 브라우저에서는 새 정렬 메뉴, 컬렉션 선택과 중립 팔레트가 없어 신규 테스트 5개가 실패했다. [도메인 로그](../evidence/controls/red-domain.txt)와 [UI 로그](../evidence/controls/red-ui.txt)를 보존했다. 포트 권한 오류는 Red로 세지 않았다.
- Green. `npm test`의 순수 단위 23개, `npm exec -- playwright test --headed --workers=1`의 PC Chromium 16개와 iPhone 크기 WebKit 16개가 모두 통과했다. lint, typecheck, 프로덕션 build와 pstack 원본 검사도 통과했다.
- Refactor. 테스트의 플랫폼별 Tab 키 선택을 헬퍼로 정리했다. macOS WebKit의 기본 Tab은 일반 버튼을 건너뛰므로 전체 컨트롤 탐색에는 Option-Tab을 사용한다. 별도의 순수 HTML로 플랫폼 동작을 확인했으며, 기본 Tab으로 열린 메뉴를 닫는 검사는 유지했다. 정리 후 신규 10개와 최종 전체 32개를 통과했다.
- 화면. 1440px Chromium과 390px WebKit에서 목록, 검색 포커스, 정렬 메뉴, 링크 추가, 상세 수집 중·실패, 구매완료, 컬렉션, 공유 안내와 세 가지 공유 결과를 검사했다. 총 24개 화면 상태의 가로 넘침·초록 UI 스타일과 페이지 오류는 없었다. 상품 사진의 색상은 검사 대상에서 제외했다. [관찰 결과](../evidence/controls/observations.json)에 기록했다.
- 접근성. 정렬 메뉴와 링크 추가 창의 axe WCAG A/AA 위반은 두 브라우저 모두 0개다. 키보드 초점 표시는 유지했고, 정렬 트리거의 좌우 padding은 모두 12px다. 자동 검사는 모든 접근성을 보장하지 않는다.
- 검토. 구현자와 분리해 전체 diff를 검토했다. 추가 동작 결함을 찾지 못했다. 별도 주석 검토의 삭제 후보와 `MUST KILL`은 0개다. Cursor 전용 deslop 도구가 없어 diff를 직접 정리했다.

[PC 정렬](../evidence/controls/desktop-sort.png), [모바일 정렬](../evidence/controls/mobile-sort.png), [PC 링크 추가](../evidence/controls/desktop-add.png), [모바일 링크 추가](../evidence/controls/mobile-add.png)를 직접 읽고 확인했다. 모바일의 긴 입력 창은 내부 스크롤로 제출 버튼에 도달하며 실제 저장 흐름을 통과했다. 화면 외부의 지연 로딩 이미지 전체를 기다리던 최초 보조 캡처는 중단하고, 화면에 보이는 이미지의 로드를 기다리도록 수정한 뒤 완료했다.

실제 iPhone·물리 키보드·iOS 공유 메뉴는 이번 검증 범위가 아니다. 인증과 영구 저장은 연결하지 않았다. GitHub의 현재 보호 규칙과 필수 리뷰는 없고 자동 병합도 꺼져 있어, 현재 head의 CI·리뷰를 직접 확인한 후 그 head를 지정해 병합한다. 실제 PR·CI·병합 결과는 전달 기록에 남긴다.

## 추가 피드백 · 컬렉션 드롭다운과 즉시 생성

사용자가 링크 추가의 컬렉션 목록을 드롭다운으로 바꾸고 없는 컬렉션을 바로 만들어 추가하도록 요청했다. PR #3의 첫 head는 CI를 통과했지만 병합하지 않고 이 사용자 흐름까지 같은 PR에 반영한다.

- 닫힌 선택 버튼은 현재 선택을 요약한다. 열면 컬렉션 검색과 복수 선택을 제공한다.
- 없는 이름은 같은 패널에서 생성하고 즉시 선택한다. 링크와 옵션, 이전 선택과 추가 창을 유지한다.
- 빈 이름·중복 이름·길이 초과는 기존 도메인 규칙을 따른다. 실패 시 잘못된 ID를 선택하거나 링크를 저장하지 않는다.
- 검색 입력의 Enter는 링크 폼을 제출하지 않는다. 열린 드롭다운의 Escape는 선택 패널만 닫고 초점을 돌려준다.
- 기존 컬렉션 생성 창, 중복 링크와 구매·실행 취소 흐름은 유지한다.

Ground에서 기존 `collection.create`가 추가 창까지 닫는 경계를 확인했다. 선택 ID는 추가 창의 로컬 상태여서 생성 결과와 원자적으로 연결할 소유권을 비교한다. 두 대안을 검토한 뒤 하나의 구현 담당자가 소스와 테스트를 소유한다. 문서와 독립 화면 검증, PR 전달은 조정자가 담당한다. 구현 전 요구 동작이 없는 실패를 확인하고 새 head에서 전체 관련 검증을 다시 실행한다.

두 번째 Architect의 Ground·Sketch·Agree를 완료했다. A안은 선택 ID를 추가 모달의 순수 reducer로 옮겨 생성 결과와 함께 갱신한다. B안은 `AddLink`의 로컬 선택을 유지하지만 생성 결과를 동기 반환하는 외부 상태 저장소로 전체 상태 쓰기 경로를 바꿔야 한다. 변경 범위가 작은 A안을 선택했다. URL·옵션은 기존 로컬 초안으로 유지하고, `CollectionPicker`는 펼침·검색·초점만 맡는다. 도메인의 이름 검증과 ID 생성을 재사용한다. 별도 상태 저장소, 예상 ID와 feedback 감시 effect는 도입하지 않는다.

## 드롭다운 반영 후 최종 검증

2026-11-11에 추가 피드백까지 반영한 소스로 검증했다. 최종 프로덕션 미리보기는 `http://localhost:3105`다.

- 기존 reducer를 순수 앱 상태 모듈로 옮긴 뒤, 새 동작을 하지 않는 액션에서 단위 10개 중 8개가 실패했다. 드롭다운 부재도 실제 브라우저에서 재현했다. [앱 상태 Red](../evidence/controls/red-picker-domain.txt)와 [UI Red](../evidence/controls/red-picker-ui.txt)를 보존했다.
- 검토 중 IME 키의 기본 동작 취소와 패널 밖 초점에서 Escape가 추가 창까지 닫는 문제를 재현했다. [IME Red](../evidence/controls/red-picker-ime.txt), [Escape Red](../evidence/controls/red-picker-escape.txt)를 남겼다. 생성 버튼이 새 항목으로 바뀔 때 바깥 클릭으로 오인하던 문제는 원래 클릭 경로를 사용해 수정했다.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`가 통과했다. 순수 단위는 도메인 23개와 앱 상태 10개다. 최종 `npm exec -- playwright test --headed --workers=1`은 PC Chromium 20개, iPhone 크기 WebKit 20개, 총 40개를 실행하고 모두 통과했다.
- 기존 컬렉션 선택, 검색, 즉시 생성·자동 선택, 입력·선택 유지, 중복·잘못된 이름, 기본 컬렉션 해제, Enter·Escape·바깥 클릭, 긴 이름과 많은 항목의 내부 스크롤을 확인했다. 기존 구매·실행 취소·실구매가·컬렉션 수정 회귀도 통과했다.
- 두 브라우저의 28개 화면 상태에서 가로 넘침·초록 UI 스타일·페이지 오류가 없었다. 정렬 메뉴와 열린 컬렉션 선택을 포함한 링크 추가 창의 axe WCAG A/AA 위반은 각각 0개다. [최신 관찰 결과](../evidence/controls/observations.json), [PC 생성 화면](../evidence/controls/desktop-create.png), [모바일 생성 화면](../evidence/controls/mobile-create.png)을 보존하고 직접 확인했다.
- 구현자와 분리해 상태·입력·닫기 경계와 diff를 검토했다. 별도 주석 검토에서 삭제 후보와 `MUST KILL`은 0개다. 마지막 수정 이후 추가 병합 차단 결함을 찾지 못했다.

컬렉션 생성은 즉시 수행하므로 링크 추가를 취소해도 만든 컬렉션은 세션에 남는다. 새로고침 시 초기화되는 목업이라는 범위는 같다. IME 검사는 조합 중인 합성 키 이벤트를 취소하거나 생성·닫기로 처리하지 않는 경계까지 확인했다. 키 이벤트 취소가 조합 이벤트를 억제할 수 있다는 [UI Events 규칙](https://www.w3.org/TR/uievents/#events-compositionevents)에 맞췄다. 실제 기기의 한글 입력기와 iOS 공유 메뉴는 검증하지 않았다.
