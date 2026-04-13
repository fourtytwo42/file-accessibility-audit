#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/systemd-stack-common.sh"

LLM_WAIT_TIMEOUT_SECONDS="${LLM_WAIT_TIMEOUT_SECONDS:-1800}"
API_WAIT_TIMEOUT_SECONDS="${API_WAIT_TIMEOUT_SECONDS:-180}"

main() {
  pdfaf_require_systemd
  pdfaf_systemctl daemon-reload
  pdfaf_log "Enabling and starting $PDFAF_LLM_UNIT_NAME"
  pdfaf_systemctl enable "$PDFAF_LLM_UNIT_NAME"
  pdfaf_systemctl start "$PDFAF_LLM_UNIT_NAME"
  pdfaf_wait_for_url "$PDFAF_LLM_URL" "$LLM_WAIT_TIMEOUT_SECONDS" 'Local LLM'

  pdfaf_log "Enabling and starting $PDFAF_API_UNIT_NAME"
  pdfaf_systemctl enable "$PDFAF_API_UNIT_NAME"
  pdfaf_systemctl start "$PDFAF_API_UNIT_NAME"
  pdfaf_wait_for_url "$PDFAF_API_HEALTH_URL" "$API_WAIT_TIMEOUT_SECONDS" 'API health'

  (
    cd "$PDFAF_ROOT_DIR"
    pnpm probe:openai-compat -- --tool-smoke
  )
  pdfaf_log 'Stack started successfully.'
}

main "$@"
