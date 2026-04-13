#!/usr/bin/env bash
# Start Gemma 4 E2B Q4_K_M via llama-server in the background (repo default: unsloth GGUF).
# Logs: .tmp/llama-server.log   PID: .tmp/llama-server.pid
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/.tmp"
LOG_PATH="$ROOT/.tmp/llama-server.log"
PID_PATH="$ROOT/.tmp/llama-server.pid"
if [[ -f "$PID_PATH" ]]; then
  old="$(cat "$PID_PATH" 2>/dev/null || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    echo "Stopping existing llama-server pid $old"
    kill "$old" 2>/dev/null || true
    sleep 2
  fi
fi
: > "$LOG_PATH"
if command -v setsid >/dev/null 2>&1; then
  setsid bash "$ROOT/scripts/run-local-llm-gemma4-e2b.sh" >> "$LOG_PATH" 2>&1 < /dev/null &
else
  nohup bash "$ROOT/scripts/run-local-llm-gemma4-e2b.sh" >> "$LOG_PATH" 2>&1 < /dev/null &
fi
echo $! > "$PID_PATH"
echo "Started llama-server pid $(cat "$PID_PATH"); tail -f $LOG_PATH"
