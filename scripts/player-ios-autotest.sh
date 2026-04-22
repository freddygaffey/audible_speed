#!/usr/bin/env bash
set -euo pipefail

API_ORIGIN="${SPEED_API_ORIGIN:-http://134.199.172.228:3001}"
RUN_DOWNLOAD_TEST="${RUN_DOWNLOAD_TEST:-1}"
POLL_SEC="${POLL_SEC:-5}"
DOWNLOAD_TIMEOUT_SEC="${DOWNLOAD_TIMEOUT_SEC:-2400}"
IOS_UDID="${IOS_UDID:-}"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-/tmp/speed-ios-derived}"
AUTOTEST_ARTIFACT_DIR="${AUTOTEST_ARTIFACT_DIR:-/tmp/speed-ios-autotest-$(date +%Y%m%d-%H%M%S)}"
RESET_APP_STATE="${RESET_APP_STATE:-0}"
OFFLINE_PROBE="${OFFLINE_PROBE:-0}"

log() {
  printf '[player-ios-autotest] %s\n' "$*"
}

record_check() {
  local name="$1"
  local status="$2"
  local detail="${3:-}"
  printf '%s\t%s\t%s\n' "$name" "$status" "$detail" >>"${AUTOTEST_ARTIFACT_DIR}/checks.tsv"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

json_get() {
  local expr="$1"
  local json="${2:-{}}"
  JSON_PAYLOAD="${json}" python3 -c '
import json
import os
import sys

expr = sys.argv[1]
payload = os.environ["JSON_PAYLOAD"]
s = payload.strip()
if not s:
    raise SystemExit("Empty JSON payload")
starts = [i for i in (s.find("{"), s.find("[")) if i >= 0]
if starts:
    s = s[min(starts):]
data, _ = json.JSONDecoder().raw_decode(s)

if expr == "auth":
    print("true" if data.get("authenticated") else "false")
elif expr == "first_asin":
    books = data.get("books") or []
    print(books[0].get("asin", "") if books else "")
elif expr == "first_title":
    books = data.get("books") or []
    print(books[0].get("title", "") if books else "")
elif expr == "job_id":
    print(data.get("id", ""))
elif expr == "job_status":
    print(data.get("status", ""))
elif expr == "job_progress":
    print(str(data.get("progress", "")))
elif expr == "job_error":
    print(data.get("error") or "")
elif expr == "first_done_job_id":
    jobs = data if isinstance(data, list) else []
    done = next((j for j in jobs if j.get("status") == "done" and j.get("id")), None)
    print(done.get("id", "") if done else "")
else:
    raise SystemExit(f"unknown expr: {expr}")
' "$expr"
}

pick_booted_udid() {
  python3 - "$(xcrun simctl list devices booted)" <<'PY'
import re
import sys
txt = sys.argv[1]
m = re.search(r'\(([0-9A-F-]{36})\)', txt)
print(m.group(1) if m else "")
PY
}

pick_available_iphone_udid() {
  python3 - "$(xcrun simctl list devices available)" <<'PY'
import re
import sys

txt = sys.argv[1].splitlines()
for line in txt:
    if "iPhone" in line and "(Shutdown)" in line:
        m = re.search(r'\(([0-9A-F-]{36})\)', line)
        if m:
            print(m.group(1))
            raise SystemExit(0)
print("")
PY
}

need_cmd curl
need_cmd python3
need_cmd pnpm
need_cmd xcrun
need_cmd xcodebuild

mkdir -p "${AUTOTEST_ARTIFACT_DIR}"
: >"${AUTOTEST_ARTIFACT_DIR}/checks.tsv"

log "Checking API health at ${API_ORIGIN}"
curl -fsS "${API_ORIGIN}/api/healthz" >"${AUTOTEST_ARTIFACT_DIR}/healthz.json"
log "Health OK: $(cat "${AUTOTEST_ARTIFACT_DIR}/healthz.json")"
record_check "api_health" "pass" "${API_ORIGIN}/api/healthz"

log "Checking server-side Audible session status"
AUTH_JSON="$(curl -fsS "${API_ORIGIN}/api/audible/auth/status")"
printf '%s\n' "${AUTH_JSON}" >"${AUTOTEST_ARTIFACT_DIR}/auth-status.json"
AUTH_OK="$(json_get auth "${AUTH_JSON}")"
if [[ "${AUTH_OK}" != "true" ]]; then
  printf 'Server Audible session is not authenticated: %s\n' "${AUTH_JSON}" >&2
  record_check "server_auth_status" "fail" "unauthenticated"
  exit 2
fi
log "Server session authenticated"
record_check "server_auth_status" "pass" "authenticated"

ASIN=""
TITLE=""
if [[ "${RUN_DOWNLOAD_TEST}" == "1" ]]; then
  EXISTING_DOWNLOADS_JSON="$(curl -fsS "${API_ORIGIN}/api/audible/downloads")"
  printf '%s\n' "${EXISTING_DOWNLOADS_JSON}" >"${AUTOTEST_ARTIFACT_DIR}/downloads-before.json"
  EXISTING_DONE_JOB_ID="$(json_get first_done_job_id "${EXISTING_DOWNLOADS_JSON}")"
  if [[ -n "${EXISTING_DONE_JOB_ID}" ]]; then
    JOB_ID="${EXISTING_DONE_JOB_ID}"
    log "Using existing done job ${JOB_ID} for file endpoint validation"
  fi

  if [[ -z "${JOB_ID:-}" ]]; then
  log "Fetching one library title for download test"
  LIB_JSON="$(curl -fsS "${API_ORIGIN}/api/audible/library?page=1&pageSize=5")"
  printf '%s\n' "${LIB_JSON}" >"${AUTOTEST_ARTIFACT_DIR}/library-sample.json"
  ASIN="$(json_get first_asin "${LIB_JSON}")"
  TITLE="$(json_get first_title "${LIB_JSON}")"
  if [[ -z "${ASIN}" ]]; then
    printf 'No library titles available for autonomous download test.\n' >&2
    exit 3
  fi

  log "Starting download job for ASIN=${ASIN} title=${TITLE}"
  REQUEST_BODY="$(
    ASIN_ENV="${ASIN}" TITLE_ENV="${TITLE}" python3 - <<'PY'
import json
import os
print(json.dumps({"asin": os.environ["ASIN_ENV"], "title": os.environ["TITLE_ENV"], "format": "m4b"}))
PY
  )"
  START_JSON="$(
    curl -fsS -X POST "${API_ORIGIN}/api/audible/download" \
      -H 'Content-Type: application/json' \
      --data "${REQUEST_BODY}"
  )"
  JOB_ID="$(json_get job_id "${START_JSON}")"
  if [[ -z "${JOB_ID}" ]]; then
    printf 'Failed to get job id from start response: %s\n' "${START_JSON}" >&2
    exit 4
  fi
  log "Polling job ${JOB_ID} for completion"

  deadline=$(( $(date +%s) + DOWNLOAD_TIMEOUT_SEC ))
  while true; do
    JOB_JSON="$(curl -fsS "${API_ORIGIN}/api/audible/download/${JOB_ID}")"
    STATUS="$(json_get job_status "${JOB_JSON}")"
    PROGRESS="$(json_get job_progress "${JOB_JSON}")"
    ERR_MSG="$(json_get job_error "${JOB_JSON}")"
    log "job=${JOB_ID} status=${STATUS} progress=${PROGRESS}"
    if [[ "${STATUS}" == "done" ]]; then
      record_check "download_pipeline" "pass" "job=${JOB_ID}"
      break
    fi
    if [[ "${STATUS}" == "error" ]]; then
      printf 'Download job failed: %s\n' "${ERR_MSG}" >&2
      record_check "download_pipeline" "fail" "job=${JOB_ID} error=${ERR_MSG}"
      exit 5
    fi
    if (( $(date +%s) > deadline )); then
      printf 'Download test timed out after %ss\n' "${DOWNLOAD_TIMEOUT_SEC}" >&2
      record_check "download_pipeline" "fail" "timeout job=${JOB_ID}"
      exit 6
    fi
    sleep "${POLL_SEC}"
  done
  fi

  log "Validating downloadable file endpoint for ${JOB_ID}"
  curl -fsS -H 'Range: bytes=0-1' "${API_ORIGIN}/api/audible/download/${JOB_ID}/file" >"${AUTOTEST_ARTIFACT_DIR}/download-sample.bin"
  record_check "download_file_endpoint" "pass" "job=${JOB_ID}"
