#!/usr/bin/env bash
# vLLM server lifecycle. Usage: vllm-server.sh {start <repo> [args...]|stop|restart <repo>|status}
set -euo pipefail

SETUP_DIR="${OPENCODE_LOCAL_SETUP_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode/local-setup}"
VENV_DIR="${VLLM_VENV_DIR:-$SETUP_DIR/vllm-env}"
PID_FILE="$SETUP_DIR/.vllm.pid"
LOG_FILE="$SETUP_DIR/vllm.log"
PORT="${VLLM_PORT:-8000}"
HOST="${VLLM_HOST:-0.0.0.0}"
HEALTH_RETRIES="${VLLM_HEALTH_RETRIES:-60}"

vllm_bin() {
  if [ -x "$VENV_DIR/bin/vllm" ]; then
    echo "$VENV_DIR/bin/vllm"
  elif command -v vllm >/dev/null 2>&1; then
    command -v vllm
  else
    echo "vLLM is not installed. Run the installer with --provider vllm." >&2
    return 1
  fi
}

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    rm -f "$PID_FILE"
  fi
  curl -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1
}

start_server() {
  local model="${1:-}"
  shift || true

  if [ -z "$model" ]; then
    echo "Usage: vllm-server.sh start <hf-repo> [extra vllm args...]" >&2
    return 1
  fi

  if is_running; then
    echo "vLLM is already running (PID $(cat "$PID_FILE" 2>/dev/null || echo '?'))"
    return 0
  fi

  local bin
  bin="$(vllm_bin)" || return 1

  mkdir -p "$SETUP_DIR"
  echo "Starting vLLM: $model"
  "$bin" serve "$model" --host "$HOST" --port "$PORT" "$@" >"$LOG_FILE" 2>&1 &

  local pid=$!
  echo "$pid" > "$PID_FILE"
  chmod 600 "$PID_FILE" 2>/dev/null || true

  local i=0
  while [ "$i" -lt "$HEALTH_RETRIES" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "! vLLM exited during startup. Last lines of $LOG_FILE:" >&2
      tail -n 15 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      return 1
    fi
    if curl -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
      echo "✓ vLLM ready on port $PORT (PID $pid)"
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done

  echo "! vLLM did not become healthy within $((HEALTH_RETRIES * 2))s. See $LOG_FILE" >&2
  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  return 1
}

stop_server() {
  local pid=""
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE")"
  else
    pid="$(lsof -ti:"$PORT" 2>/dev/null | head -1 || true)"
  fi

  if [ -z "$pid" ]; then
    echo "vLLM is not running"
    return 0
  fi

  echo "Stopping vLLM (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  sleep 2
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "✓ Stopped"
}

case "${1:-status}" in
  start) shift; start_server "$@" ;;
  stop) stop_server ;;
  restart) shift; stop_server; sleep 1; start_server "$@" ;;
  status)
    if is_running; then
      echo "vLLM is running (PID $(cat "$PID_FILE" 2>/dev/null || echo '?'))"
    else
      echo "vLLM is not running"
      exit 1
    fi
    ;;
  *) echo "Usage: $0 {start <repo> [args...]|stop|restart <repo>|status}" >&2; exit 1 ;;
esac
