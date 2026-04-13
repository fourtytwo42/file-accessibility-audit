#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/systemd-stack-common.sh"

status_of() {
  local unit_name="$1"
  local active enabled
  active="$(pdfaf_systemctl is-active "$unit_name" 2>/dev/null || true)"
  enabled="$(pdfaf_systemctl is-enabled "$unit_name" 2>/dev/null || true)"
  printf '%s\tactive=%s\tenabled=%s\n' "$unit_name" "${active:-unknown}" "${enabled:-unknown}"
}

main() {
  pdfaf_require_systemd
  local stderr_file
  stderr_file="$(mktemp)"
  trap 'rm -f "$stderr_file"' EXIT
  status_of "$PDFAF_LLM_UNIT_NAME"
  status_of "$PDFAF_API_UNIT_NAME"

  if curl -fsS "$PDFAF_LLM_URL" >/dev/null 2>&1; then
    printf 'llm\tready=yes\turl=%s\n' "$PDFAF_LLM_URL"
  else
    printf 'llm\tready=no\turl=%s\n' "$PDFAF_LLM_URL"
  fi

  if curl -fsS "$PDFAF_API_HEALTH_URL" >/dev/null 2>&1; then
    printf 'api\tready=yes\turl=%s\n' "$PDFAF_API_HEALTH_URL"
  else
    printf 'api\tready=no\turl=%s\n' "$PDFAF_API_HEALTH_URL"
  fi

  if (
    cd "$PDFAF_ROOT_DIR"
    pnpm probe:openai-compat -- --tool-smoke >/dev/null 2>"$stderr_file"
  ); then
    printf 'tool-smoke\tstatus=ok\n'
  else
    printf 'tool-smoke\tstatus=failed\n'
    sed -n '1,40p' "$stderr_file" >&2 || true
    exit 1
  fi
}

main "$@"
