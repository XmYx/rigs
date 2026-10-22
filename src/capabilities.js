import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import { HOME, isMac, isWin, run, which } from './util.js';

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

/** Files matching a glob of the form <dir>/<prefix>*<suffix>/<rest> (one wildcard segment), newest version name first. */
function globDir(dir, pattern, rest) {
  const [pre, suf] = pattern.split('*');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(pre) && n.endsWith(suf)); } catch { return []; }
  return names.sort().reverse().map((n) => path.join(dir, n, ...rest));
}

/**
 * Where Blender may be installed, in the order they are tried (the same list the blender-glb seed tool uses):
 * BLENDER env, macOS app bundles, Linux PATH / /usr/bin / /opt/blender* / ~/Downloads/blender-*, Windows Program Files.
 */
export function blenderCandidates({ env = process.env.BLENDER, home = HOME, mac = isMac, win = isWin } = {}) {
  const out = env ? [env] : [];
  if (mac) out.push('/Applications/Blender.app/Contents/MacOS/Blender', path.join(home, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'));
  else if (win) out.push(...globDir('C:\\Program Files\\Blender Foundation', 'Blender*', ['blender.exe']));
  else {
    const onPath = which('blender');
    if (onPath) out.push(onPath);
    out.push('/usr/bin/blender', ...globDir('/opt', 'blender*', ['blender']), ...globDir(path.join(home, 'Downloads'), 'blender-*', ['blender']));
  }
  return [...new Set(out)];
}

/** The first Blender executable that exists, or null. */
export function findBlender(opts) {
  for (const c of blenderCandidates(opts)) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}

const blenderVersions = new Map(); // executable → "4.4.3" (a version never changes under the same path while we run)
/** `blender --version` → "4.4.3" (cached per executable; '' when it does not answer within 20 s). Never opens the GUI. */
export async function blenderVersion(cmd) {
  if (blenderVersions.has(cmd)) return blenderVersions.get(cmd);
  const r = await run(cmd, ['--version'], { timeout: 20000 });
  const v = (r.stdout.match(/Blender\s+(\d+\.\d+(?:\.\d+)?)/) || [])[1] || '';
  if (v) blenderVersions.set(cmd, v);
  return v;
}

const DETECTORS = {
  blender: {
    label: 'Blender', kinds: ['3d'],
    notes: 'Headless 3D: build with the blender-glb tool (bpy script → .glb + turntable PNG). For photoreal props from a prompt use the props-studio app on the machine that has it (TRELLIS.2).',
    async detect() {
      const cmd = findBlender();
      if (!cmd) return null;
      const version = await blenderVersion(cmd);
      return { label: version ? `Blender ${version}` : 'Blender', version, command: cmd };
    },
  },
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
