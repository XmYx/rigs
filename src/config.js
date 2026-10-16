import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, readJsonSync, shortHost } from './util.js';

export const RIGS_HOME = process.env.RIGS_HOME ? path.resolve(process.env.RIGS_HOME) : path.join(HOME, '.rigs');
export const CONFIG_FILE = path.join(RIGS_HOME, 'config.json');
export const DEFAULT_PORT = 4719;

function defaults() {
  return {
    nodeId: crypto.randomUUID(),
    name: shortHost(),
    port: DEFAULT_PORT,
    // 'auto' = loopback + this machine's Tailscale IPs. Use ["0.0.0.0"] only on trusted networks.
    bind: 'auto',
    // Shared secret for peers that are NOT on Tailscale (LAN / containers). Tailnet peers are
    // authenticated by Tailscale identity instead, so this never needs to leave the machine.
    meshToken: crypto.randomBytes(24).toString('base64url'),
    // Extra peers to probe besides Tailscale devices, e.g. "http://192.168.1.20:4719".
    peers: [],
    // Tailscale logins allowed to use this node. Empty = only the login that owns this node.
    allowedUsers: [],
    allowTaggedDevices: true,
    files: { showHidden: false },
    brain: {
      default: 'auto',
      ollamaUrl: 'http://127.0.0.1:11434',
      ollamaModel: '',
      claudeModel: '',
      codexModel: '',
      // Permission posture for chat-driven agents. Interactive terminal sessions keep their own prompts.
      claudePermissionMode: 'default',
      claudeAllowedTools: ['mcp__rigs', 'mcp__rea', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      codexSandbox: 'read-only',
    },
    persona: { name: 'J.A.R.V.I.S.', address: 'sir', humor: 60, voice: '' },
    update: { auto: true, intervalMin: 10, remote: 'origin', branch: 'main' },
    ssh: { autoAuthorize: true, manageConfig: true, authorizeStaticPeers: false },
    openrig: { registerPeers: true },
    desktop: { sunshineUser: 'rigs', sunshinePass: crypto.randomBytes(12).toString('base64url') },
  };
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null ? merge(base[k], v) : v;
  }
  return out;
}

let current = null;

export function loadConfig() {
  const stored = readJsonSync(CONFIG_FILE, null);
  const cfg = merge(defaults(), stored || {});
  // Environment overrides (handy for tests, containers and a second instance on one machine).
  if (process.env.RIGS_PORT) cfg.port = Number(process.env.RIGS_PORT);
  if (process.env.RIGS_NAME) cfg.name = process.env.RIGS_NAME;
  if (process.env.RIGS_MESH_TOKEN) cfg.meshToken = process.env.RIGS_MESH_TOKEN;
  if (process.env.RIGS_PEERS) cfg.peers = process.env.RIGS_PEERS.split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.RIGS_BIND) cfg.bind = process.env.RIGS_BIND.split(',').map((s) => s.trim());
  if (process.env.RIGS_OLLAMA_URL) cfg.brain.ollamaUrl = process.env.RIGS_OLLAMA_URL;
  if (!stored) saveConfig(cfg);
  current = cfg;
  return cfg;
}

export function config() {
  return current || loadConfig();
}

export function saveConfig(cfg = current) {
  fs.mkdirSync(RIGS_HOME, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  current = cfg;
}

/** Shallow-safe patch used by the settings API; never lets the UI change identity or secrets. */
export function patchConfig(patch) {
  const cfg = config();
  const blocked = new Set(['nodeId', 'meshToken', 'desktop']);
  for (const k of Object.keys(patch || {})) if (blocked.has(k)) delete patch[k];
  const next = merge(cfg, patch);
  saveConfig(next);
  return next;
}

/** Config without secrets, safe to send to peers and the UI. */
export function publicConfig() {
  const c = config();
  return {
    name: c.name, port: c.port, peers: c.peers, allowedUsers: c.allowedUsers, brain: c.brain,
    persona: c.persona, update: c.update, ssh: c.ssh, openrig: c.openrig, files: c.files,
  };
}
