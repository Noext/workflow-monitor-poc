#!/usr/bin/env node
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const DATA_ROOT = "/root/.pi/workflows/projects";
const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const ID_RE = /^(?=.{1,180}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ACTIVE_STATUSES = new Set(["running", "paused"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT must be 1-65535");

const text = (v, max = 240) => typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").slice(0, max) : "";
const longText = (v, max = 12000) => typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, max) : "";
const number = v => typeof v === "number" && Number.isFinite(v) ? v : 0;
function safeReadJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function isSafeId(value) { return typeof value === "string" && ID_RE.test(value) && value !== "." && value !== ".."; }
function isRegularFile(file) { try { return fs.lstatSync(file).isFile(); } catch { return false; } }
function agentView(a) {
  a = a && typeof a === "object" ? a : {};
  const usage = a.tokenUsage && typeof a.tokenUsage === "object" ? a.tokenUsage : {};
  return { id: text(a.id == null ? a.label || "unknown" : String(a.id), 80), label: text(a.label, 120), status: text(a.status || "unknown", 40), phase: text(a.phase, 100), prompt: text(a.prompt, 280), model: text(a.model, 100) || "Not recorded", startedAt: text(a.startedAt, 60), endedAt: text(a.endedAt, 60), tokens: number(a.tokens) || number(usage.total), tokenUsage: { input:number(usage.input), output:number(usage.output), cacheRead:number(usage.cacheRead), cacheWrite:number(usage.cacheWrite), total:number(usage.total) || number(a.tokens) } };
}
function agentDetailView(a) {
  const summary = agentView(a);
  const history = Array.isArray(a.history) ? a.history.slice(-120).map(item => {
    item = item && typeof item === "object" ? item : {};
    return { role:text(item.role, 40), kind:text(item.kind, 40), toolName:text(item.toolName, 100), text:longText(item.text), timestamp:number(item.timestamp), isError:item.isError === true };
  }) : [];
  return {...summary, prompt:longText(a.prompt, 30000), resultPreview:longText(a.resultPreview, 30000), history};
}
function phaseViews(value) {
  // Workflow records declare phases as an ordered list of strings. Old or damaged
  // records may omit it or contain other values; those records still render normally.
  if (!Array.isArray(value.phases)) return [];
  const declared = value.phases.map(phase => text(phase, 120)).filter(Boolean);
  const current = text(value.currentPhase, 120);
  const currentIndex = declared.indexOf(current);
  const agents = Array.isArray(value.agents) ? value.agents : [];
  const successful = new Set(agents.filter(a => a && ["done", "completed", "success"].includes(String(a.status || "").toLowerCase())).map(a => text(a.phase, 120)));
  const active = new Set(agents.filter(a => a && ["running", "paused"].includes(String(a.status || "").toLowerCase())).map(a => text(a.phase, 120)));
  const runActive = ACTIVE_STATUSES.has(String(value.status || "").toLowerCase());
  return declared.map((name, index) => {
    if (successful.has(name) || currentIndex > index) return { name, state:"completed", label:"completed" };
    if ((runActive && index === currentIndex) || active.has(name)) return { name, state:"current", label:"running" };
    return { name, state:"pending", label:"pending · not started" };
  });
}
function runView(project, file) {
  const value = safeReadJson(file);
  const artifactRunId = path.basename(file, ".json");
  // A mismatched record must not be actionable through a filename chosen by its contents.
  if (!value || typeof value !== "object" || Array.isArray(value) || !isSafeId(artifactRunId) || (value.runId != null && value.runId !== artifactRunId)) return null;
  const usage = value.tokenUsage && typeof value.tokenUsage === "object" ? value.tokenUsage : {};
  const phases = phaseViews(value);
  return { project, runId:artifactRunId, workflowName:text(value.workflowName, 160), status:text(value.status || "unknown", 40), phase:text(value.currentPhase || phases.at(-1)?.name || "", 120), phases, startedAt:text(value.startedAt, 60), updatedAt:text(value.updatedAt, 60), endedAt:text(value.endedAt, 60), tokenBudget:value.tokenBudget == null ? null : number(value.tokenBudget), tokenUsage:{input:number(usage.input),output:number(usage.output),cacheRead:number(usage.cacheRead),cacheWrite:number(usage.cacheWrite),total:number(usage.total)}, agents:Array.isArray(value.agents) ? value.agents.map(agentView) : [], models:[...new Set((Array.isArray(value.agents) ? value.agents.map(agentView) : []).map(agent => agent.model))] };
}
function snapshot() {
  const runs = [], skipped = [];
  let projects;
  try { projects = fs.readdirSync(DATA_ROOT, { withFileTypes:true }); } catch { return { projects:[], skipped:["Workflow data directory unavailable"] }; }
  for (const project of projects) {
    if (!project.isDirectory() || !isSafeId(project.name)) continue;
    const runsDir = path.join(DATA_ROOT, project.name, "runs");
    let files; try { files = fs.readdirSync(runsDir, {withFileTypes:true}); } catch { continue; }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || !isSafeId(path.basename(entry.name, ".json"))) continue;
      const run = runView(project.name, path.join(runsDir, entry.name));
      if (run) runs.push(run); else skipped.push(`${project.name}/${entry.name}`);
    }
  }
  runs.sort((a,b) => String(b.updatedAt || b.startedAt).localeCompare(String(a.updatedAt || a.startedAt)));
  const grouped = new Map();
  for (const run of runs) { if (!grouped.has(run.project)) grouped.set(run.project, []); grouped.get(run.project).push(run); }
  return { projects:[...grouped].map(([name,runs]) => ({name,runs})), skipped };
}
function json(res, status, body) {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"});
  res.end(JSON.stringify(body));
}
function requestOrigin(req) {
  const host = req.headers.host;
  if (typeof host !== "string" || !host) return null;
  try { return new URL(`http://${host}`).origin; } catch { return null; }
}
function isSameOriginPost(req) {
  const origin = req.headers.origin;
  return typeof origin === "string" && origin === requestOrigin(req);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 4096) reject(Object.assign(new Error("Request body too large"), {status:413})); });
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error("Expected a JSON object"), {status:400})); } });
    req.on("error", reject);
  });
}
function selectedRun(input) {
  if (!input || typeof input !== "object" || !isSafeId(input.project) || !isSafeId(input.runId)) {
    return { error:"project and runId must be validated simple identifiers" };
  }
  const projectDir = path.join(DATA_ROOT, input.project);
  const runsDir = path.join(projectDir, "runs");
  try {
    // lstat (not stat) keeps a crafted project/runs symlink from escaping DATA_ROOT.
    if (!fs.lstatSync(projectDir).isDirectory() || !fs.lstatSync(runsDir).isDirectory()) return {error:"Selected project runs directory is unavailable"};
  } catch { return {error:"Selected project runs directory is unavailable"}; }
  const file = path.join(runsDir, `${input.runId}.json`);
  if (!isRegularFile(file)) return {error:"Canonical run file was not found or is not a regular file", status:404};
  const value = safeReadJson(file);
  if (!value || typeof value !== "object" || Array.isArray(value) || (value.runId != null && value.runId !== input.runId)) {
    return {error:"Canonical run record is invalid or does not match its selected run ID", status:409};
  }
  return { project:input.project, runId:input.runId, runsDir, file, record:value, status:String(value.status || "").toLowerCase() };
}
function findAgent(project, runId, agentId) {
  const run = selectedRun({project, runId});
  if (run.error) return run;
  const agents = Array.isArray(run.record.agents) ? run.record.agents : [];
  const agent = agents.find(candidate => candidate && String(candidate.id == null ? candidate.label || "unknown" : candidate.id) === agentId);
  if (!agent) return {error:"Agent was not found", status:404};
  return {run:{project, runId, workflowName:text(run.record.workflowName, 160), status:text(run.record.status, 40), phase:text(run.record.currentPhase, 120)}, agent:agentDetailView(agent)};
}
function lockIsDemonstrablyDead(lockFile) {
  if (!fs.existsSync(lockFile)) return {ok:true};
  if (!isRegularFile(lockFile)) return {ok:false, error:"Lock is not a regular file; refusing to follow or remove it"};
  const lock = safeReadJson(lockFile);
  const pid = lock && lock.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return {ok:false, error:"Lock has no valid PID; its owner cannot be proven dead"};
  try { process.kill(pid, 0); return {ok:false, error:`Lock owner PID ${pid} is still alive; refusing deletion`}; }
  catch (err) { if (err.code === "ESRCH") return {ok:true}; return {ok:false, error:`Cannot prove lock owner PID ${pid} is dead; refusing deletion`}; }
}
async function handleAction(req, res, action) {
  if (!isSameOriginPost(req)) return json(res, 403, {ok:false, error:"Destructive requests require a same-origin browser POST"});
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return json(res, 415, {ok:false, error:"Content-Type must be application/json"});
  let input;
  try { input = await readBody(req); } catch (err) { return json(res, err.status || 400, {ok:false, error:err.message || "Invalid request"}); }
  const run = selectedRun(input);
  if (run.error) return json(res, run.status || 400, {ok:false, error:run.error});

  if (action === "stop") {
    if (!ACTIVE_STATUSES.has(run.status)) return json(res, 409, {ok:false, error:"Stop is available only for running or paused runs", status:run.status});
    // The dynamic-workflows manager lives only in the Pi process owning this lock. Signalling
    // its PID would kill the entire Pi session, not this one workflow, so do not do it.
    return json(res, 409, {ok:false, error:`This monitor cannot safely stop ${run.runId}: no supported cross-process workflow control exists. In its owning Pi session, use /workflows stop ${run.runId} or workflow_control. No process was signalled and no files were changed.`, status:run.status});
  }

  if (!TERMINAL_STATUSES.has(run.status)) return json(res, 409, {ok:false, error:"Delete is allowed only for completed, failed, or aborted runs", status:run.status});
  const lockCheck = lockIsDemonstrablyDead(path.join(run.runsDir, `${run.runId}.lock`));
  if (!lockCheck.ok) return json(res, 409, {ok:false, error:lockCheck.error, status:run.status});
  const names = [`${run.runId}.json`, `${run.runId}.json.bak`, `${run.runId}.log`, `${run.runId}.lock`];
  // Preflight every exact name before changing anything. lstat rejects symlinks and no
  // directory is recursively removed.
  for (const name of names) {
    try { if (!fs.lstatSync(path.join(run.runsDir, name)).isFile()) return json(res, 409, {ok:false, error:`Artifact ${name} is not a regular file; refusing to remove it`}); }
    catch (err) { if (err.code !== "ENOENT") return json(res, 500, {ok:false, error:`Could not inspect ${name}: ${err.message}`}); }
  }
  const removed = [];
  for (const name of names) {
    try { fs.unlinkSync(path.join(run.runsDir, name)); removed.push(name); }
    catch (err) { if (err.code !== "ENOENT") return json(res, 500, {ok:false, error:`Could not remove ${name}: ${err.message}`, removed}); }
  }
  return json(res, 200, {ok:true, message:"Terminal run artifacts removed. No directories or other files were touched.", removed});
}
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Workflow Monitor</title><style>
:root{color-scheme:dark;--bg:#0b1020;--card:#141b31;--line:#293452;--muted:#9aa8c7;--text:#eef2ff;--green:#3ddc97;--red:#ff6b81;--amber:#ffc857;--blue:#67b7ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#1b2850,#0b1020 46rem);font:14px system-ui,sans-serif;color:var(--text)}main{max-width:1200px;margin:auto;padding:22px}header{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}h1{font-size:clamp(1.35rem,4vw,2rem);margin:0}.sub{color:var(--muted);margin:5px 0 12px}.warning{border:1px solid #805a22;background:#362817;color:#ffe0a0;border-radius:10px;padding:10px;max-width:850px}.meta{color:var(--muted);font-size:12px}.project{margin:24px 0}.project h2{font-size:1rem;color:#c9d5f5}.run{background:color-mix(in srgb,var(--card) 94%,#fff);border:1px solid var(--line);border-radius:14px;padding:16px;margin:10px 0;box-shadow:0 10px 25px #0002}.top{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;flex-wrap:wrap}.name{font-weight:700;overflow-wrap:anywhere}.phase-stepper{display:flex;align-items:stretch;gap:0;margin:0 0 14px;overflow-x:auto;padding:2px 0}.phase-step{display:flex;align-items:center;flex:1;min-width:130px}.phase-step:not(:last-child)::after{content:"";height:2px;flex:1;min-width:14px;background:#50607e;margin:0 7px}.phase-dot{display:grid;place-items:center;flex:0 0 24px;width:24px;height:24px;border-radius:50%;border:2px solid #50607e;background:#17213a;color:#d5e0fa;font-size:12px;font-weight:700}.phase-copy{display:grid;gap:1px;margin-left:7px;white-space:nowrap}.phase-copy b{font-size:12px}.phase-copy span{font-size:11px;color:var(--muted)}.phase-step.completed .phase-dot{border-color:var(--green);background:#174b38;color:var(--green)}.phase-step.current .phase-dot{border-color:var(--blue);background:#123e57;color:#82d5ff;box-shadow:0 0 0 3px #67b7ff22}.phase-step.pending{opacity:.55}.phase-step.pending .phase-dot{border-style:dashed}.phase-step.pending:not(:last-child)::after{background:#37415c}.model-summary{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:12px 0;color:var(--muted)}.model-summary strong{color:var(--text);font-size:12px}.model-chip{display:inline-block;max-width:100%;overflow-wrap:anywhere;border:1px solid #52638a;border-radius:999px;background:#1a2948;color:#cfe1ff;padding:3px 8px;font:600 11px/1.25 ui-monospace,monospace}.agent-model{color:#b9d6ff}.model-feature{margin:14px 0 18px;padding:13px 15px;border:1px solid #607bb0;border-radius:10px;background:linear-gradient(110deg,#172947,#13213b)}.model-feature span{display:block;color:#b9cae9;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.model-feature code{display:block;margin-top:5px;color:#fff;font-size:clamp(1rem,2.4vw,1.35rem);font-weight:750;overflow-wrap:anywhere}.details{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:9px;margin:14px 0;color:var(--muted)}.details b{display:block;color:var(--text);font-size:12px;margin-top:2px}.pill{padding:4px 9px;border-radius:999px;font-size:12px;font-weight:700;text-transform:uppercase;background:#33415f;color:#d5e0fa}.running{background:#123e57;color:#82d5ff}.completed,.done,.success{background:#174b38;color:var(--green)}.failed,.error{background:#542333;color:var(--red)}.aborted,.cancelled{background:#523d1e;color:var(--amber)}.agents{border-top:1px solid var(--line);padding-top:10px}.agent{padding:10px 0;border:0;border-bottom:1px solid #26304b;width:100%;background:transparent;color:inherit;text-align:left;font:inherit}.agent:last-child{border:0}.agent-button{cursor:pointer;border-radius:8px}.agent-button:hover,.agent-button:focus-visible{background:#1c2743;outline:1px solid #53658d;padding-left:10px;padding-right:10px}.agenthead,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.actions{margin-top:12px}.button{border:1px solid #53658d;border-radius:7px;padding:7px 10px;background:#243454;color:var(--text);font:inherit;cursor:pointer}.button.delete{border-color:#a34b5e;background:#542333}.button:disabled{cursor:not-allowed;opacity:.5}.notice{margin:10px 0;padding:10px;border-radius:8px;background:#173f30;color:#baf3d5}.notice.error{background:#542333;color:#ffd0d9}.prompt{color:var(--muted);margin:7px 0 0;line-height:1.4;white-space:pre-wrap}.empty{padding:24px;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}code{font-family:ui-monospace,monospace;font-size:.9em}.modal{position:fixed;inset:0;background:#02040bcc;display:grid;place-items:center;padding:18px;z-index:20}.modal[hidden]{display:none}.panel{width:min(1000px,100%);max-height:90vh;overflow:auto;background:#111a30;border:1px solid #405176;border-radius:14px;padding:18px;box-shadow:0 25px 80px #000a}.paneltop{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;position:sticky;top:-18px;background:#111a30;padding:18px 0 10px;z-index:2}.close{font-size:20px;padding:4px 10px}.timeline{display:grid;gap:9px;margin-top:14px}.event{border-left:3px solid #53658d;background:#0c1428;padding:10px 12px;border-radius:5px}.event.error{border-color:var(--red)}.event pre,.fullprompt{white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0 0;color:#cbd6f2;font:12px/1.45 ui-monospace,monospace}.eventmeta{color:var(--muted);font-size:12px}.hint{color:var(--blue);font-size:12px;margin-left:auto}@media(max-width:520px){main{padding:14px}.run{padding:13px}.modal{padding:6px}.panel{padding:12px}.paneltop{top:-12px;padding-top:12px}}
</style><main><header><div><h1>Pi Workflow Monitor</h1><div class="sub">Local workflow progress and limited terminal-run cleanup</div><div class="warning"><b>LAN-only destructive POC:</b> no authentication or encryption. Do not expose this server to the Internet. Stop cannot safely control a workflow from another Pi process; Delete permanently removes only terminal run artifacts.</div></div><div class="meta" id="refresh">Loading…</div></header><div id="notice" aria-live="polite"></div><div id="app"></div></main><div class="modal" id="agent-modal" hidden><section class="panel" role="dialog" aria-modal="true" aria-labelledby="agent-title"><div class="paneltop"><div><h2 id="agent-title" style="margin:0">Agent activity</h2><div class="meta" id="agent-subtitle"></div></div><button class="button close" id="close-agent" aria-label="Close">×</button></div><div id="agent-detail">Loading…</div></section></div><script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));const fmt=v=>v?new Date(v).toLocaleString():"—";const n=v=>new Intl.NumberFormat().format(v||0);const cls=s=>String(s||"unknown").toLowerCase().replace(/[^a-z]+/g,"-");let inFlight=false;
function usage(u){return "total "+n(u?.total)+" · in "+n(u?.input)+" · out "+n(u?.output)+(u?.cacheRead?" · cache "+n(u.cacheRead):"")};function active(s){return ["running","paused"].includes(String(s).toLowerCase())};function terminal(s){return ["completed","failed","aborted"].includes(String(s).toLowerCase())};
function notice(message,error=false){const el=document.querySelector("#notice");el.innerHTML=message?'<div class="notice '+(error?'error':'')+'">'+esc(message)+'</div>':''}
function buttons(r){const stop=active(r.status), del=terminal(r.status);return '<div class="actions"><button class="button" data-action="stop" data-eligible="'+(stop?'yes':'no')+'" data-project="'+esc(r.project)+'" data-run="'+esc(r.runId)+'" '+(stop?'':'disabled title="Only running or paused runs are eligible"')+'>Stop</button><button class="button delete" data-action="delete" data-eligible="'+(del?'yes':'no')+'" data-project="'+esc(r.project)+'" data-run="'+esc(r.runId)+'" '+(del?'':'disabled title="Only completed, failed, or aborted runs can be deleted"')+'>Delete</button></div>'}
function stepper(phases){return phases?.length?'<div class="phase-stepper" aria-label="Workflow phases">'+phases.map((p,i)=>'<div class="phase-step '+esc(p.state)+'"><span class="phase-dot">'+(p.state==='completed'?'✓':i+1)+'</span><span class="phase-copy"><b>'+esc(p.name)+'</b><span>'+esc(p.label)+'</span></span></div>').join('')+'</div>':'<div class="meta">No declared workflow phases.</div>'}
function modelChips(models){return (models?.length?models:["Not recorded"]).map(model=>'<code class="model-chip">'+esc(model)+'</code>').join('')}
function render(data){document.querySelector("#refresh").textContent="Last refresh: "+new Date(data.refreshedAt).toLocaleTimeString()+" · every 2s";const app=document.querySelector("#app");if(!data.projects.length){app.innerHTML='<div class="empty">No readable canonical run files found.</div>';return}app.innerHTML=data.projects.map(p=>'<section class="project"><h2>'+esc(p.name)+' <span class="meta">('+p.runs.length+' runs)</span></h2>'+p.runs.map(r=>'<article class="run"><div class="top"><div><div class="name">'+esc(r.workflowName||r.runId)+'</div><div class="meta"><code>'+esc(r.runId)+'</code></div></div><span class="pill '+cls(r.status)+'">'+esc(r.status)+'</span></div>'+stepper(r.phases)+'<div class="model-summary"><strong>Agent models</strong>'+modelChips(r.models)+'</div><div class="details"><span>Phase<b>'+esc(r.phase||"—")+'</b></span><span>Started<b>'+fmt(r.startedAt)+'</b></span><span>Updated<b>'+fmt(r.updatedAt)+'</b></span><span>Ended<b>'+fmt(r.endedAt)+'</b></span><span>Tokens<b>'+usage(r.tokenUsage)+'</b></span></div>'+buttons(r)+'<div class="agents">'+(r.agents.length?r.agents.map(a=>'<button class="agent agent-button" data-agent-id="'+esc(a.id)+'" data-project="'+esc(r.project)+'" data-run="'+esc(r.runId)+'"><div class="agenthead"><b>Agent '+esc(a.id)+(a.label?' · '+esc(a.label):'')+'</b><span class="pill '+cls(a.status)+'">'+esc(a.status)+'</span><code class="model-chip agent-model">'+esc(a.model)+'</code><span class="meta">'+esc(a.phase||"")+'</span><span class="hint">View live activity →</span></div><div class="meta">'+fmt(a.startedAt)+' → '+fmt(a.endedAt)+' · '+usage(a.tokenUsage)+'</div>'+(a.prompt?'<div class="prompt">'+esc(a.prompt)+'</div>':'')+'</button>').join(''):'<div class="meta">No agents recorded yet.</div>')+'</div></article>').join('')+'</section>').join('')}
let selectedAgent=null;
function renderAgentDetail(data){const a=data.agent;document.querySelector("#agent-title").innerHTML='Agent '+esc(a.id)+(a.label?' · '+esc(a.label):'')+' <span class="pill '+cls(a.status)+'">'+esc(a.status)+'</span>';document.querySelector("#agent-subtitle").textContent=(data.run.workflowName||data.run.runId)+' · '+(a.phase||data.run.phase||'');const events=a.history||[];document.querySelector("#agent-detail").innerHTML='<div class="model-feature"><span>Model used by this agent</span><code>'+esc(a.model)+'</code></div><div class="details"><span>Started<b>'+fmt(a.startedAt)+'</b></span><span>Ended<b>'+fmt(a.endedAt)+'</b></span><span>Tokens<b>'+usage(a.tokenUsage)+'</b></span></div>'+(a.prompt?'<h3>Mission</h3><div class="fullprompt">'+esc(a.prompt)+'</div>':'')+(a.resultPreview?'<h3>Latest result</h3><div class="fullprompt">'+esc(a.resultPreview)+'</div>':'')+'<h3>Live activity <span class="meta">('+events.length+' latest events)</span></h3><div class="timeline">'+(events.length?events.map(x=>'<article class="event '+(x.isError?'error':'')+'"><div class="eventmeta">'+esc(x.role||'event')+(x.kind?' · '+esc(x.kind):'')+(x.toolName?' · '+esc(x.toolName):'')+(x.timestamp?' · '+new Date(x.timestamp).toLocaleTimeString():'')+'</div><pre>'+esc(x.text||'—')+'</pre></article>').join(''):'<div class="empty">No detailed activity recorded yet.</div>')+'</div>'}
async function loadAgentDetail(){if(!selectedAgent)return;try{const {project,runId,agentId}=selectedAgent;const r=await fetch('/api/runs/'+encodeURIComponent(project)+'/'+encodeURIComponent(runId)+'/agents/'+encodeURIComponent(agentId),{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||r.status);renderAgentDetail(data)}catch(e){document.querySelector("#agent-detail").innerHTML='<div class="notice error">'+esc(e.message)+'</div>'}}
function openAgent(button){selectedAgent={project:button.dataset.project,runId:button.dataset.run,agentId:button.dataset.agentId};document.querySelector("#agent-modal").hidden=false;document.body.style.overflow='hidden';loadAgentDetail()}
function closeAgent(){selectedAgent=null;document.querySelector("#agent-modal").hidden=true;document.body.style.overflow=''}
async function load(){if(inFlight)return;try{const r=await fetch("/api/runs",{cache:"no-store"});if(!r.ok)throw Error(r.status);render(await r.json())}catch(e){document.querySelector("#refresh").textContent="Refresh failed: "+e.message}}
async function action(e){const b=e.target.closest("button[data-action]");if(!b||inFlight||b.disabled)return;const type=b.dataset.action,run=b.dataset.run;if(type==="stop"&&!confirm('Stop '+run+'? This monitor cannot safely stop a workflow owned by another Pi process. It will not signal a PID; it will tell you the owning-session command.'))return;if(type==="delete"&&!confirm('Delete terminal run '+run+'? This permanently removes its canonical .json, .json.bak, .log, and eligible dead .lock artifacts. It cannot be undone.'))return;inFlight=true;document.querySelectorAll("button[data-action]").forEach(x=>x.disabled=true);notice("Submitting "+type+" request…");try{const r=await fetch('/api/runs/'+type,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:b.dataset.project,runId:run})});const data=await r.json().catch(()=>({error:'Invalid server response'}));if(!r.ok)throw Error(data.error||('Request failed ('+r.status+')'));notice(data.message||(type+' request completed.')+(data.removed?.length?' Removed: '+data.removed.join(', '):''));await load()}catch(err){notice(err.message,true)}finally{inFlight=false;document.querySelectorAll("button[data-action]").forEach(x=>x.disabled=x.dataset.eligible!=="yes");await load()}}
document.addEventListener('click',e=>{const agent=e.target.closest('[data-agent-id]');if(agent)return openAgent(agent);action(e)});document.querySelector('#close-agent').addEventListener('click',closeAgent);document.querySelector('#agent-modal').addEventListener('click',e=>{if(e.target.id==='agent-modal')closeAgent()});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeAgent()});load();setInterval(()=>{load();loadAgentDetail()},2000);
</script>`;
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.search) { res.writeHead(404); return res.end("Not found"); }
  if (req.method === "POST" && (url.pathname === "/api/runs/stop" || url.pathname === "/api/runs/delete")) return handleAction(req, res, url.pathname.endsWith("/stop") ? "stop" : "delete");
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405,{Allow:"GET, HEAD, POST"}); return res.end(); }
  const agentMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/([^/]+)\/agents\/([^/]+)$/);
  if (agentMatch) {
    const values = agentMatch.slice(1).map(value => { try { return decodeURIComponent(value); } catch { return ""; } });
    if (!values.every(isSafeId)) return json(res, 400, {error:"Invalid project, run, or agent identifier"});
    const detail = findAgent(values[0], values[1], values[2]);
    if (detail.error) return json(res, detail.status || 400, {error:detail.error});
    if (req.method === "HEAD") { res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}); return res.end(); }
    return json(res, 200, detail);
  }
  if (url.pathname !== "/" && url.pathname !== "/api/runs") { res.writeHead(404); return res.end("Not found"); }
  if (url.pathname === "/api/runs") { const body=JSON.stringify({...snapshot(),refreshedAt:new Date().toISOString()}); res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}); return res.end(req.method === "HEAD" ? "" : body); }
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}); res.end(req.method === "HEAD" ? "" : html);
});
server.listen(PORT, "0.0.0.0", () => console.log(`Pi Workflow Monitor listening on http://0.0.0.0:${PORT}`));
