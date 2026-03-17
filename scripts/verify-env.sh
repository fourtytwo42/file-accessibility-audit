#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_ENV_FILE="$ROOT_DIR/apps/api/.env"
JSON_MODE=0
SMOKE_API=0

usage() {
  cat <<'EOF'
Usage: scripts/verify-env.sh [--json] [--smoke-api]

Checks the local runtime required for the remediation-capable app:
- Node.js and pnpm
- Python helper runtime
- qpdf
- veraPDF + Java
- Playwright Chromium
- legacy font bundle
- required API env keys

Options:
  --json       Print the summary as JSON
  --smoke-api  Start the API temporarily and verify /api/health
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      JSON_MODE=1
      ;;
    --smoke-api)
      SMOKE_API=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ -f "$API_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$API_ENV_FILE"
  set +a
fi

PYTHON_BIN="${PYTHON_PATH:-python3}"
VERAPDF_BIN="${VERAPDF_PATH:-verapdf}"
QPDF_BIN="${QPDF_PATH:-qpdf}"
LEGACY_FONT_DIR="${LEGACY_FONT_DIRS%%:*}"
PORT_VALUE="${PORT:-6103}"

EXPECTED_FONTS=(
  "arial.ttf"
  "arialbd.ttf"
  "ariali.ttf"
  "arialbi.ttf"
  "calibri.ttf"
  "calibrib.ttf"
  "times.ttf"
  "timesbd.ttf"
  "timesi.ttf"
  "timesbi.ttf"
  "verdana.ttf"
  "verdanab.ttf"
  "IBMPlexSans-Regular.otf"
  "IBMPlexSans-Bold.otf"
  "IBMPlexSans-Italic.otf"
  "IBMPlexSans-Light.otf"
  "SourceSans3-Regular.otf"
  "SourceSans3-It.otf"
  "SourceSans3-Bold.otf"
  "SourceSans3-Black.otf"
  "SourceSans3-Light.otf"
  "LibertinusSans-Regular.otf"
  "LibertinusSans-Bold.otf"
  "LibertinusSans-Italic.otf"
  "LibertinusSerif-Regular.otf"
  "LibertinusSerif-Italic.otf"
  "LibertinusSerif-Bold.otf"
  "LibertinusSerif-BoldItalic.otf"
  "LibreBaskerville-Regular.ttf"
  "LibreBaskerville-Italic.ttf"
  "LibreBaskerville-Bold.ttf"
)

RESULTS=()
FAILURES=0

record_result() {
  local name="$1"
  local ok="$2"
  local message="$3"
  RESULTS+=("${name}|${ok}|${message}")
  if [[ "$ok" == "false" ]]; then
    FAILURES=$((FAILURES + 1))
  fi
}

record_pass() {
  record_result "$1" "true" "$2"
}

record_fail() {
  record_result "$1" "false" "$2"
}

check_command() {
  local name="$1"
  local command="$2"
  local version_args="${3:---version}"
  if ! command -v "$command" >/dev/null 2>&1; then
    record_fail "$name" "$command is not available on PATH."
    return 1
  fi
  local output
  if ! output="$("$command" $version_args 2>&1 | head -n 1)"; then
    record_fail "$name" "$command is present but did not execute cleanly."
    return 1
  fi
  record_pass "$name" "$output"
}

check_command "pnpm" "pnpm"

if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v)"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR >= 22 )); then
    record_pass "node" "$NODE_VERSION"
  else
    record_fail "node" "Expected Node.js 22+, found $NODE_VERSION."
  fi
else
  record_fail "node" "Node.js is not available on PATH."
fi

if [[ -x "$PYTHON_BIN" ]] || command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_VERSION="$("$PYTHON_BIN" --version 2>&1)"
  record_pass "python" "$PYTHON_VERSION ($PYTHON_BIN)"
  if "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1
import importlib
import sys
for module in ("pikepdf", "fontTools"):
    importlib.import_module(module)
print(sys.version)
PY
  then
    record_pass "python-modules" "pikepdf and fontTools imported successfully."
  else
    record_fail "python-modules" "Python helper dependencies are missing for $PYTHON_BIN."
  fi
else
  record_fail "python" "Python interpreter not found: $PYTHON_BIN"
  record_fail "python-modules" "Skipped because the configured Python interpreter is unavailable."
fi

if [[ -x "$QPDF_BIN" ]] || command -v "$QPDF_BIN" >/dev/null 2>&1; then
  QPDF_VERSION="$("$QPDF_BIN" --version 2>&1 | head -n 1)"
  record_pass "qpdf" "$QPDF_VERSION"
else
  record_fail "qpdf" "qpdf is not available: $QPDF_BIN"
fi

if [[ -n "${JAVACMD:-}" && -x "${JAVACMD:-}" ]]; then
  JAVA_VERSION="$("$JAVACMD" -version 2>&1 | head -n 1)"
  record_pass "java" "$JAVA_VERSION (${JAVACMD})"
elif command -v java >/dev/null 2>&1; then
  JAVA_VERSION="$(java -version 2>&1 | head -n 1)"
  record_pass "java" "$JAVA_VERSION"
