import readline from 'node:readline';
import { config } from './config.js';

/**
 * `rigs mcp` — a stdio MCP server that gives any coding agent (Claude Code, Codex, …) hands on the
 * whole mesh. It talks to the RIGS daemon on this machine, which routes to the right node.
 */

const base = () => `http://127.0.0.1:${config().port}`;

async function api(path, { method = 'GET', body, timeout = 60000 } = {}) {
  const r = await fetch(base() + path, {
    method, headers: { 'content-type': 'application/json', 'x-rigs-token': config().meshToken },
    body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
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
    name: 'mesh_app_register', description: 'Publish a web app running on a machine to the App Cloud so JARVIS can open it in a floating window (served at /api/nodes/<node>/apps/<id>/). Give exactly one of port (+ optional host, default 127.0.0.1) or url. remove:true unregisters. The app should use relative URLs; it is served under a path prefix.',
    inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'machine hosting the app; "self" for this one' }, id: { type: 'string', description: 'a-z0-9_- id' }, name: { type: 'string' }, icon: { type: 'string', description: 'one emoji' }, port: { type: 'number' }, host: { type: 'string' }, url: { type: 'string' }, healthPath: { type: 'string' }, launch: { type: 'object', description: '{ systemd: "unit.service" } or { command: "…" }' }, remove: { type: 'boolean' } }, required: ['node', 'id'] },
    run: async (a) => { const { node, ...app } = a; const r = await api(`/api/nodes/${n(node)}/apps`, { method: 'POST', body: app }); return { apps: r.apps.map((x) => ({ id: x.id, name: x.name, target: x.target })), errors: r.errors }; },
  },
  {
    name: 'mesh_app_start', description: 'Spin up an App Cloud app on its machine (its launch recipe: systemd unit or command) and wait until it is healthy. Opening an app in JARVIS does this automatically.',
    inputSchema: { type: 'object', properties: { node: { type: 'string' }, id: { type: 'string' } }, required: ['node', 'id'] },
    run: async (a) => { const r = await api(`/api/nodes/${n(a.node)}/app-start/${encodeURIComponent(a.id)}`, { method: 'POST', body: {}, timeout: 90000 }); return { started: r.started, status: r.health?.status, path: `/api/nodes/${encodeURIComponent(a.node)}/apps/${a.id}/` }; },
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
    name: 'project_task_update', description: 'Report progress on a RIGS project task you were assigned: status done | blocked | failed (or running), with a summary of what you did / where the result is / what you need. Your task brief names the owner machine, project id and task id.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, project: { type: 'string' }, task: { type: 'string' }, status: { type: 'string', enum: ['running', 'done', 'blocked', 'failed'] }, summary: { type: 'string' } }, required: ['owner', 'project', 'task', 'status'] },
    run: async (a) => {
      const p = await api(`/api/nodes/${n(a.owner)}/projects/${encodeURIComponent(a.project)}/tasks/${encodeURIComponent(a.task)}`, { method: 'POST', body: { status: a.status, summary: a.summary || '' }, timeout: 120000 });
      return { ok: true, project: p.status, next: p.tasks.filter((t) => t.status === 'running').map((t) => `${t.id} on ${t.assign?.node}`) };
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
    inputSchema: { type: 'object', properties: { goal: { type: 'string' }, name: { type: 'string' }, repoNode: { type: 'string' }, repoPath: { type: 'string' }, gitUrl: { type: 'string' }, plan: { type: 'boolean' }, dispatch: { type: 'boolean' } }, required: ['goal'] },
    run: async (a) => {
      let p = await api('/api/nodes/self/projects', { method: 'POST', body: a });
      if (a.plan !== false) p = await api(`/api/nodes/self/projects/${p.id}/plan`, { method: 'POST', body: {}, timeout: 16 * 60 * 1000 });
      if (a.dispatch) p = await api(`/api/nodes/self/projects/${p.id}/dispatch`, { method: 'POST', body: {}, timeout: 20 * 60 * 1000 });
      return { id: p.id, owner: p.owner, status: p.status, tasks: p.tasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind, deps: t.deps, assign: t.assign, reason: t.reason, status: t.status })) };
    },
  },
  {
    name: 'project_dispatch', description: 'Start every task of a planned project whose dependencies are done.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, project: { type: 'string' } }, required: ['owner', 'project'] },
    run: (a) => api(`/api/nodes/${n(a.owner)}/projects/${encodeURIComponent(a.project)}/dispatch`, { method: 'POST', body: {}, timeout: 20 * 60 * 1000 }),
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
    name: 'rigs_merge_resolved', description: 'Resolver only: call after committing the conflict resolution in the steward worktree; the steward re-checks and pushes.',
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
          reply({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] });
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
