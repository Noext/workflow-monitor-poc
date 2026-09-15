# Dynamic Workflows live-activity patch

The monitor reads persisted workflow JSON files. With the official npm release of `pi-dynamic-workflows-mingrui@3.3.1`, an agent can appear as running while its `history` remains empty on disk until the agent finishes. The monitor then shows:

```text
Live activity (0 latest events)
No detailed activity recorded yet.
```

This repository includes a version-pinned patch that makes the extension persist agent starts, resolved models, compact history updates, and a bounded liveness heartbeat while agents are running.

## Scope and compatibility

The patch targets **exactly**:

```text
pi-dynamic-workflows-mingrui@3.3.1
```

It changes the extension installed on the machine; it does not change Pi workflow records that already completed. It includes both `src/` and built `dist/` files, so rebuilding the package later does not immediately discard the source-side changes.

Do not force it onto another version. The apply script checks the installed version and performs a dry-run before changing files.

## Files in this repository

- `patches/pi-dynamic-workflows-mingrui-3.3.1-live-activity.patch` — reproducible unified Git patch against the official npm tarball.
- `scripts/apply-dynamic-workflows-live-patch.sh` — locates the Pi-installed package, checks compatibility, creates a backup, and applies the patch.
- `scripts/check-dynamic-workflows-live-patch.sh` — verifies that the full patch is present.

## Apply on another PC

Update this repository first:

```bash
git pull
```

Confirm the installed extension version:

```bash
node -p 'require(process.env.HOME + "/.pi/agent/npm/node_modules/pi-dynamic-workflows-mingrui/package.json").version'
```

It must print `3.3.1`. Then apply:

```bash
./scripts/apply-dynamic-workflows-live-patch.sh
```

The script:

1. looks under `$PI_AGENT_DIR/npm/node_modules`, `~/.pi/agent/npm/node_modules`, then `~/.pi/agent/node_modules`;
2. refuses any version other than `3.3.1`;
3. detects an already-applied patch;
4. runs `git apply --check` before mutation;
5. copies the complete package to a timestamped sibling backup;
6. applies the patch and verifies it with a reverse dry-run.

For a nonstandard installation, pass the package directory explicitly:

```bash
PI_DYNAMIC_WORKFLOWS_DIR=/absolute/path/to/pi-dynamic-workflows-mingrui \
  ./scripts/apply-dynamic-workflows-live-patch.sh
```

## Restart Pi

The extension is loaded into each Pi process. Close and restart every active Pi session after applying the patch. Restarting only the workflow monitor is not sufficient.

Then restart the monitor if needed:

```bash
./stop.sh
./start.sh
```

## Verify

Check the package mechanically:

```bash
./scripts/check-dynamic-workflows-live-patch.sh
```

Expected output ends with:

```text
Status: patched
```

Start a new workflow containing an agent expected to run for more than a few seconds. While it is still running, locate the newest run file:

```bash
find ~/.pi/workflows/projects -path '*/runs/*.json' -type f \
  -printf '%T@ %p\n' | sort -nr | head
```

Inspect it without printing prompts or results that may contain private data:

```bash
RUN_FILE=/path/from/the/previous/command
node - "$RUN_FILE" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const run = JSON.parse(fs.readFileSync(file, "utf8"));
console.log({ status: run.status, updatedAt: run.updatedAt });
for (const agent of run.agents ?? []) {
  console.log({
    id: agent.id,
    status: agent.status,
    model: agent.model,
    historyEvents: agent.history?.length ?? 0,
  });
}
NODE
```

During an active run:

- the running agent should already exist in `agents`;
- `updatedAt` should continue advancing, including during a silent long-running agent;
- after the agent emits messages or tool calls, `historyEvents` should become greater than zero before completion;
- the resolved concrete `model` should appear as soon as model resolution completes.

The monitor polls every two seconds, so the modal should update shortly after the JSON changes.

## What the patch changes

The patch adds or propagates these behaviors through the extension:

- persists the first agent start immediately;
- coalesces subsequent progress writes on a short trailing edge;
- persists compact `agent.history` snapshots during execution;
- persists phase and workflow-log progress;
- separates requested model/tier metadata from the concrete resolved model;
- persists resolved-model and fallback state while the agent is running;
- emits and persists a run-level heartbeat every 15 seconds while an agent remains active;
- makes the extension's own task panel and workflow UI react to history and heartbeat events;
- clears heartbeat timers on completion, failure, pause, stop, supersession, and deletion.

The heartbeat updates liveness metadata only. It does not fabricate activity entries.

## Roll back

The apply script prints the backup directory it created, for example:

```text
~/.pi/agent/npm/node_modules/pi-dynamic-workflows-mingrui.backup-live-activity-YYYYMMDDTHHMMSSZ
```

To restore it, first close all Pi sessions, then replace the patched directory:

```bash
PACKAGE="$HOME/.pi/agent/npm/node_modules/pi-dynamic-workflows-mingrui"
BACKUP="$HOME/.pi/agent/npm/node_modules/pi-dynamic-workflows-mingrui.backup-live-activity-YYYYMMDDTHHMMSSZ"
rm -rf "$PACKAGE"
cp -a "$BACKUP" "$PACKAGE"
```

Alternatively, reinstalling/updating the Pi package may restore official npm contents. Be aware that any later Pi or extension update can overwrite the patch; rerun the checker after updates.

## Troubleshooting

### Package not found

Locate it and provide the directory:

```bash
find ~/.pi -type f -path '*/pi-dynamic-workflows-mingrui/package.json' -print
PI_DYNAMIC_WORKFLOWS_DIR=/found/package/directory ./scripts/apply-dynamic-workflows-live-patch.sh
```

### Version mismatch

Do not bypass the guard. Install `3.3.1`, or regenerate and review the patch against the exact newer npm release. Internal extension APIs can change between versions.

### Patch preflight failed

The installation is already modified or does not match the official npm tarball. The script changes nothing when preflight fails. Compare or reinstall the package before retrying.

### Checker passes but history stays empty

Verify all Pi sessions were restarted and that the workflow was started after restart. Also verify the JSON file's `updatedAt` changes. If it advances but `history` stays empty, the underlying agent session may not be emitting message events; the heartbeat proves liveness but cannot invent history.

### Monitor and Pi use different users

Both normally use the current user's `~/.pi`. Run the monitor as the same OS user as Pi, or configure:

```bash
WORKFLOW_DATA_ROOT=/that/users/home/.pi/workflows/projects ./start.sh
```
