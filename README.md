# Pi Workflow Monitor POC

A deliberately small, dependency-free Node.js UI for Pi dynamic-workflow records in `~/.pi/workflows/projects/*/runs/*.json`.

## Start / stop

```bash
cd /root/Dev/workflow-monitor-poc
./start.sh
./stop.sh
```

The default is port `8787`; override it with `PORT=9000 ./start.sh`. By default the monitor reads the current OS user's `~/.pi/workflows/projects` directory. For a custom Pi home or container mount, use `WORKFLOW_DATA_ROOT=/path/to/.pi/workflows/projects ./start.sh`. Runtime state is recorded in `workflow-monitor.pid`; output is appended to `workflow-monitor.log`. `start.sh` refuses to start a duplicate live process.

## Access and API

Open `http://localhost:8787` locally, or `http://<this-machine-LAN-IPv4>:8787` from the LAN.

- `GET /api/runs` lists readable canonical records; it accepts no query parameters.
  Each run includes an ordered phase timeline from its declared `phases` array. Completed phases are green, the current phase is blue, and declared future phases remain visible as subdued `pending · not started` steps. Records without a usable phase array show a harmless empty-state message.
- Every workflow card lists only concrete models resolved by the runtime. Agent rows show the same value while running as after completion as soon as it is persisted. Until then, a request/tier is explicitly shown as `Resolving model…`; it is never presented as a model in use. Missing legacy metadata remains `Not recorded`.
- Click an agent in the UI to open its live mission and recent activity/tool-call timeline. The detail view calls a concrete resolved value “Model used by this agent”; pending or fallback metadata is labelled accordingly and refreshes every two seconds through `GET /api/runs/<project>/<runId>/agents/<agentId>`.
- `POST /api/runs/stop` and `POST /api/runs/delete` accept JSON only: `{"project":"…","runId":"…"}`. Both require an `Origin` exactly matching the server origin. Project and run IDs are strict simple identifiers, then resolved only below the fixed workflow data root; arbitrary paths are never accepted.

## Destructive-control semantics

Every action has a browser confirmation dialog, disables controls while its request is in flight, reports the API result, and refreshes after completion.

### Stop

**The monitor deliberately does not remotely stop a workflow.** The workflow extension has no supported cross-process control plane. Its lock PID belongs to the owning Pi session, not to an individual workflow; killing it would kill that whole Pi session. Killing a child process is also unsafe because cancellation is cooperative and owned by the in-memory workflow manager.

The Stop button is available only for `running` and `paused` records. After confirmation, its endpoint returns `409 Conflict` with the exact owning-session guidance:

```text
/workflows stop <runId>
```

or use `workflow_control` in that owning Pi session. It never signals a PID, alters a record, or claims that a workflow was stopped.

### Delete

Delete is enabled only for terminal records: `completed`, `failed`, or `aborted`. It refuses `running` and `paused` records. For the selected canonical run only, it can remove these exact regular-file artifact names from that run's own `runs` directory:

- `<runId>.json`
- `<runId>.json.bak`
- `<runId>.log`
- `<runId>.lock`

No directories, recursive paths, symlinks, or other artifacts are removed. A lock is removed only when it is absent or its JSON PID is demonstrably dead; a live, malformed, inaccessible, or non-regular lock makes deletion fail. The successful API response lists the names actually removed. This is permanent and cannot be undone.

## Security warning

**There is no authentication or encryption. This is LAN-only POC software. Do not expose it to the Internet, port-forward it, or use it on an untrusted network.** Same-origin POST validation is only a minimal browser-side abuse barrier, not authentication. Anyone able to use this server origin on the LAN can read records and request eligible terminal-run deletion.