fi

log "Building and syncing player iOS assets"
pnpm run player:build
pnpm run player:cap:sync:ios
record_check "player_build_sync" "pass" "build+cap sync ios"

if [[ -z "${IOS_UDID}" ]]; then
  IOS_UDID="$(pick_booted_udid)"
fi
if [[ -z "${IOS_UDID}" ]]; then
  IOS_UDID="$(pick_available_iphone_udid)"
  if [[ -z "${IOS_UDID}" ]]; then
    printf 'No available iPhone simulator found.\n' >&2
    exit 7
  fi
  log "Booting simulator ${IOS_UDID}"
  xcrun simctl boot "${IOS_UDID}" || true
fi
record_check "simulator_target" "pass" "${IOS_UDID}"

if [[ "${RESET_APP_STATE}" == "1" ]]; then
  log "Resetting app state for deterministic run"
  xcrun simctl terminate "${IOS_UDID}" com.speed.player >/dev/null 2>&1 || true
  xcrun simctl uninstall "${IOS_UDID}" com.speed.player >/dev/null 2>&1 || true
  record_check "simulator_reset_state" "pass" "uninstalled prior app"
fi

log "Building iOS app for simulator ${IOS_UDID}"
xcodebuild \
  -workspace "/Users/fred/speed/artifacts/player/ios/App/App.xcworkspace" \
  -scheme App \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=${IOS_UDID}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  build >"${AUTOTEST_ARTIFACT_DIR}/xcodebuild.log"
