#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="@quintinshaw/pi-dynamic-workflows"
PACKAGE_PATH="@quintinshaw/pi-dynamic-workflows"
EXPECTED_VERSION="3.12.0"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PATCH_FILE="$REPO_DIR/patches/quintinshaw-pi-dynamic-workflows-3.12.0-live-activity.patch"

find_package_dir() {
  if [[ -n "${PI_DYNAMIC_WORKFLOWS_DIR:-}" ]]; then printf '%s\n' "$PI_DYNAMIC_WORKFLOWS_DIR"; return; fi
  local candidates=()
  if [[ -n "${PI_AGENT_DIR:-}" ]]; then candidates+=("$PI_AGENT_DIR/npm/node_modules/$PACKAGE_PATH"); fi
  candidates+=("$PWD/.pi/npm/node_modules/$PACKAGE_PATH" "$HOME/.pi/agent/npm/node_modules/$PACKAGE_PATH" "$HOME/.pi/agent/node_modules/$PACKAGE_PATH")
  local candidate
  for candidate in "${candidates[@]}"; do
    [[ -f "$candidate/package.json" ]] && { printf '%s\n' "$candidate"; return; }
  done
  return 1
}

PACKAGE_DIR="$(find_package_dir || true)"
[[ -n "$PACKAGE_DIR" ]] || { echo "Could not find $PACKAGE_NAME. Set PI_DYNAMIC_WORKFLOWS_DIR and retry." >&2; exit 1; }
VERSION="$(node -p "require(process.argv[1]).version" "$PACKAGE_DIR/package.json")"
NAME="$(node -p "require(process.argv[1]).name" "$PACKAGE_DIR/package.json")"
echo "Package: $PACKAGE_DIR"
echo "Name: $NAME"
echo "Version: $VERSION"
[[ "$NAME" == "$PACKAGE_NAME" && "$VERSION" == "$EXPECTED_VERSION" ]] || { echo "Package/version mismatch." >&2; exit 1; }
if git -C "$PACKAGE_DIR" apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
  echo "Status: patched"
else
  echo "Status: not patched, partially patched, or package contents differ from npm $EXPECTED_VERSION" >&2
  exit 1
fi
