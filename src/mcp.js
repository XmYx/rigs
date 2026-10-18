import readline from 'node:readline';
import { config } from './config.js';

/**
 * `rigs mcp` — a stdio MCP server that gives any coding agent (Claude Code, Codex, …) hands on the
 * whole mesh. It talks to the RIGS daemon on this machine, which routes to the right node.
 */

const base = () => `http://127.0.0.1:${config().port}`;

/** Who is calling, for the screen-control gate and audit log: this agent session, not a person at the UI. */
export function callerHeader(env = process.env, cwd = process.cwd()) {
  const agent = env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT ? 'claude' : env.CODEX_HOME || env.CODEX_SESSION_ID || env.CODEX_THREAD_ID ? 'codex' : 'agent';
  const c = {
    agent, session: env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || env.CODEX_THREAD_ID || '',
    seat: env.OPENRIG_SESSION_NAME || env.OPENRIG_SESSION || '', cwd, pid: process.pid,
  };
  // Header values must be ASCII.
  return JSON.stringify(c).replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
const CALLER = callerHeader();
// The request trace this agent works for (src/trace.js): RIGS puts it in a JARVIS brain's env; it rides on every call.
const TRACE = /^tr-\d{8}-[0-9a-f]{12}(:sp-[0-9a-f]{12})?$/.test(process.env.RIGS_TRACE || '') ? process.env.RIGS_TRACE : '';
const traceOf = (a) => a.trace || TRACE || undefined;

function failure(data, status) {
  const e = new Error((data && data.error) || `HTTP ${status}`);
  if (data?.code) e.code = data.code;
  if (data?.fix) { e.fix = data.fix; e.message += ` (fix: ${data.fix.text || JSON.stringify(data.fix)})`; }
  return e;
}

async function api(path, { method = 'GET', body, timeout = 60000 } = {}) {
  const r = await fetch(base() + path, {
    method, headers: { 'content-type': 'application/json', 'x-rigs-token': config().meshToken, 'x-rigs-caller': CALLER, ...(TRACE ? { 'x-rigs-trace': TRACE } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw failure(data, r.status);
  return data;
}

/** A screenshot: the image bytes plus the headers that say how to map image pixels back to the screen. */
async function apiImage(path, timeout = 60000) {
  const r = await fetch(base() + path, { headers: { 'x-rigs-token': config().meshToken, 'x-rigs-caller': CALLER }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) { const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } throw failure(d, r.status); }
  const h = (k) => r.headers.get(k);
  const meta = { shot: h('x-rigs-shot'), scale: Number(h('x-rigs-scale')) || 1, display: h('x-rigs-display'), width: Number(h('x-rigs-width')) || undefined, height: Number(h('x-rigs-height')) || undefined, region: h('x-rigs-region') ? JSON.parse(h('x-rigs-region')) : undefined };
  return { mime: h('content-type') || 'image/png', data: Buffer.from(await r.arrayBuffer()), meta };
}

const n = (node) => encodeURIComponent(node || 'self');

async function askBrain(node, prompt, brain, model) {
  const chat = await api(`/api/nodes/${n(node)}/chats`, { method: 'POST', body: { brain, model, title: 'mesh_ask: ' + prompt.slice(0, 40) } });
  const r = await fetch(`${base()}/api/nodes/${n(node)}/chats/${chat.id}/send`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rigs-token': config().meshToken },
    body: JSON.stringify({ text: prompt, brain, model }), signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  let text = '';
  let err = '';
  for (const line of (await r.text()).split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'done') text = e.text;
      if (e.type === 'error') err = e.message;
    } catch {}
  }
  return err ? `${text}\n[error: ${err}]` : text;
}

const TOOLS = [
  {
    name: 'mesh_status', description: 'List every machine in the RIGS mesh (Tailscale network): OS, online state, installed agents (Claude Code, Codex, Ollama, OpenRig, REA), CPU/memory.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const nodes = await api('/api/nodes');
      return nodes.map((x) => ({ name: x.name, self: x.self, online: x.online, rigs: x.rigs, platform: x.platform, distro: x.distro, address: x.tailscale?.dnsName || x.tailscale?.ip || x.url, version: x.version, agents: x.tools, tools: x.capabilities, cpu: x.stats?.cpu, memPct: x.stats ? Math.round((x.stats.memUsed / x.stats.memTotal) * 100) : null, gpus: x.gpus }));
    },
  },
  {
    name: 'mesh_workspaces', description: 'The code projects on every machine (git repos, Unity/Godot/Unreal projects, folders with AGENTS.md/CLAUDE.md): name, title from their guide, kinds, nested parts (e.g. the Unity project inside), path. With query (a name as the user said it, fuzzy: "MadMikeUnity") and optional machine ("the linux machine", a node name) it resolves to the best match.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, machine: { type: 'string' }, rescan: { type: 'boolean' } } },
    run: (a) => api(`/api/mesh/workspaces?${new URLSearchParams({ ...(a.query ? { q: a.query } : {}), ...(a.machine ? { machine: a.machine } : {}), ...(a.rescan ? { force: '1' } : {}) })}`, { timeout: 90000 }),
  },
  {
    name: 'mesh_apps', description: 'List the web apps hosted across the mesh (App Cloud): id, name, node, health (up/down/unknown, latency), and the proxy path JARVIS opens them at. Optional node filter.',
    inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'only apps hosted on this machine' } } },
    run: async (a) => {
      const { apps, errors } = await api('/api/apps', { timeout: 30000 });
      const want = a.node && String(a.node).toLowerCase();
      return {
        apps: apps.filter((x) => !want || x.node.toLowerCase() === want).map((x) => ({ id: x.id, name: x.name, node: x.node, status: x.health?.status, latencyMs: x.health?.latencyMs, lastChecked: x.health?.lastChecked ? new Date(x.health.lastChecked).toISOString() : null, path: `/api/nodes/${encodeURIComponent(x.node)}/apps/${x.id}/` })),
        errors: errors.filter((e) => !want || e.node.toLowerCase() === want),
      };
    },
  },
  {
    name: 'mesh_app_register', description: 'Publish a web app running on a machine to the App Cloud so JARVIS can open it in a floating window (served at /api/nodes/<node>/apps/<id>/). Give exactly one of port (+ optional host, default 127.0.0.1) or url. remove:true unregisters. The app should use relative URLs; it is served under a path prefix. launch is how JARVIS starts it when it is down, per OS: systemd (a systemctl --user unit, Linux only) and/or command (any OS), plus optional linux / darwin / windows recipes that replace the top-level one on that OS, e.g. { "systemd": "x.service", "windows": { "command": "x.cmd --port 8080", "cwd": "~\\\\x" } }. A Windows command runs without a POSIX shell (its program is found on PATH, .exe/.cmd/.bat/.ps1); cmd.exe syntax (&&, |, %VAR%) runs through cmd.exe.',
    inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'machine hosting the app; "self" for this one' }, id: { type: 'string', description: 'a-z0-9_- id' }, name: { type: 'string' }, icon: { type: 'string', description: 'one emoji' }, port: { type: 'number' }, host: { type: 'string' }, url: { type: 'string' }, healthPath: { type: 'string' }, launch: { type: 'object', description: '{ systemd: "unit.service" } or { command: "…" }, and/or per-OS { linux | darwin | windows: { command, cwd, env } } (linux may give { systemd })', properties: { systemd: { type: 'string', description: 'systemctl --user unit (Linux only)' }, command: { type: 'string', description: 'command line, any OS (on Linux only without a systemd unit)' }, cwd: { type: 'string', description: 'for command; default ~' }, env: { type: 'object', description: 'for command: NAME: "value"' }, linux: { type: 'object', properties: { systemd: { type: 'string' }, command: { type: 'string' }, cwd: { type: 'string' }, env: { type: 'object' } } }, darwin: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, env: { type: 'object' } } }, windows: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, env: { type: 'object' } } } } }, remove: { type: 'boolean' } }, required: ['node', 'id'] },
    run: async (a) => { const { node, ...app } = a; const r = await api(`/api/nodes/${n(node)}/apps`, { method: 'POST', body: app }); return { apps: r.apps.map((x) => ({ id: x.id, name: x.name, target: x.target })), errors: r.errors }; },
  },
  {
    name: 'appstore_list', description: 'The App Store on a machine: apps that can be installed into the App Cloud (with their Python venv / node deps and model downloads), whether each fits that machine (platform, GPU/VRAM, disk) and its install state: not-installed | external (registered by hand) | installing (step, percent) | installed (version) | failed (error, log tail). Omit node for this machine.',
    inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'machine to look at; "self" (default) for this one' } } },
    run: async (a) => {
      const r = await api(`/api/nodes/${n(a.node)}/appstore`, { timeout: 30000 });
      return {
        node: r.node, platform: r.platform, freeGB: r.freeGB, gpus: r.gpus, errors: r.errors,
        apps: r.apps.map((x) => ({ id: x.id, name: x.name, description: x.description, version: x.version, runtime: x.runtime, downloadGB: x.downloadGB, needs: x.needs, fits: x.fit.ok, why: x.fit.reasons.join('; ') || undefined, install: x.install })),
      };
    },
  },
  {
    name: 'appstore_install', description: 'Install an App Store app on a machine: fetch its source, create its Python venv (uv or venv) and install its dependencies, download its models (Hugging Face or HTTP, resumable), set up its systemd --user unit (Linux) or launch command, register it in the App Cloud and wait until it is healthy. Resumable and idempotent: calling it again after a failure continues where it stopped, and while it runs it returns the running job. Returns the job (steps, percent, log tail). wait:true blocks until it ends (up to waitSec, default 600). dryRun:true only checks and plans. uninstall:true removes it instead (unregistered, unit disabled, files moved to ~/.rigs/trash).',
    inputSchema: { type: 'object', properties: {
      node: { type: 'string', description: 'machine to install on; "self" (default) for this one' }, id: { type: 'string', description: 'app id from appstore_list' },
      wait: { type: 'boolean' }, waitSec: { type: 'number' }, dryRun: { type: 'boolean' }, port: { type: 'number', description: 'listen on another port than the manifest\'s' },
      uninstall: { type: 'boolean' },
    }, required: ['id'] },
    run: async (a) => {
      const base = `/api/nodes/${n(a.node)}/appstore/${encodeURIComponent(a.id)}`;
      if (a.uninstall) return api(`${base}/uninstall`, { method: 'POST', body: {}, timeout: 120000 });
      const brief = (j) => ({ id: j.id, state: j.state, step: j.stepLabel || j.step, percent: j.percent, error: j.error || undefined, steps: j.steps?.map((s) => `${s.status === 'done' ? '✓' : s.status === 'skipped' ? '·' : s.status === 'failed' ? '✗' : s.status === 'running' ? '…' : ' '} ${s.label}${s.detail ? `: ${s.detail}` : ''}`), log: (j.log || []).slice(-25) });
      let job = await api(`${base}/install`, { method: 'POST', body: { dryRun: !!a.dryRun, ...(a.port ? { port: a.port } : {}) }, timeout: 30000 });
      const until = Date.now() + Math.min(3000, a.waitSec || 600) * 1000;
      while (a.wait && job.state === 'running' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2000));
        job = await api(`${base}/job`, { timeout: 30000 });
      }
      return brief(job);
    },
  },
  {
    name: 'mesh_pin_project', description: 'Pin a project folder (it stays on its machine) in JARVIS\'s Top hubs on every UI: shows live sessions inside it and opens a project window to start Claude / a terminal there. remove:true unpins.',
    inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'machine that holds the project; "self" for this one' }, path: { type: 'string' }, name: { type: 'string' }, remove: { type: 'boolean' } }, required: ['node', 'path'] },
    run: async (a) => (await api(`/api/nodes/${n(a.node)}/pins`, { method: 'POST', body: { path: a.path, name: a.name, remove: a.remove } })),
  },
  {
    name: 'mesh_app_start', description: 'Spin up an App Cloud app on its machine (its launch recipe: systemd unit or command) and wait until it is healthy. Opening an app in JARVIS does this automatically.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, id: { type: 'string' } }, required: ['node', 'id'] },
    run: async (a) => { const r = await api(`/api/nodes/${n(a.node)}/app-start/${encodeURIComponent(a.id)}`, { method: 'POST', body: {}, timeout: 90000 }); return { started: r.started, status: r.health?.status, path: `/api/nodes/${encodeURIComponent(a.node)}/apps/${a.id}/` }; },
  },
  {
    name: 'mesh_processes', description: 'List processes on a machine in the mesh (pid, name, CPU %, memory, age, command line). filter matches the name or command line; sort is cpu | mem | age | name | pid.',
    inputSchema: { type: 'object', properties: { machine: { type: 'string' }, filter: { type: 'string' }, sort: { type: 'string' }, limit: { type: 'number' } }, required: ['machine'] },
    run: (a) => api(`/api/nodes/${n(a.machine)}/processes?${new URLSearchParams({ filter: a.filter || '', sort: a.sort || 'cpu', limit: String(a.limit || 40) })}`, { timeout: 30000 }),
  },
  {
    name: 'mesh_kill', description: 'Stop processes on a machine in the mesh — by pid, or by name / command-line match (e.g. "moonlight"). Sends TERM, then KILL to whatever is still running after 3 s (escalate:false to skip). Never touches RIGS itself or system processes.',
    inputSchema: { type: 'object', properties: { machine: { type: 'string' }, pid: { type: 'number' }, name: { type: 'string' }, signal: { type: 'string' }, escalate: { type: 'boolean' } }, required: ['machine'] },
    run: (a) => api(`/api/nodes/${n(a.machine)}/processes/kill`, { method: 'POST', body: { pid: a.pid, name: a.name, signal: a.signal, escalate: a.escalate }, timeout: 60000 }),
  },
  {
    name: 'mesh_exec', description: 'Run a shell command on a machine in the mesh (bash/zsh login shell on mac/linux, PowerShell on Windows). Returns exit code, stdout, stderr.',
    inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'machine name (see mesh_status); "self" for this one' }, command: { type: 'string' }, cwd: { type: 'string' }, timeoutSec: { type: 'number' } }, required: ['node', 'command'] },
    run: (a) => api(`/api/nodes/${n(a.node)}/exec`, { method: 'POST', body: a, timeout: (Math.min(600, a.timeoutSec || 60) + 10) * 1000 }),
  },
  {
    name: 'mesh_list_dir', description: 'List a directory on a mesh machine (~ = home).',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, path: { type: 'string' }, hidden: { type: 'boolean' } }, required: ['node'] },
    run: async (a) => { const r = await api(`/api/nodes/${n(a.node)}/files?path=${encodeURIComponent(a.path || '~')}${a.hidden ? '&hidden=1' : ''}`); return { path: r.path, entries: r.entries.map((e) => `${e.type === 'dir' ? 'd' : '-'} ${String(e.size).padStart(10)} ${e.name}`) }; },
  },
  {
    name: 'mesh_read_file', description: 'Read a text file from a mesh machine (up to 2 MB).',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, path: { type: 'string' } }, required: ['node', 'path'] },
    run: (a) => api(`/api/nodes/${n(a.node)}/files/read?path=${encodeURIComponent(a.path)}`),
  },
  {
    name: 'mesh_write_file', description: 'Write a text file on a mesh machine (creates parent dirs).',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, path: { type: 'string' }, text: { type: 'string' } }, required: ['node', 'path', 'text'] },
    run: (a) => api(`/api/nodes/${n(a.node)}/files/text`, { method: 'POST', body: { path: a.path, text: a.text } }),
  },
  {
    name: 'mesh_sessions', description: 'List coding and chat sessions across the mesh (Claude Code, Codex, OpenRig seats, tmux, RIGS terminals and JARVIS chats). Omit node for every machine.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, liveOnly: { type: 'boolean' } } },
    run: async (a) => {
      const snap = a.node ? [{ node: { name: a.node }, sessions: await api(`/api/nodes/${n(a.node)}/sessions`) }] : await api('/api/mesh/snapshot', { timeout: 30000 });
      return snap.map((s) => ({ node: s.node.name, sessions: (s.sessions || []).filter((x) => !a.liveOnly || x.live).slice(0, 30).map((x) => ({ kind: x.kind, id: x.id, agent: x.agent, title: x.title, cwd: x.cwd, live: x.live, updated: x.updatedAt ? new Date(x.updatedAt).toISOString() : null })) }));
    },
  },
  {
    name: 'mesh_session_transcript', description: 'Read the transcript of a session on a machine (kind from mesh_sessions: claude|codex|tmux|rig|pty|chat).',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, kind: { type: 'string' }, id: { type: 'string' }, last: { type: 'number', description: 'only the last N messages (default 40)' } }, required: ['node', 'kind', 'id'] },
    run: async (a) => (await api(`/api/nodes/${n(a.node)}/sessions/transcript?kind=${encodeURIComponent(a.kind)}&id=${encodeURIComponent(a.id)}`)).slice(-(a.last || 40)),
  },
  {
    name: 'mesh_send', description: 'Type a message into a LIVE session on a machine (tmux / OpenRig seat via `rig send` / RIGS terminal). Use it to hand work to another agent.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, kind: { type: 'string' }, id: { type: 'string' }, text: { type: 'string' } }, required: ['node', 'kind', 'id', 'text'] },
    run: (a) => api(`/api/nodes/${n(a.node)}/sessions/send`, { method: 'POST', body: a }),
  },
  {
    name: 'mesh_start_agent', description: 'Start a new coding agent on a machine (claude | codex | ollama | rig) in a tmux session (or a terminal on Windows), optionally with an initial task prompt. The user can attach to it from any machine.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, agent: { type: 'string', enum: ['claude', 'codex', 'ollama', 'rig'] }, cwd: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, name: { type: 'string' } }, required: ['node', 'agent'] },
    run: (a) => api(`/api/nodes/${n(a.node)}/agents/start`, { method: 'POST', body: a }),
  },
  {
    name: 'mesh_ask', description: "Ask another machine's brain (claude | codex | ollama) a question and wait for the answer — e.g. delegate to the Ubuntu box's local Ollama model.",
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, prompt: { type: 'string' }, brain: { type: 'string' }, model: { type: 'string' } }, required: ['node', 'prompt'] },
    run: (a) => askBrain(a.node, a.prompt, a.brain, a.model),
  },
  {
    name: 'project_task_update', description: 'Report progress on a RIGS project task you were assigned: status done | blocked | failed (or running), with a summary of what you did / where the result is / what you need. Your task brief names the owner machine, project id and task id. A "blocked" report is answered automatically with the safe default (Sir pre-approved non-destructive work) and the task keeps running; "failed" is retried with a stronger model.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, project: { type: 'string' }, task: { type: 'string' }, status: { type: 'string', enum: ['running', 'done', 'blocked', 'failed'] }, summary: { type: 'string' } }, required: ['owner', 'project', 'task', 'status'] },
    run: async (a) => {
      const p = await api(`/api/nodes/${n(a.owner)}/projects/${encodeURIComponent(a.project)}/tasks/${encodeURIComponent(a.task)}`, { method: 'POST', body: { status: a.status, summary: a.summary || '' }, timeout: 120000 });
      return { ok: true, project: p.status, next: p.tasks.filter((t) => t.status === 'running').map((t) => `${t.id} on ${t.assign?.node}`) };
    },
  },
  {
    name: 'jarvis_task', description: "File one of Sir's instructions as work and cast an agent for it right away. project: an existing project id (see project_list / the list in your prompt), \"rigs\" for RIGS · JARVIS itself and anything on the go (the default), or give newProject {name, goal, repoNode?, repoPath?, gitUrl?} to start a new one. instruction: Sir's full request plus any context the agent needs. RIGS routes it to the best machine + model + effort and starts it (an OpenRig seat when available); it shows on the Work dashboard. Returns where it runs.",
    inputSchema: { type: 'object', properties: {
      title: { type: 'string', description: 'short task title' },
      instruction: { type: 'string', description: "Sir's request in full, plus context" },
      project: { type: 'string', description: 'existing project id; "rigs" = RIGS · JARVIS (default)' },
      newProject: { type: 'object', description: '{ name, goal, repoNode?, repoPath?, gitUrl? } to create a project for this', properties: { name: { type: 'string' }, goal: { type: 'string' }, repoNode: { type: 'string' }, repoPath: { type: 'string' }, gitUrl: { type: 'string' } } },
      kind: { type: 'string', description: 'code | research | docs | text | review | test | architecture | media | reverse-engineer' },
      size: { type: 'string', enum: ['S', 'M', 'L'], description: 'S/M simpler work, L elaborate (picks a stronger model)' },
      trace: { type: 'string', description: 'request trace to file it under ("tr-…" or "tr-…:sp-…", from your brief); default: the one you run in' },
    }, required: ['title', 'instruction'] },
    run: async (a) => {
      const r = await api('/api/nodes/self/projects/intake', { method: 'POST', body: { ...a, trace: traceOf(a) }, timeout: 10 * 60 * 1000 });
      const t = r.task || {};
      return {
        project: `${r.project?.name} (${r.project?.id}, on ${r.project?.owner})`, task: `${t.id} ${t.title}`, started: !!r.started,
        runs: t.assign ? `${t.assign.provider} ${t.assign.model || ''} ${t.assign.effort || ''} on ${t.assign.node}`.replace(/\s+/g, ' ').trim() : null,
        via: t.run ? (t.run.mode === 'openrig' ? `OpenRig seat ${t.run.seat} (rig ${t.run.rig})` : `${t.run.session?.kind} ${t.run.session?.id}`) : null,
        why: r.why || t.reason || '', error: t.status === 'failed' ? t.summary : undefined,
      };
    },
  },
  {
    name: 'usage_report', description: 'The usage ledger across the mesh: which model spent how much time and how many tokens on which JARVIS chat turns, planning calls and project tasks, with each run\'s status and outcome. Returns totals, groupings (model, project, task, node, day, provider, kind) and the newest records. since/until take ms, an ISO date or a relative "24h" / "7d".',
    inputSchema: { type: 'object', properties: {
      since: { type: 'string', description: 'start of the range, e.g. "7d" (default), "24h", "2026-10-01"' }, until: { type: 'string' },
      groupBy: { type: 'string', description: 'comma-separated: model, project, task, node, day, provider, kind (default model,project,task,node,day)' },
      node: { type: 'string', description: 'one machine only; omit for the whole mesh' }, project: { type: 'string', description: 'project id filter' },
      kind: { type: 'string', enum: ['chat-turn', 'task', 'plan', 'review', 'merge'] }, limit: { type: 'number', description: 'records to return (default 50)' },
    } },
    run: async (a) => {
      const qs = new URLSearchParams({ since: a.since || '7d', ...(a.until ? { until: a.until } : {}), ...(a.groupBy ? { groupBy: a.groupBy } : {}), ...(a.project ? { project: a.project } : {}), ...(a.kind ? { kind: a.kind } : {}), limit: String(a.limit ?? 50) });
      return api(a.node ? `/api/nodes/${n(a.node)}/usage?${qs}` : `/api/usage?${qs}`, { timeout: 60000 });
    },
  },
  {
    name: 'preroute_stats', description: 'Time saved by pre-routing (JARVIS deciding answer / implement / plan / continue with a fast router — LocalJev or Claude — before any brain sees a request, and filing bound work itself). Per route class (answer, work): median latency with pre-routing off (the baseline) and on, the router\'s own cost, saved per request and in total; estimated: true when there are no requests with pre-routing off yet and the baseline is estimated (baselineSource says from what). Savings can be negative. since takes ms, an ISO date or "24h" / "30d" (default 30d).',
    inputSchema: { type: 'object', properties: { since: { type: 'string' }, until: { type: 'string' }, node: { type: 'string', description: 'one machine only; omit for the whole mesh' } } },
    run: (a) => {
      const qs = new URLSearchParams({ since: a.since || '30d', ...(a.until ? { until: a.until } : {}) });
      return api(a.node ? `/api/nodes/${n(a.node)}/preroute/stats?${qs}` : `/api/preroute/stats?${qs}`, { timeout: 60000 });
    },
  },
  {
    name: 'trace_list', description: 'Request traces across the mesh: one per request Sir made (JARVIS intake), newest first, with its route, status, duration, models, tokens, tool calls and the projects/tasks it handed off. Filters: since (ms, ISO date or "24h" / "7d"; default 7d), route (answer | implement | plan | continue), status (running | ok | error | stopped), q (text in the request), node (one machine only).',
    inputSchema: { type: 'object', properties: {
      since: { type: 'string' }, until: { type: 'string' }, route: { type: 'string', enum: ['answer', 'implement', 'plan', 'continue'] },
      status: { type: 'string', enum: ['running', 'ok', 'error', 'stopped'] }, q: { type: 'string' }, node: { type: 'string' }, limit: { type: 'number', description: 'default 30' },
    } },
    run: (a) => {
      const qs = new URLSearchParams({ since: a.since || '7d', limit: String(a.limit ?? 30), ...Object.fromEntries(['until', 'route', 'status', 'q'].filter((k) => a[k]).map((k) => [k, a[k]])) });
      return api(a.node ? `/api/nodes/${n(a.node)}/traces?${qs}` : `/api/traces?${qs}`, { timeout: 60000 });
    },
  },
  {
    name: 'trace_get', description: 'One request trace in full: its span tree (intake → router decision → brain turns → tool calls → handoffs, and later the tasks they started on any machine) with each span\'s input, output, timings, model, tokens and status. flat:true returns the spans as a list instead of a tree.',
    inputSchema: { type: 'object', properties: { traceId: { type: 'string' }, flat: { type: 'boolean' } }, required: ['traceId'] },
    run: async (a) => {
      const t = await api(`/api/traces/${encodeURIComponent(a.traceId)}`, { timeout: 60000 });
      return a.flat ? { traceId: t.traceId, summary: t.summary, spans: t.spans, errors: t.errors } : { traceId: t.traceId, summary: t.summary, tree: t.tree, errors: t.errors };
    },
  },
  {
    name: 'project_list', description: 'List RIGS projects on every machine with their tasks, routing (machine/provider/model/effort) and status.',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('/api/mesh/projects', { timeout: 30000 }),
  },
  {
    name: 'project_get', description: 'Full detail of one project: tasks, deps, assignment reasons, run handles, log.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, project: { type: 'string' } }, required: ['owner', 'project'] },
    run: (a) => api(`/api/nodes/${n(a.owner)}/projects/${encodeURIComponent(a.project)}`),
  },
  {
    name: 'project_create', description: 'Create a RIGS project from a goal on this machine. With plan=true the core brain breaks it into tasks and RIGS routes each to the best machine + provider + model + effort; with dispatch=true the ready tasks start right away (OpenRig seats or direct agents).',
    inputSchema: { type: 'object', properties: { goal: { type: 'string' }, name: { type: 'string' }, repoNode: { type: 'string' }, repoPath: { type: 'string' }, gitUrl: { type: 'string' }, plan: { type: 'boolean' }, dispatch: { type: 'boolean' }, trace: { type: 'string', description: 'request trace ("tr-…[:sp-…]"); default: the one you run in' } }, required: ['goal'] },
    run: async (a) => {
      let p = await api('/api/nodes/self/projects', { method: 'POST', body: { ...a, trace: traceOf(a) } });
      if (a.plan !== false) p = await api(`/api/nodes/self/projects/${p.id}/plan`, { method: 'POST', body: {}, timeout: 16 * 60 * 1000 });
      if (a.dispatch) p = await api(`/api/nodes/self/projects/${p.id}/dispatch`, { method: 'POST', body: {}, timeout: 20 * 60 * 1000 });
      return { id: p.id, owner: p.owner, status: p.status, tasks: p.tasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind, deps: t.deps, assign: t.assign, reason: t.reason, status: t.status })) };
    },
  },
  {
    name: 'project_dispatch', description: 'Start every task of a planned project whose dependencies are done.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, project: { type: 'string' }, trace: { type: 'string', description: 'request trace ("tr-…[:sp-…]"); default: the one you run in, else the project\'s' } }, required: ['owner', 'project'] },
    run: (a) => api(`/api/nodes/${n(a.owner)}/projects/${encodeURIComponent(a.project)}/dispatch`, { method: 'POST', body: traceOf(a) ? { trace: traceOf(a) } : {}, timeout: 20 * 60 * 1000 }),
  },
  {
    name: 'project_stop', description: "Pause a project NOW because Sir said stop / pause / hold / \"consider it done\" / \"leave it for now\": its running agents are stopped (uncommitted edits stay in the tree) and nothing of it is dispatched, nudged or revived until project_resume. Sir's word overrides \"don't interrupt a working agent\" — never wait for a task to finish first.",
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, project: { type: 'string' }, reason: { type: 'string', description: "Sir's words" } }, required: ['owner', 'project'] },
    run: async (a) => {
      const p = await api(`/api/nodes/${n(a.owner)}/projects/${encodeURIComponent(a.project)}/stop`, { method: 'POST', body: { reason: a.reason || '', by: 'JARVIS for Sir' }, timeout: 10 * 60 * 1000 });
      return { ok: true, project: p.id, status: p.status, tasks: p.tasks.map((t) => `${t.id} ${t.status}`) };
    },
  },
  {
    name: 'project_resume', description: 'Resume a paused project (only when Sir asks): it goes back to running and its ready tasks start.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, project: { type: 'string' } }, required: ['owner', 'project'] },
    run: (a) => api(`/api/nodes/${n(a.owner)}/projects/${encodeURIComponent(a.project)}/resume`, { method: 'POST', body: {}, timeout: 20 * 60 * 1000 }),
  },
  {
    name: 'project_feedback', description: "Store Sir's answer to a finished project's \"How did it work out, sir?\" on that project (the report names owner and project). Use his words; one call per answer.",
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, project: { type: 'string' }, text: { type: 'string', description: "Sir's answer, verbatim or closely summarized" } }, required: ['owner', 'project', 'text'] },
    run: async (a) => { const p = await api(`/api/nodes/${n(a.owner)}/projects/${encodeURIComponent(a.project)}/feedback`, { method: 'POST', body: { text: a.text, by: 'Sir' }, timeout: 30000 }); return { ok: true, project: p.id, feedback: (p.feedback || []).length }; },
  },
  {
    name: 'rigs_dev_start', description: 'Start a change to RIGS (or the repo checked out at `repo`): creates a git worktree on branch work/<this machine>/<topic> from the latest origin/main and returns its path. Work and commit ONLY there — never on main or in the installed checkout.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, repo: { type: 'string' } }, required: ['topic'] },
    run: (a) => api('/api/local/dev/start', { method: 'POST', body: a, timeout: 120000 }),
  },
  {
    name: 'rigs_propose', description: 'Hand a committed work branch to the merge steward. It merges onto the latest main one request at a time, runs build + tests, pushes and rolls out automatically; it only brings in a resolver agent if there is a real conflict. Failing checks come back to you.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string', description: 'the worktree path from rigs_dev_start' }, title: { type: 'string' }, summary: { type: 'string' } }, required: ['dir'] },
    run: (a) => api('/api/local/dev/propose', { method: 'POST', body: a, timeout: 60000 }),
  },
  {
    name: 'rigs_merge_status', description: 'The merge steward and its queue: each proposed branch with status (queued, merging, checking, merged, conflict, checks-failed) and log.',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('/api/mesh/merge', { timeout: 20000 }),
  },
  {
    name: 'rigs_merge_resolved', description: 'Resolver only: call after resolving every conflict in the steward worktree and `git add`-ing the files (do not commit): it commits the merge, then the steward re-checks and pushes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (a) => {
      const m = await api('/api/mesh/merge', { timeout: 20000 });
      const nodes = await api('/api/nodes');
      const st = nodes.find((x) => x.name === m.steward);
      return api(`/api/nodes/${n(st?.id || 'self')}/merge/${encodeURIComponent(a.id)}/resolved`, { method: 'POST', body: {}, timeout: 60000 });
    },
  },
  {
    name: 'mesh_update', description: 'Roll out the latest RIGS code from GitHub to every machine (git pull + restart). Call after pushing a change to the rigs repo.',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('/api/mesh/update', { method: 'POST', body: {}, timeout: 20 * 60 * 1000 }),
  },
  {
    name: 'mesh_screen', description: 'Screenshot of a machine\'s screen (returned as an image). Only works when Sir has switched screen access on for that machine; every call is announced and logged. The result says `shot` and `scale` (screen pixels per image pixel): pass `shot` to mesh_control so x/y given in this image land on the right spot. maxWidth defaults to 1568.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, display: { type: 'string' }, window: { type: 'string', description: 'window id from mesh_windows' }, region: { type: 'string', description: 'x,y,width,height in screen pixels' }, maxWidth: { type: 'number' }, format: { type: 'string', enum: ['png', 'jpeg'] } }, required: ['node'] },
    run: async (a) => {
      const q = new URLSearchParams({ maxWidth: String(a.maxWidth || 1568) });
      for (const k of ['display', 'window', 'region', 'format']) if (a[k]) q.set(k, a[k]);
      const { mime, data, meta } = await apiImage(`/api/nodes/${n(a.node)}/control/screenshot?${q}`);
      return { content: [{ type: 'image', data: data.toString('base64'), mimeType: mime.split(';')[0] }, { type: 'text', text: JSON.stringify(meta) }] };
    },
  },
  {
    name: 'mesh_windows', description: 'List the windows on a machine (id, title, app, bounds, focused). Needs screen access on for that machine.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' } }, required: ['node'] },
    run: (a) => api(`/api/nodes/${n(a.node)}/control/windows`),
  },
  {
    name: 'mesh_control', description: 'Drive a machine\'s screen: move/click/double/right/scroll/drag the pointer, type text, press a key combo, or focus a window. Needs input control switched on for that machine by Sir; this tool can never switch it on. One agent holds the screen at a time. Coordinates are in the pixels of the screenshot you took (pass its `shot`). Ask Sir before using it unless the task says you may. Pass secret:true for anything credential-like.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, action: { type: 'string', enum: ['move', 'click', 'double', 'right', 'scroll', 'drag', 'type', 'key', 'focus'] }, x: { type: 'number' }, y: { type: 'number' }, shot: { type: 'string', description: 'the shot id from mesh_screen' }, display: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' }, to: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } }, text: { type: 'string' }, secret: { type: 'boolean' }, combo: { type: 'string', description: 'e.g. ctrl+shift+t, mod+c, enter' }, id: { type: 'string', description: 'window id (focus)' } }, required: ['node', 'action'] },
    run: (a) => {
      const { node, action, ...rest } = a;
      const base_ = `/api/nodes/${n(node)}/control`;
      if (action === 'type') return api(`${base_}/type`, { method: 'POST', body: { text: rest.text, secret: rest.secret } });
      if (action === 'key') return api(`${base_}/key`, { method: 'POST', body: { combo: rest.combo } });
      if (action === 'focus') return api(`${base_}/focus`, { method: 'POST', body: { id: rest.id } });
      const kind = { move: { action: 'move' }, click: { action: 'click' }, double: { action: 'click', count: 2 }, right: { action: 'click', button: 'right' }, scroll: { action: 'scroll' }, drag: { action: 'drag' } }[action];
      if (!kind) throw new Error(`unknown action ${action}`);
      const { text, secret, combo, id, ...point } = rest;
      if (/^\d+$/.test(point.display ?? '')) point.display = Number(point.display);
      return api(`${base_}/pointer`, { method: 'POST', body: { ...point, ...kind } });
    },
  },
  {
    name: 'mesh_access', description: 'What this agent may do on a machine\'s desktop: screen access/control switches, killed state, and the permissions behind them (screen capture, input, accessibility) with a fix hint for each missing one. grant:"<permission>" (input, screenCapture, accessibility, automation, fullDiskAccess) starts that grant step on the machine (opens the macOS Settings pane, or queues the Linux uinput root step); a person still has to confirm it there. It cannot turn screen access or control on.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, grant: { type: 'string' } }, required: ['node'] },
    run: async (a) => {
      const granted = a.grant ? await api(`/api/nodes/${n(a.node)}/control/grant`, { method: 'POST', body: { permission: a.grant } }) : undefined;
      const s = await api(`/api/nodes/${n(a.node)}/control?force=${a.grant ? 1 : 0}`);
      return { enabled: s.enabled, input: s.input, killed: s.killed, ready: s.ready, session: s.session, backend: s.backend, permissions: s.permissions, ...(granted ? { grant: granted } : {}) };
    },
  },
  {
    name: 'mesh_notify', description: 'Show (and speak) a message in every open JARVIS UI across the mesh — use it to report finished work. Keep it to one or two spoken sentences; put any longer description after a line containing only "---" (shown, never spoken). When no UI is open anywhere, it is spoken aloud on this machine\'s speakers instead; aloud: true always speaks it here too.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, speak: { type: 'boolean' }, aloud: { type: 'boolean', description: 'Also speak through this machine\'s speakers' } }, required: ['text'] },
    run: (a) => api('/api/mesh/notify', { method: 'POST', body: { ...a, from: `${config().name} agent` } }),
  },
];

export function startMcp() {
  const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    const reply = (result) => id !== undefined && out({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && out({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize') {
        reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rigs', version: '0.1.0' }, instructions: 'RIGS mesh: control every machine on the Tailscale network. Start with mesh_status.' });
      } else if (method === 'tools/list') {
        reply({ tools: TOOLS.map(({ run, ...t }) => t) });
      } else if (method === 'tools/call') {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return fail(-32602, 'unknown tool ' + params?.name);
        try {
          const result = await tool.run(params.arguments || {});
          reply(Array.isArray(result?.content) ? result : { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] });
        } catch (e) {
          const hint = /ECONNREFUSED|fetch failed/.test(String(e.cause?.code || e.message)) ? ' (is the RIGS daemon running? `rigs start`)' : '';
          reply({ content: [{ type: 'text', text: `error: ${e.message}${hint}` }], isError: true });
        }
      } else if (method === 'ping') {
        reply({});
      } else if (method?.startsWith('notifications/')) {
        // no response for notifications
      } else {
        fail(-32601, 'method not found: ' + method);
      }
    } catch (e) {
      fail(-32603, e.message);
    }
  });
}
