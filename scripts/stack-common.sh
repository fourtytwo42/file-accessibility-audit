#!/usr/bin/env bash
set -euo pipefail

PDFAF_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PDFAF_API_ENV_FILE="$PDFAF_ROOT_DIR/apps/api/.env"
PDFAF_ECOSYSTEM_FILE="$PDFAF_ROOT_DIR/ecosystem.config.cjs"
PDFAF_PM2_LLM_APP_NAME="${PDFAF_PM2_LLM_APP_NAME:-file-audit-llm}"
PDFAF_PM2_API_APP_NAME="${PDFAF_PM2_API_APP_NAME:-file-audit-api}"
PDFAF_LLM_URL="${PDFAF_LLM_URL:-http://127.0.0.1:1234/v1/models}"
PDFAF_API_HEALTH_URL="${PDFAF_API_HEALTH_URL:-http://127.0.0.1:6103/api/health}"

pdfaf_log() {
  printf '[stack] %s\n' "$1"
}

pdfaf_fail() {
  printf '[stack] ERROR: %s\n' "$1" >&2
  exit 1
}

pdfaf_require_cmd() {
  command -v "$1" >/dev/null 2>&1 || pdfaf_fail "Required command not found: $1"
}

pdfaf_require_pm2() {
  pdfaf_require_cmd pm2
  [[ -f "$PDFAF_ECOSYSTEM_FILE" ]] || pdfaf_fail "Missing PM2 ecosystem file: $PDFAF_ECOSYSTEM_FILE"
}

pdfaf_wait_for_url() {
  local url="$1"
  local timeout_seconds="$2"
  local label="$3"
  local start_time
  start_time="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      pdfaf_log "$label is ready: $url"
      return 0
    fi
    if (( "$(date +%s)" - start_time >= timeout_seconds )); then
      pdfaf_fail "Timed out waiting for $label at $url after ${timeout_seconds}s."
    fi
    sleep 2
  done
}

pdfaf_source_api_env() {
  [[ -f "$PDFAF_API_ENV_FILE" ]] || pdfaf_fail "Missing API env file: $PDFAF_API_ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$PDFAF_API_ENV_FILE"
  set +a
}

pdfaf_pm2_app_exists() {
  local app_name="$1"
  pm2 describe "$app_name" >/dev/null 2>&1
}
