#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/stack-common.sh"

LLM_WAIT_TIMEOUT_SECONDS="${LLM_WAIT_TIMEOUT_SECONDS:-1800}"
API_WAIT_TIMEOUT_SECONDS="${API_WAIT_TIMEOUT_SECONDS:-180}"
LEGACY_LLM_PID_FILE="${LEGACY_LLM_PID_FILE:-$PDFAF_ROOT_DIR/.tmp/llama-server.pid}"

stop_legacy_background_llm_if_needed() {
  local old_pid=''
  if pdfaf_pm2_app_exists "$PDFAF_PM2_LLM_APP_NAME"; then
    return 0
  fi
  if [[ ! -f "$LEGACY_LLM_PID_FILE" ]]; then
    return 0
  fi
  old_pid="$(cat "$LEGACY_LLM_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    pdfaf_log "Stopping legacy background llama-server pid $old_pid before PM2 start"
    kill "$old_pid" 2>/dev/null || true
    sleep 2
  fi
}

main() {
  pdfaf_require_pm2
  stop_legacy_background_llm_if_needed

  if pdfaf_pm2_app_exists "$PDFAF_PM2_LLM_APP_NAME" && pdfaf_pm2_app_exists "$PDFAF_PM2_API_APP_NAME"; then
    pdfaf_log "Reloading PM2 stack from $PDFAF_ECOSYSTEM_FILE"
    pm2 reload "$PDFAF_ECOSYSTEM_FILE" --update-env
  else
    pdfaf_log "Starting PM2 stack from $PDFAF_ECOSYSTEM_FILE"
    pm2 start "$PDFAF_ECOSYSTEM_FILE"
  fi

  pdfaf_wait_for_url "$PDFAF_LLM_URL" "$LLM_WAIT_TIMEOUT_SECONDS" 'Local LLM'

  pdfaf_wait_for_url "$PDFAF_API_HEALTH_URL" "$API_WAIT_TIMEOUT_SECONDS" 'API health'

  (
    cd "$PDFAF_ROOT_DIR"
    pnpm probe:openai-compat -- --tool-smoke
  )
  pm2 save >/dev/null
  pdfaf_log 'Stack started successfully.'
}

main "$@"
