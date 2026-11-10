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
- [ ] Rebase into small, ordered commits. Stack follow-ups.
- [x] If the design is contested, `interrogate` before shipping. skip: 두 설계를 비교한 뒤 미해결 설계 이견이 없다.
- [ ] Run **Opening a PR**.

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

## 검증 결과

2026-11-11에 최종 소스를 새 프로덕션 서버에서 실행했다. 기존 미리보기와 분리한 주소는 `http://localhost:3104`다.

- Red. 복수 컬렉션 저장과 존재하지 않는 ID의 원자적 거절이 단위 테스트에서 실패했다. 브라우저에서는 새 정렬 메뉴, 컬렉션 선택과 중립 팔레트가 없어 신규 테스트 5개가 실패했다. [도메인 로그](../evidence/controls/red-domain.txt)와 [UI 로그](../evidence/controls/red-ui.txt)를 보존했다. 포트 권한 오류는 Red로 세지 않았다.
- Green. `npm test`의 순수 단위 23개, `npm exec -- playwright test --headed --workers=1`의 PC Chromium 16개와 iPhone 크기 WebKit 16개가 모두 통과했다. lint, typecheck, 프로덕션 build와 pstack 원본 검사도 통과했다.
- Refactor. 테스트의 플랫폼별 Tab 키 선택을 헬퍼로 정리했다. macOS WebKit의 기본 Tab은 일반 버튼을 건너뛰므로 전체 컨트롤 탐색에는 Option-Tab을 사용한다. 별도의 순수 HTML로 플랫폼 동작을 확인했으며, 기본 Tab으로 열린 메뉴를 닫는 검사는 유지했다. 정리 후 신규 10개와 최종 전체 32개를 통과했다.
- 화면. 1440px Chromium과 390px WebKit에서 목록, 검색 포커스, 정렬 메뉴, 링크 추가, 상세 수집 중·실패, 구매완료, 컬렉션, 공유 안내와 세 가지 공유 결과를 검사했다. 총 24개 화면 상태의 가로 넘침·초록 UI 스타일과 페이지 오류는 없었다. 상품 사진의 색상은 검사 대상에서 제외했다. [관찰 결과](../evidence/controls/observations.json)에 기록했다.
- 접근성. 정렬 메뉴와 링크 추가 창의 axe WCAG A/AA 위반은 두 브라우저 모두 0개다. 키보드 초점 표시는 유지했고, 정렬 트리거의 좌우 padding은 모두 12px다. 자동 검사는 모든 접근성을 보장하지 않는다.
- 검토. 구현자와 분리해 전체 diff를 검토했다. 추가 동작 결함을 찾지 못했다. 별도 주석 검토의 삭제 후보와 `MUST KILL`은 0개다. Cursor 전용 deslop 도구가 없어 diff를 직접 정리했다.

[PC 정렬](../evidence/controls/desktop-sort.png), [모바일 정렬](../evidence/controls/mobile-sort.png), [PC 링크 추가](../evidence/controls/desktop-add.png), [모바일 링크 추가](../evidence/controls/mobile-add.png)를 직접 읽고 확인했다. 모바일의 긴 입력 창은 내부 스크롤로 제출 버튼에 도달하며 실제 저장 흐름을 통과했다. 화면 외부의 지연 로딩 이미지 전체를 기다리던 최초 보조 캡처는 중단하고, 화면에 보이는 이미지의 로드를 기다리도록 수정한 뒤 완료했다.

실제 iPhone·물리 키보드·iOS 공유 메뉴는 이번 검증 범위가 아니다. 인증과 영구 저장은 연결하지 않았다. GitHub의 현재 보호 규칙과 필수 리뷰는 없고 자동 병합도 꺼져 있어, 현재 head의 CI·리뷰를 직접 확인한 후 그 head를 지정해 병합한다. 실제 PR·CI·병합 결과는 전달 기록에 남긴다.
