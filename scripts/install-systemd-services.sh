#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$ROOT_DIR/deploy/systemd"
LLM_TEMPLATE="$TEMPLATE_DIR/pdfaf-llm.service.template"
API_TEMPLATE="$TEMPLATE_DIR/pdfaf-api.service.template"
LLM_UNIT_NAME="pdfaf-llm.service"
API_UNIT_NAME="pdfaf-api.service"

log() {
  printf '[systemd] %s\n' "$1"
}

fail() {
  printf '[systemd] ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    require_cmd sudo
    sudo "$@"
  fi
}

render_unit() {
  local template_path="$1"
  local output_path="$2"
  local repo_root="$3"
  local run_user="$4"
  local run_group="$5"
  local home_dir="$6"
  local pnpm_bin="$7"
  sed \
    -e "s|__REPO_ROOT__|$repo_root|g" \
    -e "s|__RUN_USER__|$run_user|g" \
    -e "s|__RUN_GROUP__|$run_group|g" \
    -e "s|__HOME_DIR__|$home_dir|g" \
    -e "s|__PNPM_BIN__|$pnpm_bin|g" \
    "$template_path" > "$output_path"
}

main() {
  require_cmd systemctl
  [[ -d /run/systemd/system ]] || fail 'systemd does not appear to be the active init system.'
  require_cmd sed
  require_cmd install

  [[ -f "$LLM_TEMPLATE" ]] || fail "Missing template: $LLM_TEMPLATE"
  [[ -f "$API_TEMPLATE" ]] || fail "Missing template: $API_TEMPLATE"

  local run_user run_group home_dir pnpm_bin tmp_dir
  run_user="$(id -un)"
  run_group="$(id -gn)"
  home_dir="${HOME:-$(getent passwd "$run_user" | cut -d: -f6)}"
  [[ -n "$home_dir" ]] || fail 'Could not determine HOME for the current user.'
  pnpm_bin="$(command -v pnpm)"
  [[ -n "$pnpm_bin" ]] || fail 'pnpm is not installed or not on PATH.'

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  render_unit "$LLM_TEMPLATE" "$tmp_dir/$LLM_UNIT_NAME" "$ROOT_DIR" "$run_user" "$run_group" "$home_dir" "$pnpm_bin"
  render_unit "$API_TEMPLATE" "$tmp_dir/$API_UNIT_NAME" "$ROOT_DIR" "$run_user" "$run_group" "$home_dir" "$pnpm_bin"

  log "Installing $LLM_UNIT_NAME and $API_UNIT_NAME into /etc/systemd/system"
  run_as_root install -m 0644 "$tmp_dir/$LLM_UNIT_NAME" "/etc/systemd/system/$LLM_UNIT_NAME"
  run_as_root install -m 0644 "$tmp_dir/$API_UNIT_NAME" "/etc/systemd/system/$API_UNIT_NAME"
  run_as_root systemctl daemon-reload
  log 'systemd units installed and daemon reloaded.'
}

main "$@"
