import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import { HOME, isMac, isWin, which } from './util.js';

/**
 * Tools a machine offers beyond coding agents (ComfyUI, …). Two sources:
 *  - built-in detectors below (add one per tool as you introduce them to the mesh)
 *  - declarations in ~/.rigs/config.json → "capabilities": { "<id>": { label, kinds, url, command, notes } },
 *    editable from the UI (⚙ Mesh control → Tools).
 * The planner routes tasks that need a tool (needs.tool) to a machine that has it, and the task
 * brief tells the agent how to reach it.
 */

function portOpen(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function unityEditors() {
  const roots = isWin ? ['C:\\Program Files\\Unity\\Hub\\Editor'] : isMac ? ['/Applications/Unity/Hub/Editor', path.join(HOME, 'Applications', 'Unity', 'Hub', 'Editor')] : [path.join(HOME, 'Unity', 'Hub', 'Editor'), '/opt/unity/Hub/Editor'];
  const out = [];
  for (const r of roots) { try { for (const v of fs.readdirSync(r)) if (/^\d/.test(v)) out.push({ version: v, path: path.join(r, v) }); } catch {} }
  return out;
}

const DETECTORS = {
  unity: {
    label: 'Unity', kinds: ['code'],
    notes: 'Unity editor for game projects on this machine. Follow the project\'s own AGENTS.md for its editor loop; the live editor can be driven by one agent at a time (Unity MCP for Unity on :8080 when the editor runs with the bridge).',
    async detect() {
      const editors = unityEditors();
      if (!editors.length) return null;
      const mcp = await portOpen(8080);
      return { label: `Unity ${editors.map((e) => e.version).join(', ')}`, versions: editors.map((e) => e.version), url: mcp ? 'http://127.0.0.1:8080/mcp' : '', running: mcp };
    },
  },
  comfyui: {
    label: 'ComfyUI', kinds: ['media'],
    notes: 'Open-source image/video/audio generation. Drive it with the `comfy` CLI (see the comfy skill) or its HTTP API.',
    async detect() {
      const [up, cli] = await Promise.all([portOpen(8188), Promise.resolve(which('comfy'))]);
      if (!up && !cli) return null;
      return { url: up ? 'http://127.0.0.1:8188' : '', command: cli || '', running: up };
    },
  },
};

let cache = { at: 0, value: null };

export async function capabilities(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 60000) return cache.value;
  const out = {};
  await Promise.all(Object.entries(DETECTORS).map(async ([id, d]) => {
    const found = await d.detect().catch(() => null);
    if (found) out[id] = { id, label: d.label, kinds: d.kinds, notes: d.notes, detected: true, ...found };
  }));
  for (const [id, c] of Object.entries(config().capabilities || {})) {
    if (c?.disabled) { delete out[id]; continue; }
    out[id] = { id, label: c.label || id, kinds: c.kinds || [], notes: c.notes || '', url: c.url || out[id]?.url || '', command: c.command || out[id]?.command || '', declared: true, ...(out[id] ? { detected: true, running: out[id].running } : {}) };
  }
  cache = { at: Date.now(), value: out };
  return out;
}

export function knownTools() {
  return Object.entries(DETECTORS).map(([id, d]) => ({ id, label: d.label, kinds: d.kinds, notes: d.notes }));
}