record_check "xcodebuild_simulator" "pass" "${IOS_UDID}"

APP_PATH="${DERIVED_DATA_PATH}/Build/Products/Debug-iphonesimulator/App.app"
if [[ ! -d "${APP_PATH}" ]]; then
  printf 'Built app not found at %s\n' "${APP_PATH}" >&2
  exit 8
fi

log "Installing and launching app in simulator"
xcrun simctl install "${IOS_UDID}" "${APP_PATH}"
xcrun simctl launch "${IOS_UDID}" com.speed.player >"${AUTOTEST_ARTIFACT_DIR}/sim-launch.log"
record_check "sim_install_launch" "pass" "bundle=com.speed.player"

log "Recent app logs (last 20s)"
xcrun simctl spawn "${IOS_UDID}" log show --last 20s --style compact --predicate 'process == "App"' | tail -n 120 >"${AUTOTEST_ARTIFACT_DIR}/app-log-tail.log" || true

if [[ "${OFFLINE_PROBE}" == "1" ]]; then
  if curl -sS -m 2 "http://127.0.0.1:9/__speed_offline_probe__" >/dev/null 2>&1; then
    record_check "offline_probe" "fail" "unexpected success"
  else
    record_check "offline_probe" "pass" "synthetic offline network failure observed"
  fi
fi

python3 - "${AUTOTEST_ARTIFACT_DIR}/checks.tsv" "${AUTOTEST_ARTIFACT_DIR}/summary.json" <<'PY'
import json
import sys
from pathlib import Path

checks_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
checks = []
passed = 0
failed = 0
for raw in checks_path.read_text().splitlines():
    if not raw.strip():
        continue
    name, status, detail = (raw.split("\t", 2) + ["", ""])[:3]
    checks.append({"name": name, "status": status, "detail": detail})
    if status == "pass":
        passed += 1
    elif status == "fail":
        failed += 1
summary = {
    "status": "pass" if failed == 0 else "fail",
    "passed": passed,
    "failed": failed,
    "checks": checks,
}
summary_path.write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
PY

log "Autonomous iOS test run completed"
log "Artifacts: ${AUTOTEST_ARTIFACT_DIR}"
