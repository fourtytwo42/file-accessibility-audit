#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/systemd-stack-common.sh"

main() {
  pdfaf_require_systemd
  pdfaf_log "Stopping $PDFAF_API_UNIT_NAME"
  pdfaf_systemctl stop "$PDFAF_API_UNIT_NAME" || true
  pdfaf_log "Stopping $PDFAF_LLM_UNIT_NAME"
  pdfaf_systemctl stop "$PDFAF_LLM_UNIT_NAME" || true
  pdfaf_log 'Stack stopped.'
}

main "$@"
