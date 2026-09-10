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
const number = v => typeof v === "number" && Number.isFinite(v) ? v : 0;
function safeReadJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function isSafeId(value) { return typeof value === "string" && ID_RE.test(value) && value !== "." && value !== ".."; }
function isRegularFile(file) { try { return fs.lstatSync(file).isFile(); } catch { return false; } }
function agentView(a) {
  a = a && typeof a === "object" ? a : {};
  const usage = a.tokenUsage && typeof a.tokenUsage === "object" ? a.tokenUsage : {};
  return { id: text(a.id == null ? a.label || "unknown" : String(a.id), 80), label: text(a.label, 120), status: text(a.status || "unknown", 40), phase: text(a.phase, 100), prompt: text(a.prompt, 280), model: text(a.model, 100), startedAt: text(a.startedAt, 60), endedAt: text(a.endedAt, 60), tokens: number(a.tokens) || number(usage.total), tokenUsage: { input:number(usage.input), output:number(usage.output), cacheRead:number(usage.cacheRead), cacheWrite:number(usage.cacheWrite), total:number(usage.total) || number(a.tokens) } };
}
function runView(project, file) {
  const value = safeReadJson(file);
  const artifactRunId = path.basename(file, ".json");
  // A mismatched record must not be actionable through a filename chosen by its contents.
  if (!value || typeof value !== "object" || Array.isArray(value) || !isSafeId(artifactRunId) || (value.runId != null && value.runId !== artifactRunId)) return null;
  const usage = value.tokenUsage && typeof value.tokenUsage === "object" ? value.tokenUsage : {};
  return { project, runId:artifactRunId, workflowName:text(value.workflowName, 160), status:text(value.status || "unknown", 40), phase:text(value.currentPhase || (Array.isArray(value.phases) ? value.phases.at(-1) : ""), 120), startedAt:text(value.startedAt, 60), updatedAt:text(value.updatedAt, 60), endedAt:text(value.endedAt, 60), tokenBudget:value.tokenBudget == null ? null : number(value.tokenBudget), tokenUsage:{input:number(usage.input),output:number(usage.output),cacheRead:number(usage.cacheRead),cacheWrite:number(usage.cacheWrite),total:number(usage.total)}, agents:Array.isArray(value.agents) ? value.agents.map(agentView) : [] };
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
:root{color-scheme:dark;--bg:#0b1020;--card:#141b31;--line:#293452;--muted:#9aa8c7;--text:#eef2ff;--green:#3ddc97;--red:#ff6b81;--amber:#ffc857;--blue:#67b7ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#1b2850,#0b1020 46rem);font:14px system-ui,sans-serif;color:var(--text)}main{max-width:1200px;margin:auto;padding:22px}header{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}h1{font-size:clamp(1.35rem,4vw,2rem);margin:0}.sub{color:var(--muted);margin:5px 0 12px}.warning{border:1px solid #805a22;background:#362817;color:#ffe0a0;border-radius:10px;padding:10px;max-width:850px}.meta{color:var(--muted);font-size:12px}.project{margin:24px 0}.project h2{font-size:1rem;color:#c9d5f5}.run{background:color-mix(in srgb,var(--card) 94%,#fff);border:1px solid var(--line);border-radius:14px;padding:16px;margin:10px 0;box-shadow:0 10px 25px #0002}.top{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;flex-wrap:wrap}.name{font-weight:700;overflow-wrap:anywhere}.details{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:9px;margin:14px 0;color:var(--muted)}.details b{display:block;color:var(--text);font-size:12px;margin-top:2px}.pill{padding:4px 9px;border-radius:999px;font-size:12px;font-weight:700;text-transform:uppercase;background:#33415f;color:#d5e0fa}.running{background:#123e57;color:#82d5ff}.completed,.done,.success{background:#174b38;color:var(--green)}.failed,.error{background:#542333;color:var(--red)}.aborted,.cancelled{background:#523d1e;color:var(--amber)}.agents{border-top:1px solid var(--line);padding-top:10px}.agent{padding:10px 0;border-bottom:1px solid #26304b}.agent:last-child{border:0}.agenthead,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.actions{margin-top:12px}.button{border:1px solid #53658d;border-radius:7px;padding:7px 10px;background:#243454;color:var(--text);font:inherit;cursor:pointer}.button.delete{border-color:#a34b5e;background:#542333}.button:disabled{cursor:not-allowed;opacity:.5}.notice{margin:10px 0;padding:10px;border-radius:8px;background:#173f30;color:#baf3d5}.notice.error{background:#542333;color:#ffd0d9}.prompt{color:var(--muted);margin:7px 0 0;line-height:1.4;white-space:pre-wrap}.empty{padding:24px;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}code{font-family:ui-monospace,monospace;font-size:.9em}@media(max-width:520px){main{padding:14px}.run{padding:13px}}
</style><main><header><div><h1>Pi Workflow Monitor</h1><div class="sub">Local workflow progress and limited terminal-run cleanup</div><div class="warning"><b>LAN-only destructive POC:</b> no authentication or encryption. Do not expose this server to the Internet. Stop cannot safely control a workflow from another Pi process; Delete permanently removes only terminal run artifacts.</div></div><div class="meta" id="refresh">Loading…</div></header><div id="notice" aria-live="polite"></div><div id="app"></div></main><script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));const fmt=v=>v?new Date(v).toLocaleString():"—";const n=v=>new Intl.NumberFormat().format(v||0);const cls=s=>String(s||"unknown").toLowerCase().replace(/[^a-z]+/g,"-");let inFlight=false;
function usage(u){return "total "+n(u?.total)+" · in "+n(u?.input)+" · out "+n(u?.output)+(u?.cacheRead?" · cache "+n(u.cacheRead):"")};function active(s){return ["running","paused"].includes(String(s).toLowerCase())};function terminal(s){return ["completed","failed","aborted"].includes(String(s).toLowerCase())};
function notice(message,error=false){const el=document.querySelector("#notice");el.innerHTML=message?'<div class="notice '+(error?'error':'')+'">'+esc(message)+'</div>':''}
function buttons(r){const stop=active(r.status), del=terminal(r.status);return '<div class="actions"><button class="button" data-action="stop" data-eligible="'+(stop?'yes':'no')+'" data-project="'+esc(r.project)+'" data-run="'+esc(r.runId)+'" '+(stop?'':'disabled title="Only running or paused runs are eligible"')+'>Stop</button><button class="button delete" data-action="delete" data-eligible="'+(del?'yes':'no')+'" data-project="'+esc(r.project)+'" data-run="'+esc(r.runId)+'" '+(del?'':'disabled title="Only completed, failed, or aborted runs can be deleted"')+'>Delete</button></div>'}
function render(data){document.querySelector("#refresh").textContent="Last refresh: "+new Date(data.refreshedAt).toLocaleTimeString()+" · every 2s";const app=document.querySelector("#app");if(!data.projects.length){app.innerHTML='<div class="empty">No readable canonical run files found.</div>';return}app.innerHTML=data.projects.map(p=>'<section class="project"><h2>'+esc(p.name)+' <span class="meta">('+p.runs.length+' runs)</span></h2>'+p.runs.map(r=>'<article class="run"><div class="top"><div><div class="name">'+esc(r.workflowName||r.runId)+'</div><div class="meta"><code>'+esc(r.runId)+'</code></div></div><span class="pill '+cls(r.status)+'">'+esc(r.status)+'</span></div><div class="details"><span>Phase<b>'+esc(r.phase||"—")+'</b></span><span>Started<b>'+fmt(r.startedAt)+'</b></span><span>Updated<b>'+fmt(r.updatedAt)+'</b></span><span>Ended<b>'+fmt(r.endedAt)+'</b></span><span>Tokens<b>'+usage(r.tokenUsage)+'</b></span></div>'+buttons(r)+'<div class="agents">'+(r.agents.length?r.agents.map(a=>'<div class="agent"><div class="agenthead"><b>Agent '+esc(a.id)+(a.label?' · '+esc(a.label):'')+'</b><span class="pill '+cls(a.status)+'">'+esc(a.status)+'</span><span class="meta">'+esc(a.phase||"")+'</span></div><div class="meta">'+fmt(a.startedAt)+' → '+fmt(a.endedAt)+' · '+usage(a.tokenUsage)+'</div>'+(a.prompt?'<div class="prompt">'+esc(a.prompt)+'</div>':'')+'</div>').join(''):'<div class="meta">No agents recorded yet.</div>')+'</div></article>').join('')+'</section>').join('')}
async function load(){if(inFlight)return;try{const r=await fetch("/api/runs",{cache:"no-store"});if(!r.ok)throw Error(r.status);render(await r.json())}catch(e){document.querySelector("#refresh").textContent="Refresh failed: "+e.message}}
async function action(e){const b=e.target.closest("button[data-action]");if(!b||inFlight||b.disabled)return;const type=b.dataset.action,run=b.dataset.run;if(type==="stop"&&!confirm('Stop '+run+'? This monitor cannot safely stop a workflow owned by another Pi process. It will not signal a PID; it will tell you the owning-session command.'))return;if(type==="delete"&&!confirm('Delete terminal run '+run+'? This permanently removes its canonical .json, .json.bak, .log, and eligible dead .lock artifacts. It cannot be undone.'))return;inFlight=true;document.querySelectorAll("button[data-action]").forEach(x=>x.disabled=true);notice("Submitting "+type+" request…");try{const r=await fetch('/api/runs/'+type,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:b.dataset.project,runId:run})});const data=await r.json().catch(()=>({error:'Invalid server response'}));if(!r.ok)throw Error(data.error||('Request failed ('+r.status+')'));notice(data.message||(type+' request completed.')+(data.removed?.length?' Removed: '+data.removed.join(', '):''));await load()}catch(err){notice(err.message,true)}finally{inFlight=false;document.querySelectorAll("button[data-action]").forEach(x=>x.disabled=x.dataset.eligible!=="yes");await load()}}
document.addEventListener('click',action);load();setInterval(load,2000);
</script>`;
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.search) { res.writeHead(404); return res.end("Not found"); }
  if (req.method === "POST" && (url.pathname === "/api/runs/stop" || url.pathname === "/api/runs/delete")) return handleAction(req, res, url.pathname.endsWith("/stop") ? "stop" : "delete");
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405,{Allow:"GET, HEAD, POST"}); return res.end(); }
  if (url.pathname !== "/" && url.pathname !== "/api/runs") { res.writeHead(404); return res.end("Not found"); }
  if (url.pathname === "/api/runs") { const body=JSON.stringify({...snapshot(),refreshedAt:new Date().toISOString()}); res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}); return res.end(req.method === "HEAD" ? "" : body); }
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}); res.end(req.method === "HEAD" ? "" : html);
});
server.listen(PORT, "0.0.0.0", () => console.log(`Pi Workflow Monitor listening on http://0.0.0.0:${PORT}`));