else
  record_fail "java" "Java is unavailable. Set JAVACMD or install Java 17."
fi

if [[ -x "$VERAPDF_BIN" ]]; then
  if VERAPDF_OUTPUT="$("$VERAPDF_BIN" --version 2>&1 | head -n 1)"; then
    record_pass "verapdf" "$VERAPDF_OUTPUT"
  else
    record_fail "verapdf" "veraPDF exists but did not execute cleanly: $VERAPDF_BIN"
  fi
elif command -v "$VERAPDF_BIN" >/dev/null 2>&1; then
  if VERAPDF_OUTPUT="$("$VERAPDF_BIN" --version 2>&1 | head -n 1)"; then
    record_pass "verapdf" "$VERAPDF_OUTPUT"
  else
    record_fail "verapdf" "veraPDF exists but did not execute cleanly: $VERAPDF_BIN"
  fi
else
  record_fail "verapdf" "veraPDF is unavailable: $VERAPDF_BIN"
fi

if [[ -n "${LEGACY_FONT_DIR:-}" && -d "$LEGACY_FONT_DIR" ]]; then
  missing_fonts=()
  for font_file in "${EXPECTED_FONTS[@]}"; do
    if [[ ! -f "$LEGACY_FONT_DIR/$font_file" ]]; then
      missing_fonts+=("$font_file")
    fi
  done
  if [[ ${#missing_fonts[@]} -eq 0 ]]; then
    record_pass "legacy-fonts" "Legacy font directory is ready: $LEGACY_FONT_DIR"
  else
    record_fail "legacy-fonts" "Missing ${#missing_fonts[@]} expected font files in $LEGACY_FONT_DIR."
  fi
else
  record_fail "legacy-fonts" "LEGACY_FONT_DIRS is not set to a usable directory."
fi

required_env=(
  "PYTHON_PATH"
  "PDF_FONT_DIRS"
  "LEGACY_FONT_DIRS"
  "VERAPDF_PATH"
)
missing_env=()
for key in "${required_env[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    missing_env+=("$key")
  fi
done
if [[ ${#missing_env[@]} -eq 0 ]]; then
  record_pass "api-env" "Required remediation env keys are present in apps/api/.env."
else
  record_fail "api-env" "Missing env keys in apps/api/.env: ${missing_env[*]}"
fi

if pnpm --filter api exec node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch({ headless: true }); await browser.close();" >/dev/null 2>&1; then
  record_pass "playwright" "Chromium launched successfully."
else
  record_fail "playwright" "Playwright Chromium could not launch. Run pnpm --filter api exec playwright install chromium."
fi

smoke_api() {
  local log_file
  log_file="$(mktemp)"
  local api_pid
  (
    cd "$ROOT_DIR"
    NODE_ENV=development PORT="$PORT_VALUE" pnpm --filter api start
  ) >"$log_file" 2>&1 &
  api_pid=$!
  trap 'kill "$api_pid" >/dev/null 2>&1 || true; wait "$api_pid" >/dev/null 2>&1 || true; rm -f "$log_file"' RETURN

  local health_url="http://localhost:${PORT_VALUE}/api/health"
  for _ in $(seq 1 45); do
    if curl -fsS "$health_url" >/dev/null 2>&1; then
      local payload
      payload="$(curl -fsS "$health_url")"
      if grep -q '"veraPdf":"available"' <<<"$payload"; then
        record_pass "api-smoke" "API health passed at $health_url"
      else
        record_fail "api-smoke" "API started but veraPDF was not reported as available."
      fi
      return
    fi
    sleep 1
  done

  record_fail "api-smoke" "API did not become healthy within the timeout. See $log_file"
}

if (( SMOKE_API == 1 )); then
  smoke_api
fi

if (( JSON_MODE == 1 )); then
  results_file="$(mktemp)"
  printf '%s\n' "${RESULTS[@]}" >"$results_file"
  "$PYTHON_BIN" - "$results_file" "$FAILURES" <<'PY'
import json
import sys
from pathlib import Path

results_path = Path(sys.argv[1])
failures = int(sys.argv[2])
items = []
for raw in results_path.read_text(encoding="utf-8").splitlines():
    name, ok, message = raw.split("|", 2)
    items.append({
        "name": name,
        "ok": ok == "true",
        "message": message,
    })
print(json.dumps({"ok": failures == 0, "failures": failures, "checks": items}, indent=2))
PY
  rm -f "$results_file"
else
  for raw in "${RESULTS[@]}"; do
    IFS='|' read -r name ok message <<<"$raw"
    if [[ "$ok" == "true" ]]; then
      printf 'PASS %-16s %s\n' "$name" "$message"
    else
      printf 'FAIL %-16s %s\n' "$name" "$message"
    fi
  done
  if (( FAILURES == 0 )); then
    echo "Environment verification passed."
  else
    echo "Environment verification failed with $FAILURES check(s)." >&2
  fi
fi

if (( FAILURES > 0 )); then
  exit 1
fi
