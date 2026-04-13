#!/usr/bin/env bash
# Start an OpenAI-compatible HTTP server for Google Gemma 4 E2B (instruction-tuned),
# Q4-weight GGUF, using llama.cpp’s llama-server.
#
# Prerequisites:
#   - llama.cpp built with server support; `llama-server` on PATH, or set LLAMA_SERVER_BIN.
#   - Enough RAM/VRAM for ~3.5GB weights + overhead (Q4_K_M).
#
# Vision: Gemma 4 E2B is multimodal. llama-server can auto-download a matching mmproj from Hugging Face when
# the repo provides one, so OpenAI-style chat with image_url parts works for semantic figure alt text and page reconstruction.
#
# After start, point apps/api/.env at:
#   OPENAI_COMPAT_BASE_URL=http://127.0.0.1:${LLAMA_SERVER_PORT}/v1
#   OPENAI_COMPAT_API_KEY=any-non-empty-string
#   OPENAI_COMPAT_MODEL=<id from GET /v1/models — often the GGUF basename>
#   OPENAI_COMPAT_TOOL_CHOICE_MODE=required
#   OPENAI_COMPAT_DISABLE_FALLBACKS=1
#
# This launcher also disables Gemma "thinking" output at the server level via
# `--reasoning-budget 0` and `--chat-template-kwargs '{"enable_thinking": false}'`
# so normal chat completions return final content without reasoning traces.
#
# Discover model id:
#   curl -sS "http://127.0.0.1:${LLAMA_SERVER_PORT}/v1/models" -H "Authorization: Bearer $OPENAI_COMPAT_API_KEY"
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Bundled release (see docs in CLAUDE.md): extract llama-b*-bin-ubuntu-x64.tar.gz under .local-tools/llama-b*/
_BUNDLED_DIR="$(find "$REPO_ROOT/.local-tools" -maxdepth 1 -type d -name 'llama-b*' 2>/dev/null | sort -V | tail -n 1 || true)"
if [[ -z "${LLAMA_SERVER_BIN:-}" && -n "$_BUNDLED_DIR" && -x "$_BUNDLED_DIR/llama-server" ]]; then
  LLAMA_SERVER_BIN="$_BUNDLED_DIR/llama-server"
  export LD_LIBRARY_PATH="${_BUNDLED_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
: "${LLAMA_SERVER_BIN:=llama-server}"

: "${LLAMA_SERVER_HOST:=127.0.0.1}"
: "${LLAMA_SERVER_PORT:=1234}"
# Default: Unsloth GGUFs include Q4_K_M. (ggml-org snapshot may only ship Q8_0/bf16.)
: "${GEMMA4_HF_REPO:=unsloth/gemma-4-E2B-it-GGUF}"
: "${GEMMA4_GGUF_FILE:=gemma-4-E2B-it-Q4_K_M.gguf}"

if [[ ! -x "$LLAMA_SERVER_BIN" ]] && ! command -v "$LLAMA_SERVER_BIN" >/dev/null 2>&1; then
  echo "Missing llama-server: extract llama-b*-bin-ubuntu-x64.tar.gz to $REPO_ROOT/.local-tools/ or set LLAMA_SERVER_BIN." >&2
  echo "Download: https://github.com/ggml-org/llama.cpp/releases" >&2
  exit 1
fi

echo "Starting $LLAMA_SERVER_BIN from Hugging Face repo $GEMMA4_HF_REPO (file $GEMMA4_GGUF_FILE)"
echo "Listening on http://${LLAMA_SERVER_HOST}:${LLAMA_SERVER_PORT}/v1"
echo "Stop with Ctrl+C."
exec "$LLAMA_SERVER_BIN" \
  -hf "$GEMMA4_HF_REPO" \
  -m "$GEMMA4_GGUF_FILE" \
  --host "$LLAMA_SERVER_HOST" \
  --port "$LLAMA_SERVER_PORT" \
  --reasoning-budget 0 \
  --chat-template-kwargs '{"enable_thinking": false}' \
  --reasoning-format deepseek
