#!/usr/bin/env bash
# One scheduled run: POST the worker key to moti's /api/scheduled-runs and report what the run did. It skips with a
# notice until both values are set, never puts the key on a command line or in the log, and prints only fixed words
# and counts, so nothing the server answers can become a workflow command.
set -euo pipefail

url="${MOTI_WORKER_URL:-}"
token="${MOTI_WORKER_TOKEN:-}"

if [[ -z "$url" || -z "$token" ]]; then
  echo "::notice::MOTI_WORKER_URL 변수와 MOTI_WORKER_TOKEN 비밀값을 넣기 전이라 이번 실행은 건너뛰었어요."
  exit 0
fi
if [[ ! "$url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
  echo "::error::MOTI_WORKER_URL은 https://로 시작하고 경로가 없는 배포 주소여야 해요."
  exit 1
fi
if [[ ! "$token" =~ ^moti_wk_[A-Za-z0-9_-]{43}$ ]]; then
  echo "::error::MOTI_WORKER_TOKEN이 작업 키 형식이 아니에요. moti의 자동 확인에서 만든 키를 그대로 넣어 주세요."
  exit 1
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

# The header reaches curl on stdin. Redirects are not followed, so the key goes only to this address.
if ! status="$(printf 'Authorization: Bearer %s\n' "$token" | curl --silent --proto '=https' --max-time 75 \
  --request POST --header @- --output "$body" --write-out '%{http_code}' "$url/api/scheduled-runs")"; then
  echo "::error::moti에 연결하지 못했어요. 배포 주소와 호스팅 상태를 확인해 주세요."
  exit 1
fi

code="$(jq -r 'if type == "object" and (.error | type) == "string" and (.error | test("^[a-z_]{1,40}$")) then .error else "" end' "$body" 2>/dev/null || true)"

case "$status" in
  200)
    summary="$(jq -c '{stop, collections, prices, failures}' "$body" 2>/dev/null)" || {
      echo "::error::moti의 답을 읽지 못했어요."
      exit 1
    }
    echo "실행을 마쳤어요. $summary"
    ;;
  409)
    echo "::notice::다른 실행이 진행 중이거나 실행 기록이 닫혀 이번 실행은 멈췄어요(${code:-conflict}). 다음 예약 실행에서 이어가요."
    ;;
  429)
    echo "::warning::24시간에 8번까지 실행해요. 다음 예약 실행을 기다려요."
    ;;
  401)
    echo "::error::작업 키가 맞지 않거나 폐기됐어요. moti의 자동 확인에서 새 키를 만들어 GitHub 비밀값 MOTI_WORKER_TOKEN을 바꿔 주세요."
    exit 1
    ;;
  *)
    echo "::error::moti가 HTTP ${status}(${code:-응답 없음})로 답했어요."
    exit 1
    ;;
esac
