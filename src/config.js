import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, readJsonSync, shortHost } from './util.js';
import { applyGlobal, globalSettings, isNewer, nextRev, revOf, touchesGlobal } from './globalbrain.js';

export const RIGS_HOME = process.env.RIGS_HOME ? path.resolve(process.env.RIGS_HOME) : path.join(HOME, '.rigs');
export const CONFIG_FILE = path.join(RIGS_HOME, 'config.json');
export const DEFAULT_PORT = 4719;
const RULES_VERSION = 4;

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
      // The "core brain": JARVIS's voice and the project planner. provider: auto | claude | codex | ollama.
      core: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      // JARVIS's conversational brain (casual chat, replies to the user); substantial work is delegated.
      chat: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
      ollamaUrl: 'http://127.0.0.1:11434',
      // "Claude via Ollama" brain: the Claude Code harness on a local Ollama model. model '' = pick a tool-capable one;
      // url '' = ollamaUrl. Applies to the claude child process only, never to Claude's own settings.
      claudeOllama: { model: '', url: '' },
      // JARVIS works in your home: brains run with cwd = workRoot and may read/write there
      // (Claude: auto mode + edit/bash tools; Codex: workspace-write sandbox rooted at workRoot).
      // Interactive terminal sessions keep their own prompts.
      workRoot: '~',
      claudePermissionMode: 'auto',
      claudeAllowedTools: ['mcp__rigs', 'mcp__rea', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebSearch', 'WebFetch'],
      codexSandbox: 'workspace-write',
    },
    // How agents RIGS starts (terminal agents, project tasks, OpenRig seats) handle permissions. "auto" = work
    // unattended: Claude's auto mode (a classifier approves safe actions), Codex in its workspace-write sandbox
    // with network, asking only to escalate. Anything that still asks shows up as "needs you" (blinking planet).
    // commitOtherProjects: 'ask' = agents leave changes uncommitted in projects other than RIGS and list them for Sir.
    // Task agents never commit, push or switch branches outside a RIGS dev worktree (src/autonomy.js guardBrief), so
    // 'branch' no longer lets them commit there. RIGS itself always goes through the merge steward.
    agents: { claudePermissionMode: 'auto', codexSandbox: 'workspace-write', codexApproval: 'on-request', codexNetwork: true, rigPolicy: 'builtin:auto', commitOtherProjects: 'ask' },
    // The completion loop (src/autonomy.js): a task that fails, stalls (no progress for stallMinutes) or goes silent is
    // retried with a fresh brief, one rung up the ladder each time, up to maxAttempts attempts per task (a project can
    // override it with its own `autonomy`); questions agents ask are answered with the safe default after
    // answerAfterSec, at most maxSelfAnswers times per attempt; Sir gets one report when the loop ends.
    // ladder: [] = the built-in Sonnet medium → Opus high → Opus xhigh. Providers in routing.avoid are skipped.
    autonomy: { enabled: true, maxAttempts: 3, ladder: [], stallMinutes: 60, answerAfterSec: 90, maxSelfAnswers: 3, retryDelaySec: 60 },
    // voice: server TTS voice (macOS/Windows voice name, or a piper .onnx path on Linux).
    // speakAloud: 'auto' = speak notifications on this machine's speakers when no UI is open; 'never'.
    persona: { name: 'J.A.R.V.I.S.', address: 'sir', humor: 60, voice: '', speakAloud: 'auto' },
    // Pre-routing (src/router.js): each JARVIS request is classified (answer · implement · plan · continue) before any brain
    // sees it, and work bound to a folder is filed by RIGS itself. preroute: false = no router; the brain decides and files
    // work itself (jarvis_task / project_create). engine: 'jev' = a Jev-compatible typed-decision API (LocalJev,
    // POST /v1/systemone, about half a second) | 'claude' = claudeModel through `claude -p` | 'rules' = keywords only. When
    // the engine can't answer (down, timed out, below jev.minProb), `fallback` decides ('claude' | 'rules'). jev.url '' =
    // the App Cloud app jev.appId registered on this machine. baselineMs: the time-saved baseline per route class while no
    // request has run with pre-routing off yet (0 = estimated from history, see src/preroute-stats.js).
    router: {
      preroute: true, engine: 'jev', fallback: 'claude', claudeModel: 'claude-haiku-5-5',
      jev: { url: '', appId: 'localjev', model: 'jev-latest', apiKey: '', timeoutMs: 8000, minProb: 0.55 },
      baselineMs: { answer: 0, work: 0 },
    },
    // Quick-task fast path (src/quick.js): a request routed "answer" (a question, a web search, a quick tool use, a summary,
    // a short report) runs as one bounded turn on a cheaper model instead of the full brain — simple asks on `simple`,
    // web research / multi-step tool use / reports on `standard` — with at most maxTurns tool turns, handed to the full
    // brain when it asks for it, fails or runs past timeoutMs. enabled: false (or jarvis/send quick: false) = as before.
    quick: {
      enabled: true,
      simple: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
      standard: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      maxTurns: 8, timeoutMs: 90000,
    },
    // Request traces (src/trace.js): one span tree per request in traces/<day>.jsonl. days = retention; maxField = the cap
    // (characters) on each span's input / output / meta before it is cut and marked; enabled: false records nothing.
    traces: { enabled: true, days: 14, maxField: 8000 },
    // Exhibits (src/exhibits.js, experimental): illustrated documents of each request / project, built from the traces.
    // images: 'auto' (SVG, ComfyUI pictures when this machine's ComfyUI answers) | 'svg' | 'comfyui' | 'off'.
    exhibits: { enabled: false, images: 'auto', maxPerDoc: 60, maxDocs: 200 },
    // Experimental: StarNet space-station view (src/starnet.js) in place of the galaxy. ref '' = the pinned commit,
    // dir '' = RIGS_HOME/starnet/<ref> (filled by `rigs starnet install`).
    experimental: { starnet: { enabled: false, ref: '', dir: '' } },
    // Tools this machine offers to the mesh (ComfyUI is auto-detected): { "<id>": { label, kinds, url, command, notes } }.
    capabilities: {},
    // Web apps this machine shares with the mesh (App Cloud), see src/apps.js: [{ id, name, icon, port | url, healthPath, launch, rewrite }].
    apps: [],
    // App Store (src/appstore.js): where installed apps live ('' = ~/.rigs/apps) and the GPU Overseer's
    // clients.json that GPU apps join ('' = ~/apps/gpu-overseer/clients.json, skipped when absent).
    appstore: { appsDir: '', gpuOverseerClients: '' },
    // Projects pinned in JARVIS's Top hubs: [{ name, path }]. They stay on this machine; every UI sees them.
    pinnedProjects: [],
    // Extra model ids per provider, appended to the built-in catalog (src/models.js).
    models: { claude: [], codex: [] },
    // How the planner assigns each task kind to a provider/model/effort. First match wins;
    // the machine is then picked by availability, load, GPU/platform needs and spread.
    routing: {
      // Bumped whenever the default rules change; stored rules follow unless you customized them.
      rulesVersion: RULES_VERSION,
      customized: false,
      rules: [
        { kind: 'plan', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        { kind: 'architecture', provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
        { kind: 'code', size: 'L', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        { kind: 'code', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
        { kind: 'test', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' },
        { kind: 'review', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', crossCheck: true },
        { kind: 'review', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        { kind: 'merge', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        { kind: 'reverse-engineer', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        { kind: 'research', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
        { kind: 'media', tool: 'comfyui', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
        // Large docs (a wiki, a guide written from code) need code reading and long prose: Sonnet. Small docs stay on Haiku.
        { kind: 'docs', size: 'L', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
        { kind: 'docs', provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
        { kind: 'text', provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
        { kind: 'private', provider: 'ollama', model: '', effort: 'off' },
        { kind: '*', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      ],
      // 'auto' = OpenRig when the target machine runs it (Claude Code / Codex seats), else start agents directly.
      dispatch: 'auto',
      // What the planning brain may override: 'machine' (default), 'all' (provider + model too) or 'none'.
      plannerPicks: 'machine',
      maxTasksPerMachine: 4,
      // Providers switched off for now, e.g. ["codex"]: the planner never suggests them and RIGS never places a task there.
      avoid: [],
    },
    update: { auto: true, intervalMin: 10, remote: 'origin', branch: 'main' },
    // Hold a sleep inhibitor while RIGS runs so this node stays on the mesh 24/7 (src/keepawake.js).
    keepAwake: true,
    ssh: { autoAuthorize: true, manageConfig: true, authorizeStaticPeers: false },
    // hubs: a persistent rig per pinned project (lead seat + on-demand workers, idle workers stopped after
    // idleMinutes) and JARVIS's own "jarvis" rig with an overseer seat on the core-brain machine (src/hubs.js).
    openrig: { registerPeers: true, hubs: { enabled: true, jarvis: true, idleMinutes: 20, lead: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, overseer: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } } },
    // Change policy: work branches merged by one steward. steward: '' = auto (first machine that can push).
    merge: { steward: '' },
    desktop: { sunshineUser: 'rigs', sunshinePass: crypto.randomBytes(12).toString('base64url') },
    // Full access (enabled: screenshots + window list) and full control (input: pointer, keys, focus) of this
    // machine's screen, see docs/full-access.md and src/control.js. On by default; the kill switch or a person
    // switches it off per machine, and only control.enable() from a human surface switches it back on, never the
    // settings patch. backend: 'auto' or a forced one (mutter, portal, …).
    control: {
      enabled: true, input: true, backend: 'auto', allowFrom: [], leaseIdleSec: 60,
      maxActionsPerMin: 120, maxShotsPerMin: 30, maxStreamFramesPerMin: 600, announce: 'lease', killHotkey: 'default', auditPreview: 64,
    },
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
  const base = defaults();
  const cfg = merge(base, stored || {});
  if (!cfg.routing.customized && stored?.routing?.rulesVersion !== RULES_VERSION) {
    cfg.routing.rules = base.routing.rules;
    cfg.routing.rulesVersion = RULES_VERSION;
  }
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
  // comfyui, linear and connectors (Slack, Google Drive) hold secrets and have their own validated endpoints
  // (/api/local/comfyui/config, linear/config, /api/local/connectors/google-drive/config).
  const blocked = new Set(['nodeId', 'meshToken', 'desktop', 'comfyui', 'linear', 'connectors', 'control']);
  for (const k of Object.keys(patch || {})) if (blocked.has(k)) delete patch[k];
  // publicConfig masks the LocalJev key; a settings form saving that mask back must not overwrite the real one.
  if (patch?.router?.jev?.apiKey === '••••') delete patch.router.jev.apiKey;
  const next = merge(cfg, patch);
  if (touchesGlobal(patch)) next.globalRev = nextRev(cfg, next.name);
  saveConfig(next);
  if (touchesGlobal(patch)) emitGlobal();
  return next;
}

// ── Global JARVIS settings (src/globalbrain.js): one brain configuration for the whole mesh ────────────────────────
const globalListeners = new Set();
/** Called with { rev, by, settings } whenever this machine changes a global setting (the server pushes it to peers). */
export function onGlobalChange(fn) { globalListeners.add(fn); return () => globalListeners.delete(fn); }
function emitGlobal() { const g = currentGlobal(); for (const fn of globalListeners) { try { fn(g); } catch { /* a listener never breaks a save */ } } }

/** This machine's global settings and their revision. */
export function currentGlobal() {
  const c = config();
  return { ...revOf(c), settings: globalSettings(c) };
}

/** A setting saved without patchConfig (e.g. the router endpoint) that is global: stamp it and tell the peers. */
export function markGlobalChanged() {
  const c = config();
  c.globalRev = nextRev(c, c.name);
  saveConfig(c);
  emitGlobal();
}

/** Adopt a peer's global settings when they are newer than ours. Returns true when adopted (never re-broadcasts). */
export function adoptGlobal(g) {
  const c = config();
  if (!g?.settings || !isNewer(g, revOf(c))) return false;
  applyGlobal(c, g.settings);
  c.globalRev = { rev: Number(g.rev) || 0, by: String(g.by || '') };
  saveConfig(c);
  return true;
}

/** Config without secrets, safe to send to peers and the UI. */
export function publicConfig() {
  const c = config();
  return {
    name: c.name, port: c.port, peers: c.peers, allowedUsers: c.allowedUsers, brain: c.brain,
    persona: c.persona, update: c.update, ssh: c.ssh, openrig: c.openrig, files: c.files,
    models: c.models, routing: c.routing, capabilities: c.capabilities, apps: c.apps, pinnedProjects: c.pinnedProjects, traces: c.traces, quick: c.quick, experimental: c.experimental,
    router: { ...c.router, jev: { ...c.router?.jev, apiKey: c.router?.jev?.apiKey ? '••••' : '' } },
    control: { ...c.control },
  };
}
