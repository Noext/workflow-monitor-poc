#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="pi-dynamic-workflows-mingrui"
EXPECTED_VERSION="3.3.1"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PATCH_FILE="$REPO_DIR/patches/pi-dynamic-workflows-mingrui-3.3.1-live-activity.patch"

find_package_dir() {
  if [[ -n "${PI_DYNAMIC_WORKFLOWS_DIR:-}" ]]; then
    printf '%s\n' "$PI_DYNAMIC_WORKFLOWS_DIR"
    return
  fi
  local candidates=()
  if [[ -n "${PI_AGENT_DIR:-}" ]]; then
    candidates+=("$PI_AGENT_DIR/npm/node_modules/$PACKAGE_NAME")
  fi
  candidates+=("$HOME/.pi/agent/npm/node_modules/$PACKAGE_NAME" "$HOME/.pi/agent/node_modules/$PACKAGE_NAME")
  local candidate
  for candidate in "${candidates[@]}"; do
    [[ -f "$candidate/package.json" ]] && { printf '%s\n' "$candidate"; return; }
  done
  return 1
}

PACKAGE_DIR="$(find_package_dir || true)"
if [[ -z "$PACKAGE_DIR" ]]; then
  echo "Could not find $PACKAGE_NAME. Set PI_DYNAMIC_WORKFLOWS_DIR and retry." >&2
  exit 1
fi

VERSION="$(node -p "require(process.argv[1]).version" "$PACKAGE_DIR/package.json")"
echo "Package: $PACKAGE_DIR"
echo "Version: $VERSION"

if [[ "$VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Version mismatch: this repository's patch targets $EXPECTED_VERSION." >&2
  exit 1
fi

if git -C "$PACKAGE_DIR" apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
  echo "Status: patched"
else
  echo "Status: not patched, partially patched, or package contents differ from npm $EXPECTED_VERSION" >&2
  exit 1
fi
