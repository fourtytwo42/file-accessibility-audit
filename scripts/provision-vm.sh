#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP_SCRIPT="$ROOT_DIR/scripts/bootstrap-ubuntu.sh"
INSTALL_SYSTEMD_SCRIPT="$ROOT_DIR/scripts/install-systemd-services.sh"
START_STACK_SCRIPT="$ROOT_DIR/scripts/start-stack.sh"
STOP_STACK_SCRIPT="$ROOT_DIR/scripts/stop-stack.sh"
HEALTHCHECK_SCRIPT="$ROOT_DIR/scripts/healthcheck-stack.sh"
API_ENV_FILE="$ROOT_DIR/apps/api/.env"

LLAMA_RELEASE_TAG="${LLAMA_RELEASE_TAG:-b8778}"
LLAMA_RELEASE_ARCHIVE="${LLAMA_RELEASE_ARCHIVE:-llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-x64.tar.gz}"
LLAMA_RELEASE_URL="${LLAMA_RELEASE_URL:-https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/${LLAMA_RELEASE_ARCHIVE}}"
LLAMA_ARCHIVE_PATH="$ROOT_DIR/.local-tools/$LLAMA_RELEASE_ARCHIVE"
FORCE_LOCAL_AI=0
SKIP_HEALTHCHECK=0

usage() {
  cat <<'EOF'
Usage: scripts/provision-vm.sh [--force-local-ai] [--skip-healthcheck] [bootstrap args...]

Canonical VM provisioning entrypoint for API + local Gemma.

Options:
  --force-local-ai   Overwrite existing OPENAI_COMPAT_* values in apps/api/.env with local Gemma defaults.
  --skip-healthcheck Skip the temporary start + stack healthcheck at the end.

All remaining arguments are passed through to scripts/bootstrap-ubuntu.sh.
EOF
}

log() {
  printf '[provision] %s\n' "$1"
}

fail() {
  printf '[provision] ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

upsert_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local escaped_value
  escaped_value="$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s/^${key}=.*/${key}=${escaped_value}/" "$env_file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

set_env_default() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  if grep -q "^${key}=" "$env_file"; then
    local current_value
    current_value="$(sed -n "s/^${key}=//p" "$env_file" | head -n 1)"
    if [[ -n "${current_value// }" && $FORCE_LOCAL_AI -ne 1 ]]; then
      log "Preserving existing $key value in $env_file"
      return
    fi
  fi
  upsert_env_value "$env_file" "$key" "$value"
}

install_llama_bundle_if_missing() {
  local existing_bundle
  existing_bundle="$(find "$ROOT_DIR/.local-tools" -maxdepth 1 -type d -name 'llama-b*' | head -n 1 || true)"
  if [[ -n "$existing_bundle" && -x "$existing_bundle/llama-server" ]]; then
    log "llama.cpp bundle already installed: $existing_bundle"
    return
  fi

  mkdir -p "$ROOT_DIR/.local-tools"
  if [[ ! -f "$LLAMA_ARCHIVE_PATH" ]]; then
    log "Downloading llama.cpp release $LLAMA_RELEASE_TAG"
    curl -fL --retry 3 --retry-delay 2 -o "$LLAMA_ARCHIVE_PATH" "$LLAMA_RELEASE_URL"
  else
    log "Reusing existing llama.cpp archive: $LLAMA_ARCHIVE_PATH"
  fi

  log "Extracting $LLAMA_RELEASE_ARCHIVE"
  tar -xzf "$LLAMA_ARCHIVE_PATH" -C "$ROOT_DIR/.local-tools"
  existing_bundle="$(find "$ROOT_DIR/.local-tools" -maxdepth 1 -type d -name 'llama-b*' | head -n 1 || true)"
  [[ -n "$existing_bundle" && -x "$existing_bundle/llama-server" ]] || fail 'llama.cpp bundle installation completed without a usable llama-server.'
}

configure_local_ai_env() {
  [[ -f "$API_ENV_FILE" ]] || fail "Missing API env file after bootstrap: $API_ENV_FILE"
  set_env_default "$API_ENV_FILE" "OPENAI_COMPAT_BASE_URL" "http://127.0.0.1:1234/v1"
  set_env_default "$API_ENV_FILE" "OPENAI_COMPAT_API_KEY" "local-llama"
  set_env_default "$API_ENV_FILE" "OPENAI_COMPAT_MODEL" "gemma-4-E2B-it-Q4_K_M.gguf"
  set_env_default "$API_ENV_FILE" "OPENAI_COMPAT_TOOL_CHOICE_MODE" "required"
  set_env_default "$API_ENV_FILE" "OPENAI_COMPAT_DISABLE_FALLBACKS" "1"
}

validate_llama_prereqs() {
  log 'Validating llama-server prerequisites'
  local bundled_dir
  bundled_dir="$(find "$ROOT_DIR/.local-tools" -maxdepth 1 -type d -name 'llama-b*' | head -n 1 || true)"
  [[ -n "$bundled_dir" && -x "$bundled_dir/llama-server" ]] || fail 'llama-server is still unavailable after bundle installation.'
  (
    export LD_LIBRARY_PATH="${bundled_dir}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    "$bundled_dir/llama-server" --version >/dev/null
  ) || fail 'llama-server is present but did not execute cleanly.'
}

main() {
  local bootstrap_args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force-local-ai)
        FORCE_LOCAL_AI=1
        ;;
      --skip-healthcheck)
        SKIP_HEALTHCHECK=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        bootstrap_args+=("$1")
        ;;
    esac
    shift
  done

  require_cmd curl
  require_cmd tar

  log 'Running Ubuntu bootstrap'
  "$BOOTSTRAP_SCRIPT" "${bootstrap_args[@]}"
  install_llama_bundle_if_missing
  configure_local_ai_env
  validate_llama_prereqs
  "$INSTALL_SYSTEMD_SCRIPT"

  if (( SKIP_HEALTHCHECK == 0 )); then
    log 'Running temporary stack start + healthcheck'
    "$START_STACK_SCRIPT"
    trap '"$STOP_STACK_SCRIPT" >/dev/null 2>&1 || true' EXIT
    "$HEALTHCHECK_SCRIPT"
    "$STOP_STACK_SCRIPT"
    trap - EXIT
  fi

  log 'Provisioning complete.'
  printf '\nNext command:\n  bash %s\n' "$START_STACK_SCRIPT"
}

main "$@"
