#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/stack-common.sh"

main() {
  pdfaf_require_pm2

  if pdfaf_pm2_app_exists "$PDFAF_PM2_API_APP_NAME"; then
    pdfaf_log "Stopping $PDFAF_PM2_API_APP_NAME"
    pm2 stop "$PDFAF_PM2_API_APP_NAME" >/dev/null || true
    pm2 delete "$PDFAF_PM2_API_APP_NAME" >/dev/null || true
  fi

  if pdfaf_pm2_app_exists "$PDFAF_PM2_LLM_APP_NAME"; then
    pdfaf_log "Stopping $PDFAF_PM2_LLM_APP_NAME"
    pm2 stop "$PDFAF_PM2_LLM_APP_NAME" >/dev/null || true
    pm2 delete "$PDFAF_PM2_LLM_APP_NAME" >/dev/null || true
  fi

  pm2 save >/dev/null || true
  pdfaf_log 'Stack stopped.'
}

main "$@"
