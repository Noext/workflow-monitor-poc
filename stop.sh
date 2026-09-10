#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PID_FILE="$(pwd)/workflow-monitor.pid"
[[ -f "$PID_FILE" ]] || { echo "Not running (no pid file)."; exit 0; }
pid=$(cat "$PID_FILE" 2>/dev/null || true)
is_ours() {
  [[ "$1" =~ ^[0-9]+$ ]] && kill -0 "$1" 2>/dev/null &&
    [[ $(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || true) == *"node server.js"* ]]
}
if is_ours "$pid"; then
  kill "$pid"
  for _ in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$pid" 2>/dev/null && { echo "PID $pid did not stop." >&2; exit 1; }
else
  echo "Removing stale/non-monitor pid file."
fi
rm -f "$PID_FILE"
echo "Stopped Pi Workflow Monitor."
