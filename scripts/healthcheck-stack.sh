#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY_SCRIPT="$ROOT_DIR/scripts/verify-env.sh"
REMEDIATION_SMOKE_SCRIPT="$ROOT_DIR/apps/api/src/scripts/remediationSmokeCheck.ts"
INACCESSIBLE_FIXTURE="$ROOT_DIR/apps/api/src/__tests__/fixtures/inaccessible.pdf"
OPTIONAL_ADAM_FIXTURE="$ROOT_DIR/ICJIA-PDFs/downloads/source-pdfs/ADAM/ADAM2.pdf"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/stack-common.sh"

plain_chat_smoke() {
  pdfaf_source_api_env
  local response
  response="$(
    curl -fsS http://127.0.0.1:1234/v1/chat/completions \
      -H "Authorization: Bearer ${OPENAI_COMPAT_API_KEY}" \
      -H 'Content-Type: application/json' \
      --data "{\"model\":\"${OPENAI_COMPAT_MODEL}\",\"temperature\":0,\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly OK.\"}]}"
  )"
  RESPONSE_JSON="$response" node - <<'NODE'
const payload = JSON.parse(process.env.RESPONSE_JSON || '{}')
const message = payload?.choices?.[0]?.message || {}
if (message.content !== 'OK') {
  console.error(`Expected content OK, received: ${JSON.stringify(message)}`)
  process.exit(1)
}
if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
  console.error(`Expected no reasoning_content, received: ${message.reasoning_content}`)
  process.exit(1)
}
NODE
}

multimodal_smoke() {
  pdfaf_source_api_env
  local response
  response="$(
    curl -fsS http://127.0.0.1:1234/v1/chat/completions \
      -H "Authorization: Bearer ${OPENAI_COMPAT_API_KEY}" \
      -H 'Content-Type: application/json' \
      --data "{\"model\":\"${OPENAI_COMPAT_MODEL}\",\"temperature\":0,\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Reply with exactly OK.\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnSUswAAAAASUVORK5CYII=\"}}]}]}"
  )"
  RESPONSE_JSON="$response" node - <<'NODE'
const payload = JSON.parse(process.env.RESPONSE_JSON || '{}')
const content = payload?.choices?.[0]?.message?.content
if (typeof content !== 'string' || !content.trim()) {
  console.error(`Expected non-empty multimodal content, received: ${JSON.stringify(payload?.choices?.[0]?.message)}`)
  process.exit(1)
}
NODE
}

main() {
  bash "$VERIFY_SCRIPT"
  curl -fsS "$PDFAF_LLM_URL" >/dev/null
  curl -fsS "$PDFAF_API_HEALTH_URL" >/dev/null

  (
    cd "$ROOT_DIR"
    pnpm probe:openai-compat -- --tool-smoke
  )

  plain_chat_smoke
  multimodal_smoke

  local remediation_args=("$INACCESSIBLE_FIXTURE")
  if [[ -f "$OPTIONAL_ADAM_FIXTURE" ]]; then
    remediation_args+=("$OPTIONAL_ADAM_FIXTURE")
  else
    printf '[healthcheck] Skipping optional ADAM fixture: %s\n' "$OPTIONAL_ADAM_FIXTURE"
  fi

  (
    cd "$ROOT_DIR/apps/api"
    pnpm exec tsx "$REMEDIATION_SMOKE_SCRIPT" "${remediation_args[@]}"
  )

  printf '[healthcheck] Stack healthcheck passed.\n'
}

main "$@"
