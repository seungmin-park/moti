# 원본 pstack 설치

사용자가 지정한 [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)의 0.15.36을 프로젝트 안에 설치했다. 고정 커밋은 `de8ee15dd1194627d21eb5fcd41cb1873208dabb`다. 58개 스킬과 관련 참조 파일을 `tools/pstack`에 원문 그대로 보관한다. MIT 라이선스를 함께 포함했다.

전역 디렉터리와 프로젝트 `.agents`는 이 실행 환경에서 쓰기가 제한되어 있다. `AGENTS.md`가 프로젝트 설치 경로를 가리킨다. 다음 작업에서도 그 경로의 스킬을 읽을 수 있다. Codex 플러그인 메뉴나 전역 슬래시 명령에 등록한 것은 아니다.

설치에는 skill-installer의 경로 검사와 복사 함수를 사용했다. 네트워크 다운로드는 허용된 curl로 수행했다. 원본 코드나 자동화 스크립트를 실행하는 설치 과정은 없었다. 처음 선택한 backnotprop 미러는 사용자의 원본 지정 후 프로젝트에서 제거했다.

설치본의 출처, 커밋과 스킬 수는 `tools/pstack/source.json`에 있다. 파일 변경 여부는 다음 명령으로 확인한다.

```sh
node scripts/verify-pstack.mjs
```

이 검사는 기록한 SHA-256과 설치 파일을 비교한다. upstream의 보안 심사를 대신하지 않는다. 검증용으로 파일 하나를 변경하면 검사가 실패하고, 복원하면 통과하는 것을 확인한다.

이 프로젝트는 `poteto-mode`, `architect`, `arena`, `tdd`, `model-the-domain`, `experience-first`, `prove-it-works` 원칙을 사용한다. Cursor 전용 모델과 도구는 제공되지 않으므로 실제 사용한 Codex 에이전트, Playwright와 직접 diff 검토를 구분해 기록한다.
