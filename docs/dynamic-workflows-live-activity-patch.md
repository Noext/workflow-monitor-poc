# Dynamic Workflows 3.12.0 live-activity patch

The monitor reads workflow state persisted on disk. The official `@quintinshaw/pi-dynamic-workflows@3.12.0` emits live agent-history events in its own process, but does not write those history updates to the run JSON until a later lifecycle persistence. An external monitor can therefore show `Live activity (0 latest events)` until the agent finishes.

This repository includes a version-pinned patch that persists agent starts, models, compact history, logs, phases, and a liveness heartbeat while agents run.

## Compatibility

The patch targets exactly:

```text
@quintinshaw/pi-dynamic-workflows@3.12.0
```

Do not force it onto another version. The script validates both the npm package name and version, then runs a patch dry-run before changing files.

## Apply

Install the expected official package if necessary:

```bash
pi remove npm:pi-dynamic-workflows-mingrui
pi install npm:@quintinshaw/pi-dynamic-workflows@3.12.0
```

Update this repository and apply the patch:

```bash
git pull
./scripts/apply-dynamic-workflows-live-patch.sh
```

The normal user-level package directory is:

```text
~/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows
```

The script also checks a project-level `.pi/npm/node_modules` installation. For a custom location:

```bash
PI_DYNAMIC_WORKFLOWS_DIR=/absolute/path/to/@quintinshaw/pi-dynamic-workflows \
  ./scripts/apply-dynamic-workflows-live-patch.sh
```

The script creates a timestamped full-package backup before applying the patch. Re-running it is safe: an already-patched installation is detected.

## Restart and verify

Close and restart every Pi session after patching; extensions are loaded into the Pi process. Then verify:

```bash
./scripts/check-dynamic-workflows-live-patch.sh
```

Expected result:

```text
Name: @quintinshaw/pi-dynamic-workflows
Version: 3.12.0
Status: patched
```

Restart the monitor if needed:

```bash
./stop.sh
./start.sh
```

Start a new workflow with a long-running agent. While it is running, the monitor should show its compact message/tool history. The persisted run's `updatedAt` should advance at least every 15 seconds even during a silent operation.

## What changes

The patch modifies both TypeScript sources and the built JavaScript loaded by Pi:

- persists the first running agent immediately;
- coalesces later agent-start and progress writes;
- persists live `agent.history` snapshots;
- persists resolved model updates while the agent runs;
- persists workflow log and phase updates;
- adds one run-level heartbeat every 15 seconds while agents remain active;
- redraws the Pi task panel for history and heartbeat events;
- clears heartbeat timers on agent completion, run completion/failure, pause, stop, and deletion.

The heartbeat only advances liveness state; it does not fabricate history events.

Patch file:

```text
patches/quintinshaw-pi-dynamic-workflows-3.12.0-live-activity.patch
```

## Roll back

The apply script prints the backup path, similar to:

```text
~/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows.backup-live-activity-YYYYMMDDTHHMMSSZ
```

Close Pi, then restore it:

```bash
PACKAGE="$HOME/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows"
BACKUP="$HOME/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows.backup-live-activity-YYYYMMDDTHHMMSSZ"
rm -rf "$PACKAGE"
cp -a "$BACKUP" "$PACKAGE"
```

A package update/reinstall can overwrite the patch. Run the checker again after updating Pi extensions.
