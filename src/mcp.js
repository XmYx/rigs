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
      return nodes.map((x) => ({ name: x.name, self: x.self, online: x.online, rigs: x.rigs, platform: x.platform, distro: x.distro, address: x.tailscale?.dnsName || x.tailscale?.ip || x.url, version: x.version, agents: x.tools, cpu: x.stats?.cpu, memPct: x.stats ? Math.round((x.stats.memUsed / x.stats.memTotal) * 100) : null, gpus: x.gpus }));
    },
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
    name: 'mesh_update', description: 'Roll out the latest RIGS code from GitHub to every machine (git pull + restart). Call after pushing a change to the rigs repo.',
    inputSchema: { type: 'object', properties: {} },
    run: () => api('/api/mesh/update', { method: 'POST', body: {}, timeout: 20 * 60 * 1000 }),
  },
  {
    name: 'mesh_notify', description: 'Show (and speak) a message in every open JARVIS UI across the mesh — use it to report finished work.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, speak: { type: 'boolean' } }, required: ['text'] },
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
