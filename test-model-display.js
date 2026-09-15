#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-monitor-model-test-"));
const project = "model-display-test";
const runId = "running-model-transition";
const runDir = path.join(fixtureRoot, project, "runs");
const runFile = path.join(runDir, `${runId}.json`);
fs.mkdirSync(runDir, { recursive: true });

function record(agent) {
  return {
    runId,
    workflowName: "Model display transition",
    status: "running",
    phases: ["Implementation"],
    currentPhase: "Implementation",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agents: [agent],
  };
}

function write(agent) {
  fs.writeFileSync(runFile, JSON.stringify(record(agent)));
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathname }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on("error", reject);
  });
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try { await get(port, "/api/runs"); return; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw new Error("server did not start");
}

async function main() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  write({
    id: 1,
    label: "tiered agent",
    status: "running",
    phase: "Implementation",
    requestedTier: "small",
  });

  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), WORKFLOW_DATA_ROOT: fixtureRoot },
    stdio: "ignore",
  });
  try {
    await waitForServer(port, child);

    const pending = await get(port, "/api/runs");
    assert.equal(pending.status, 200);
    const pendingRun = pending.body.projects[0].runs[0];
    assert.deepEqual(pendingRun.models, []);
    assert.equal(pendingRun.agents[0].model, "");
    assert.equal(pendingRun.agents[0].modelState, "resolving");
    assert.equal(pendingRun.agents[0].modelLabel, "Resolving model…");
    assert.equal(pendingRun.agents[0].requestedTier, "small");

    const pendingDetail = await get(port, `/api/runs/${project}/${runId}/agents/1`);
    assert.equal(pendingDetail.status, 200);
    assert.equal(pendingDetail.body.agent.modelState, "resolving");
    assert.equal(pendingDetail.body.agent.modelLabel, "Resolving model…");

    write({
      id: 1,
      label: "tiered agent",
      status: "running",
      phase: "Implementation",
      requestedTier: "small",
      model: "local-openai/gpt-5.6-luna:high",
    });
    const resolved = await get(port, "/api/runs");
    const resolvedAgent = resolved.body.projects[0].runs[0].agents[0];
    assert.deepEqual(resolved.body.projects[0].runs[0].models, ["local-openai/gpt-5.6-luna:high"]);
    assert.equal(resolvedAgent.modelState, "resolved");
    assert.equal(resolvedAgent.modelLabel, "local-openai/gpt-5.6-luna:high");

    write({
      id: 1,
      label: "tiered agent",
      status: "done",
      phase: "Implementation",
      requestedTier: "small",
      model: "local-openai/gpt-5.6-luna:high",
    });
    const completedDetail = await get(port, `/api/runs/${project}/${runId}/agents/1`);
    assert.equal(completedDetail.status, 200);
    assert.equal(completedDetail.body.agent.status, "done");
    assert.equal(completedDetail.body.agent.modelState, "resolved");
    assert.equal(completedDetail.body.agent.model, "local-openai/gpt-5.6-luna:high");

    write({
      id: 1,
      label: "fallback agent",
      status: "running",
      phase: "Implementation",
      requestedModel: "missing/provider-model",
      modelFallback: true,
    });
    const fallback = await get(port, "/api/runs");
    const fallbackAgent = fallback.body.projects[0].runs[0].agents[0];
    assert.deepEqual(fallback.body.projects[0].runs[0].models, []);
    assert.equal(fallbackAgent.modelState, "fallback");
    assert.equal(fallbackAgent.model, "");
    assert.equal(fallbackAgent.modelLabel, "Session-default model not reported");

    console.log("model display transition tests passed");
  } finally {
    child.kill();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
