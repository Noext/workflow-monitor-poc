#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="@quintinshaw/pi-dynamic-workflows"
PACKAGE_PATH="@quintinshaw/pi-dynamic-workflows"
EXPECTED_VERSION="3.12.0"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PATCH_FILE="$REPO_DIR/patches/quintinshaw-pi-dynamic-workflows-3.12.0-live-activity.patch"

find_package_dir() {
  if [[ -n "${PI_DYNAMIC_WORKFLOWS_DIR:-}" ]]; then
    printf '%s\n' "$PI_DYNAMIC_WORKFLOWS_DIR"
    return
  fi

  local candidates=()
  if [[ -n "${PI_AGENT_DIR:-}" ]]; then
    candidates+=("$PI_AGENT_DIR/npm/node_modules/$PACKAGE_PATH")
  fi
  candidates+=(
    "$PWD/.pi/npm/node_modules/$PACKAGE_PATH"
    "$HOME/.pi/agent/npm/node_modules/$PACKAGE_PATH"
    "$HOME/.pi/agent/node_modules/$PACKAGE_PATH"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate/package.json" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

PACKAGE_DIR="$(find_package_dir || true)"
if [[ -z "$PACKAGE_DIR" ]]; then
  echo "Could not find $PACKAGE_NAME." >&2
  echo "Set PI_DYNAMIC_WORKFLOWS_DIR to its package directory and retry." >&2
  exit 1
fi

[[ -f "$PATCH_FILE" ]] || { echo "Patch file not found: $PATCH_FILE" >&2; exit 1; }
VERSION="$(node -p "require(process.argv[1]).version" "$PACKAGE_DIR/package.json")"
NAME="$(node -p "require(process.argv[1]).name" "$PACKAGE_DIR/package.json")"
if [[ "$NAME" != "$PACKAGE_NAME" || "$VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Refusing to patch $NAME $VERSION; expected exactly $PACKAGE_NAME $EXPECTED_VERSION." >&2
  exit 1
fi

if git -C "$PACKAGE_DIR" apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
  echo "$PACKAGE_NAME $EXPECTED_VERSION is already patched."
  exit 0
fi
if ! git -C "$PACKAGE_DIR" apply --check "$PATCH_FILE"; then
  echo "Patch preflight failed. No files were changed." >&2
  echo "The package may differ from the official npm $EXPECTED_VERSION contents." >&2
  exit 1
fi

BACKUP_DIR="${PACKAGE_DIR}.backup-live-activity-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$PACKAGE_DIR" "$BACKUP_DIR"
git -C "$PACKAGE_DIR" apply "$PATCH_FILE"
if ! git -C "$PACKAGE_DIR" apply --reverse --check "$PATCH_FILE"; then
  echo "Post-apply verification failed; restoring the backup." >&2
  rm -rf "$PACKAGE_DIR"
  cp -a "$BACKUP_DIR" "$PACKAGE_DIR"
  exit 1
fi

echo "Applied live-activity persistence patch to: $PACKAGE_DIR"
echo "Backup created at: $BACKUP_DIR"
echo "Restart every running Pi session so the extension is reloaded."
