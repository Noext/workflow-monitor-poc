#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PID_FILE="$(pwd)/workflow-monitor.pid"
LOG_FILE="$(pwd)/workflow-monitor.log"
is_ours() {
  [[ "$1" =~ ^[0-9]+$ ]] && kill -0 "$1" 2>/dev/null &&
    [[ $(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || true) == *"node server.js"* ]]
}
if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if is_ours "$pid"; then echo "Already running (PID $pid)."; exit 0; fi
  rm -f "$PID_FILE"
fi
nohup node server.js >>"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" >"$PID_FILE"
sleep 0.2
if ! is_ours "$pid"; then echo "Server failed to start; see $LOG_FILE" >&2; rm -f "$PID_FILE"; exit 1; fi
echo "Started Pi Workflow Monitor (PID $pid). Log: $LOG_FILE"
