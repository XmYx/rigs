// YOLO mode (config.yolo): "yolo a p5 sketch of the mesh as orbiting planets", "chart my CPU history, yolo it". JARVIS
// answers about as fast as a text reply: a window opens at once and renders the agent's JS output live while the agent
// is still working. No project, task, worktree, review, commit or merge. One bounded `claude -p` turn (chat.yoloTurn)
// writes into a sandbox folder; this module owns the decision, the settings, the sandbox, the live-reload channel and
// the runtime-error channel. Pure parts are tested in test/yolo.test.js.
//
// ── Contract for the UI (t2) ────────────────────────────────────────────────────────────────────────────────────────
// Decision: a YOLO marker in the text (isYoloRequest: "yolo …", "… yolo it", "in yolo mode") or `yolo: true` on
// POST jarvis/send → route 'yolo'. `yolo: false` on the request beats the text. config.yolo.enabled false ignores the
// marker (a request's yolo: true still runs).
//
// Events — pushed on the UI WebSocket (/ws) of the machine that runs the request AND written into that request's
// jarvis/send NDJSON stream (so a relayed request reaches the UI that sent it). Every event carries `runId`; the same
// event may arrive on both paths, dedupe by (type, runId, step):
//   { type: 'yolo-start',  runId, title, task, node, url, localUrl, at }
//       before the model process starts; `url` = '/api/nodes/<node>/yolo/<runId>/' works from any machine's UI,
//       `localUrl` = '/api/local/yolo/<runId>/' on the machine that runs it. Open a window with an iframe on `url`.
//   { type: 'yolo-update', runId, file, files, step, activity, at }
//       a debounced (YOLO_DEBOUNCE_MS) batch of sandbox writes: `file` the last one, `files` all of them, `step` 1, 2, …
//       `activity` the agent's latest tool step ("Write index.html").
//   { type: 'yolo-done',   runId, ok, summary, step, firstFrameAt, timeToFirstFrameMs, errors, at }
//   { type: 'yolo-kept',   runId, keptAs: { id, node, path, name, icon, port, dir, unit?, at }, at }   (/ws only)
//       the run was kept as an App Cloud app (POST …/keep below); `path` = '/api/nodes/<node>/apps/<id>/'.
// The stream also carries the usual 'route' (route 'yolo'), 'start' (lane 'yolo', runId), 'tool', 'delta', 'done'
// (lane 'yolo', runId; its text is the one spoken line) and 'timing' (lane 'yolo', runId, timeToFirstFrameMs).
//
// Endpoints (all under /api/local/, peers through /api/nodes/<node>/…):
//   GET  yolo                         → { settings, runs: [meta…] } newest first
//   GET  yolo/config · POST yolo/config {enabled, provider, model, effort, maxTurns, timeoutMs, keep} → settings
//   GET  yolo/<runId>                 → 308 to yolo/<runId>/ (relative URLs need the slash)
//   GET  yolo/<runId>/<path>          → the sandbox file ('' or a folder = index.html); path-confined, dot-files never
//                                       served. HTML gets the client script injected. Every response is sent with
//                                       `Content-Security-Policy: sandbox allow-scripts …` (no allow-same-origin: the page
//                                       runs in an opaque origin and can't read the JARVIS API) and
//                                       `Access-Control-Allow-Origin: *` (so its own relative fetches still work).
//                                       The server also refuses every write and WebSocket from that opaque origin
//                                       (Origin: null) but the page's own POST errors (opaqueOriginRefused): it can't
//                                       drive the API blind either.
//   GET  yolo/<runId>/__yolo/client.js  the injected client: reloads the page on 'update', reports errors (below)
//   GET  yolo/<runId>/__yolo/events   → text/event-stream: 'hello' {step, status}, 'update' (as yolo-update), 'done'
//   POST yolo/<runId>/errors {type, message, source, line, col, stack, url} → { ok, seq }   (the page's own reports)
//   GET  yolo/<runId>/errors[?after=<seq>] → { runId, status, total, dropped, errors: [{seq, type, message, …}] }
//   POST yolo/<runId>/stop            → { ok, stopped } aborts the agent; yolo-done follows with ok: false
//   GET  yolo/<runId>/meta            → the run's meta (with `keptAs` once it was kept)
//   POST yolo/<runId>/keep {id?, name?, icon?, description?, tags?}  (src/yolo-keep.js) → { ok, already, keptAs, app,
//                                       health, files, skipped, steps }: the finished run becomes an App Cloud app —
//                                       the sandbox copied to <shared>/apps/<id>/ (no dot-files, symlinks or __yolo/,
//                                       the client never in the stored HTML), a static server.mjs (/healthz) beside it
//                                       that serves the page under the same CSP sandbox as here (KEPT_HEADERS),
//                                       a systemd --user unit on Linux else a launch command, registered with a per-OS
//                                       recipe. A second keep returns the same app (already: true). 409 while the run is
//                                       live, before its first frame, or for a taken id / existing folder (never
//                                       overwritten); 404 unknown run; 403 from Origin: null (only JARVIS may keep).
// The parent window may also post { type: 'yolo-reload' } to the iframe; the client reloads on it. The frame is cross-
// origin to the parent (opaque), so drive it with postMessage or by resetting `src`, never through contentDocument.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RIGS_HOME } from './config.js';
import { PROVIDERS } from './models.js';

export const YOLO_PROVIDERS = ['claude'];
const DEFAULT_YOLO = { enabled: true, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 20, timeoutMs: 180000, keep: 50 };
/** Sandbox writes within this window become one 'yolo-update'. */
export const YOLO_DEBOUNCE_MS = 150;
const MAX_ERRORS = 100; // kept per run (newest)
const MAX_ERROR_REPORTS = 300; // accepted per run; more are counted as dropped
/**
 * Tools a YOLO turn never gets (claude --disallowedTools): nothing on this path files work, plans, proposes, merges or
 * touches git. The prompt says so too; this makes it hold.
 */
export const YOLO_BLOCKED_TOOLS = [
  'mcp__rigs__jarvis_task', 'mcp__rigs__project_create', 'mcp__rigs__project_dispatch', 'mcp__rigs__project_task_update',
  'mcp__rigs__project_resume', 'mcp__rigs__project_stop', 'mcp__rigs__project_feedback', 'mcp__rigs__rigs_propose',
  'mcp__rigs__rigs_dev_start', 'mcp__rigs__rigs_merge_resolved', 'mcp__rigs__tool_promote', 'mcp__rigs__mesh_update',
  'mcp__rigs__mesh_start_agent', 'Bash(git:*)', 'Bash(rigs propose:*)', 'Bash(rigs dev:*)',
];

const bool = (v, d) => (v === true || v === 'true' || v === 'on' || v === 1 || v === '1' ? true : v === false || v === 'false' || v === 'off' || v === 0 || v === '0' ? false : d);
const clampNum = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

/** The sandbox root: RIGS_HOME/yolo, one folder per run. Fixed on purpose (not configurable): paths are confined to it. */
export const yoloRoot = () => path.join(RIGS_HOME, 'yolo');

/** config.yolo, validated: { enabled, provider, model, effort, maxTurns, timeoutMs, keep, root }. Pure. */
export function yoloSettings(y = {}) {
  const d = DEFAULT_YOLO;
  const provider = YOLO_PROVIDERS.includes(y?.provider) ? y.provider : d.provider;
  const efforts = PROVIDERS[provider]?.efforts || [];
  return {
    enabled: bool(y?.enabled, d.enabled),
    provider,
    model: String(y?.model || '').trim() || d.model,
    effort: efforts.includes(y?.effort) ? y.effort : d.effort,
    maxTurns: clampNum(y?.maxTurns, d.maxTurns, 1, 100),
    timeoutMs: clampNum(y?.timeoutMs, d.timeoutMs, 10000, 1800000),
    keep: clampNum(y?.keep, d.keep, 1, 1000),
    root: yoloRoot(),
  };
}

/** A change to config.yolo (POST yolo/config, `rigs yolo on|off`) → the new settings to store. Throws on a bad value. Pure. */
export function applyYoloPatch(current = {}, b = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('expected { enabled, provider, model, effort, maxTurns, timeoutMs, keep }');
  const cur = yoloSettings(current);
  if (b.enabled !== undefined && bool(b.enabled, null) === null) throw new Error('enabled must be true or false');
  if (b.provider !== undefined && !YOLO_PROVIDERS.includes(b.provider)) throw new Error(`provider must be one of ${YOLO_PROVIDERS.join(', ')}`);
  const provider = b.provider ?? cur.provider;
  if (b.effort !== undefined && !PROVIDERS[provider].efforts.includes(b.effort)) throw new Error(`effort must be one of ${PROVIDERS[provider].efforts.join(', ')}`);
  if (b.model !== undefined && !String(b.model).trim()) throw new Error('model must not be empty');
  for (const k of ['maxTurns', 'timeoutMs', 'keep']) if (b[k] !== undefined && !Number.isFinite(Number(b[k]))) throw new Error(`${k} must be a number`);
  if (b.root !== undefined) throw new Error('the sandbox root is fixed (RIGS_HOME/yolo)');
  const { root, ...next } = yoloSettings({ ...cur, ...b });
  return next;
}

/** The per-request override (jarvis/send `yolo`): true | false | undefined (use the text and config). Pure. */
export function yoloOverride(v) {
  if (v === undefined || v === null || v === '') return undefined;
  return bool(v, undefined);
}

// ── Detection ────────────────────────────────────────────────────────────────────────────────────────────────────────
// "yolo …" leading the request, after the polite openers people put in front ("hey jarvis,", "please", "can you").
const LEAD = /^(?:(?:hey|hi|ok|okay|so|alright|right)\b[\s,]*)?(?:(?:jarvis|rigs)\b[\s,:;.-]*)?(?:(?:please|just|let'?s|lets|go|now|ok|okay|quickly|(?:can|could|would|will) you(?: please)?)\b[\s,]*)*yolo\b/i;
// "… yolo it", "just yolo this".
const IT = /\byolo[\s-]+(?:it|this|that|one)\b/i;
// "in yolo mode", "yolo mode: …".
const MODE = /\b(?:in|on|with|via|using)[\s-]+yolo[\s-]*mode\b|^yolo[\s-]*mode\b|\byolo[\s-]*mode\s*[:,—–]/i;
// The YOLO vision model ("yolov8", "yolo v8 detection", "a yolo model"): not the mode.
const VISION = /^[\s-]*(?:v?\d|nas\b|world\b|models?\b|detect|object|weights|segment|pose|ultralytics|darknet|network|architecture|algorithm)/i;
// Talking about the mode itself: switching it, its settings, what it is.
const ABOUT = /\b(?:turn|switch|set|flip)(?:\s+\w+)?\s+(?:on|off)\s+(?:the\s+)?yolo\b|\b(?:turn|switch|set|flip)\s+(?:the\s+)?yolo(?:[\s-]*mode)?\s+(?:on|off)\b|\b(?:enable|disable|toggle|activate|deactivate)\s+(?:the\s+)?yolo\b|\byolo(?:[\s-]*mode)?\s+(?:on|off|status|settings?|config)\s*[.!?]?$|^(?:rigs|jarvis)\s+yolo\s+(?:on|off|status|list)\b/i;
const ABOUT_QUESTION = /^(?:what|why|how|who|when|where|which|is|are|does|do|did|was|were|has|have)\b[^.!:\n]*\byolo\b/i;

/**
 * Does the request carry a YOLO mode marker? The word yolo as a marker — "yolo …" leading it, "… yolo it", "in yolo
 * mode" — not "yellow", "you only live once", the YOLO vision model ("train a yolov8 model"), a question about the mode
 * ("what is yolo mode?") or switching it ("turn on yolo mode"). Pure.
 */
export function isYoloRequest(text) {
  const t = String(text ?? '').trim();
  if (!t || !/\byolo\b/i.test(t) || t.length > 4000) return false;
  if (ABOUT.test(t)) return false;
  const m = t.match(LEAD);
  const lead = !!m && !VISION.test(t.slice(m[0].length));
  const it = IT.test(t);
  const mode = MODE.test(t);
  if (!lead && !it && ABOUT_QUESTION.test(t)) return false;
  if (!(lead || it || mode)) return false;
  return !!yoloTask(t);
}

/** The request without its YOLO marker: "yolo it: chart my CPU history" → "chart my CPU history". Pure. */
export function yoloTask(text) {
  let t = String(text ?? '').trim();
  const m = t.match(LEAD);
  if (m) t = t.slice(m[0].length).replace(/^\s*(?:(?:it|this|that|one)\b(?=\s*(?:[:,.;!—–-]|$)))?/i, '').replace(/^[\s-]*mode\b/i, '');
  t = t.replace(/[\s,;:—–-]*\b(?:just\s+|let'?s\s+)?yolo[\s-]+(?:it|this|that|one)\b[\s!.]*/gi, ' ')
    .replace(/[\s,;:—–-]*\b(?:in|on|with|via|using)[\s-]+yolo[\s-]*mode\b/gi, ' ')
    .replace(/\byolo[\s-]*mode\s*[:,—–]\s*/gi, ' ');
  return t.replace(/\s+/g, ' ').replace(/^[\s:,;.!—–-]+|[\s,;:—–-]+$/g, '').trim();
}

/** A short window title for the run: the task's first words. Pure. */
export function yoloTitle(task) {
  const words = String(task || '').replace(/[`*_#>[\]]/g, '').split(/\s+/).filter(Boolean);
  const t = words.slice(0, 8).join(' ').replace(/[,;:.!?]+$/, '');
  return t ? (t[0].toUpperCase() + t.slice(1) + (words.length > 8 ? '…' : '')).slice(0, 80) : 'YOLO';
}

/**
 * Does this request run as a YOLO run? → { on: true, via: 'request' | 'keyword', reason, task, settings } or
 * { on: false, reason }. A per-request `yolo` beats the text: false never runs it, true always does (even with the mode
 * switched off in config). Without one, a YOLO marker in the text runs it while config.yolo.enabled is on. Pure.
 */
export function resolveYolo({ text = '', override, settings } = {}) {
  const s = yoloSettings(settings);
  const o = yoloOverride(override);
  if (o === false) return { on: false, reason: 'yolo: false on this request' };
  if (o === true) return { on: true, via: 'request', reason: 'yolo: true on this request', task: yoloTask(text) || String(text || '').trim(), settings: s };
  if (!isYoloRequest(text)) return { on: false, reason: 'no YOLO marker' };
  if (!s.enabled) return { on: false, reason: 'config.yolo.enabled is false' };
  return { on: true, via: 'keyword', reason: 'a YOLO marker in the request', task: yoloTask(text), settings: s };
}

// ── The sandbox ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const RUN_ID = /^y-\d{8}-\d{6}-[0-9a-f]{6}$/;
export const isRunId = (id) => RUN_ID.test(String(id || ''));

/** y-YYYYMMDD-HHMMSS-<hex6> (UTC), sortable by time. */
export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `y-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * A URL path inside a run's sandbox → the absolute file, or null when it would leave the sandbox: '..' segments (also
 * percent-encoded), NUL, absolute or drive paths that resolve elsewhere, and dot-files/folders (.yolo, .git, .env)
 * are refused. '' and a trailing slash mean index.html. Lexical only: serveFile also checks the real path. Pure.
 */
export function confinePath(root, rel) {
  let r;
  try { r = decodeURIComponent(String(rel ?? '')); } catch { return null; }
  if (r.includes('\0')) return null;
  r = r.replace(/\\/g, '/');
  if (r === '' || r.endsWith('/')) r += 'index.html';
  r = r.replace(/^\/+/, '');
  const segs = r.split('/');
  if (segs.some((s) => s === '..' || s.startsWith('.'))) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, r);
  return abs.startsWith(base + path.sep) ? abs : null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The page the window shows before the agent's first frame (written BEFORE the model starts). Pure. */
export function placeholderHtml({ title = 'YOLO', task = '' } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="rigs-yolo" content="placeholder"><title>${esc(title)}</title>
<style>
  html,body{margin:0;height:100%;background:#0b1020;color:#cbd5e1;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  body{display:grid;place-items:center}
  .card{max-width:min(520px,88vw);padding:28px 32px;border:1px solid #1e293b;border-radius:16px;background:#0f172a;box-shadow:0 10px 40px #0006}
  h1{margin:0 0 6px;font-size:18px;color:#e2e8f0} p{margin:0;color:#94a3b8} .task{margin-top:12px;color:#7dd3fc;font-size:13px}
  .dots{display:inline-flex;gap:6px;margin-top:18px} .dots i{width:8px;height:8px;border-radius:50%;background:#38bdf8;animation:b 1.2s infinite ease-in-out}
  .dots i:nth-child(2){animation-delay:.15s} .dots i:nth-child(3){animation-delay:.3s}
  @keyframes b{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
  @media (prefers-reduced-motion:reduce){.dots i{animation:none;opacity:.7}}
</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>Working… the first frame appears here in a moment.</p>${task ? `<div class="task">${esc(task.slice(0, 300))}</div>` : ''}<div class="dots"><i></i><i></i><i></i></div></div></body></html>
`;
}

/** Is this the placeholder (the agent hasn't written its own index.html yet)? Pure. */
export const isPlaceholder = (html) => /<meta name="rigs-yolo" content="placeholder">/.test(String(html || ''));

/**
 * Inject the client script into a served HTML page (first thing in <head>, so it sees errors of every later script)
 * and mark relative <script src> tags `crossorigin`: the page runs in an opaque origin, where errors of a script loaded
 * without CORS read only "Script error.". `prefix` = '../' per folder level of the page; `step` = the update the page
 * was served at (the client reloads when it missed one). Pure.
 */
export function injectClient(html, { prefix = '', step = 0 } = {}) {
  const tag = `<script src="${prefix}__yolo/client.js" data-step="${Number(step) || 0}"></script>`;
  const s = String(html ?? '').replace(/<script\b([^>]*)>/gi, (all, attrs) => (
    /\bsrc\s*=/i.test(attrs) && !/\bcrossorigin\b/i.test(attrs) && !/\bsrc\s*=\s*["']?(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(attrs) ? `<script${attrs} crossorigin>` : all));
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /^\s*<!doctype[^>]*>/i]) {
    const m = s.match(re);
    if (m) return s.slice(0, m.index + m[0].length) + tag + s.slice(m.index + m[0].length);
  }
  return tag + s;
}

/** The injected client (served at __yolo/client.js): live reload + error reports. Plain ES2017, no dependencies. */
export const CLIENT_JS = `(function () {
  var me = document.currentScript;
  var base = me.src.replace(/__yolo\\/client\\.js(?:\\?.*)?$/, '');
  var loadedStep = Number(me.getAttribute('data-step')) || 0;
  var sent = 0;
  function str(x) { try { return x instanceof Error ? (x.stack || x.message) : typeof x === 'object' ? JSON.stringify(x) : String(x); } catch (e) { return String(x); } }
  function report(e) {
    if (sent++ > 100) return;
    e.url = location.href; e.at = Date.now();
    try { fetch(base + 'errors', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(e), keepalive: true }).catch(function () {}); } catch (x) {}
  }
  window.addEventListener('error', function (ev) {
    var t = ev.target;
    if (t && t !== window && (t.src || t.href)) { report({ type: 'resource', message: 'failed to load ' + (t.src || t.href), source: t.tagName }); return; }
    report({ type: 'error', message: String(ev.message || (ev.error && ev.error.message) || 'error'), source: ev.filename || '', line: ev.lineno || 0, col: ev.colno || 0, stack: ev.error && ev.error.stack ? String(ev.error.stack) : '' });
  }, true);
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    report({ type: 'rejection', message: r && r.message ? String(r.message) : str(r), stack: r && r.stack ? String(r.stack) : '' });
  });
  var ce = console.error;
  console.error = function () { report({ type: 'console', message: Array.prototype.map.call(arguments, str).join(' ') }); return ce.apply(console, arguments); };
  var timer = null;
  function reload() { clearTimeout(timer); timer = setTimeout(function () { location.reload(); }, 60); }
  window.addEventListener('message', function (ev) { if (ev.data && ev.data.type === 'yolo-reload') reload(); });
  if (window.EventSource) {
    var es = new EventSource(base + '__yolo/events');
    es.addEventListener('hello', function (ev) { try { var h = JSON.parse(ev.data); if (h.step > loadedStep) reload(); if (h.status !== 'running') es.close(); } catch (x) {} });
    es.addEventListener('update', function () { reload(); });
    es.addEventListener('done', function () { es.close(); });
  }
})();
`;

/** The YOLO system-prompt paragraph (after the persona). Pure. */
export function yoloPrompt({ dir = '', base = '', model = '', maxTurns = DEFAULT_YOLO.maxTurns, timeoutMs = DEFAULT_YOLO.timeoutMs } = {}) {
  return [
    '# YOLO mode',
    `This turn is a YOLO run (${model || 'a fast model'}, at most ${maxTurns} tool turns and ${Math.round(timeoutMs / 1000)} s): Sir wants to SEE the result while it is built, about as fast as a text reply. There is no project, task, review, commit or merge — this overrides the filing rules above: do the work yourself, right here.`,
    `Your working folder (the current directory) is this run's sandbox: ${dir}. JARVIS already shows ${dir}/index.html in a live window and reloads it every time a file in the sandbox changes.`,
    '1. First step: write index.html with a visible first frame (a title and something drawn) at once, before any research or polish. Then improve it in small steps; every save is shown live.',
    '2. Plain HTML/CSS/JS files in the sandbox, loaded by relative path (./sketch.js, data.json); external scripts only from well-known CDNs (cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com) — p5, three, d3, chart.js. No build step, no npm install.',
    '3. Data and helpers: run Python (python3) or internal tools (the rigs MCP read tools, the `rigs` CLI, curl to the local RIGS API) through Bash and write their results as JSON or PNG into the sandbox; the page loads them by relative path (fetch("data.json")).',
    `4. After every change, read the page's runtime errors: curl -s ${base}errors  — window errors, unhandled rejections, console.error and failed loads, newest last (add ?after=<seq> for only new ones). Fix what you find; an empty list after the page reloaded means it runs clean.`,
    '5. The page runs sandboxed in an opaque origin: no cookies or localStorage it depends on, no calls to the JARVIS API from the page.',
    '6. Stay in the sandbox: never run git, never edit RIGS source or other projects, never call jarvis_task, project_*, rigs_propose or rigs_dev_start, never start other agents. Read Sir\'s files only when the request needs their data.',
    '7. Finish with ONE short spoken line saying what is on screen now — no "---" written part, no markdown, no paths.',
  ].join('\n');
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** 'event' → every yolo-start / yolo-update / yolo-done (the server pushes them to the UI sockets). */
export const events = new EventEmitter();
events.setMaxListeners(100);
const runs = new Map(); // runId → live state (running runs, plus finished ones until pruned)

const metaFile = (root, id) => path.join(root, `${id}.json`);
const publicMeta = (r) => ({ ...r.meta, files: [...r.meta.files] });

async function writeMeta(r) {
  try { await fsp.writeFile(metaFile(r.root, r.meta.runId), JSON.stringify(r.meta, null, 2)); } catch {}
}

function emitEvent(r, e) {
  const ev = { ...e, runId: r.meta.runId, at: Date.now() };
  for (const fn of r.listeners) { try { fn(ev); } catch {} }
  for (const res of r.sse) sseSend(res, ev.type === 'yolo-update' ? 'update' : 'done', ev);
  events.emit('event', ev);
  return ev;
}

const IGNORED = /(?:^|\/)(?:\.[^/]*|[^/]*~|[^/]*\.(?:swp|swx|tmp|crdownload|part)|4913)$/;

function onChange(r, name) {
  if (r.closed) return;
  const rel = String(name || '').replace(/\\/g, '/');
  if (!rel || IGNORED.test(rel) || rel.split('/').some((s) => s.startsWith('.'))) return;
  if (rel === r.meta.runId) return; // macOS (FSEvents) also reports the run folder's own creation, named after it
  r.pending.add(rel);
  r.lastFile = rel;
  clearTimeout(r.timer);
  r.timer = setTimeout(() => flush(r), YOLO_DEBOUNCE_MS);
}

function flush(r) {
  clearTimeout(r.timer);
  r.timer = null;
  if (!r.pending.size) return null;
  const files = [...r.pending];
  r.pending.clear();
  r.meta.updates += 1;
  r.meta.files = [...new Set([...r.meta.files, ...files])].slice(-200);
  if (!r.meta.firstFrameAt) { r.meta.firstFrameAt = Date.now(); writeMeta(r); }
  return emitEvent(r, { type: 'yolo-update', file: r.lastFile, files, step: r.meta.updates, activity: r.activity || '' });
}

/**
 * Start a run: create RIGS_HOME/yolo/<runId>/, write the placeholder index.html, start watching, and emit 'yolo-start'
 * — all before any model runs. → { runId, dir, meta, startEvent }.
 */
export async function createRun({ text = '', task = '', title = '', node = '', chatId = '', traceId = '', startedAt = Date.now(), keep = DEFAULT_YOLO.keep, root = yoloRoot() } = {}) {
  await fsp.mkdir(root, { recursive: true });
  await prune(root, keep - 1).catch(() => {});
  const runId = newRunId();
  const dir = path.join(root, runId);
  await fsp.mkdir(dir, { recursive: true });
  const t = title || yoloTitle(task || text);
  await fsp.writeFile(path.join(dir, 'index.html'), placeholderHtml({ title: t, task: task || text }));
  const meta = {
    runId, title: t, task: task || text, text, node, chatId, traceId, status: 'running', ok: null, summary: '',
    startedAt, createdAt: Date.now(), firstFrameAt: null, endedAt: null, updates: 0, files: [], errors: 0,
    url: `/api/nodes/${encodeURIComponent(node || 'self')}/yolo/${runId}/`, localUrl: `/api/local/yolo/${runId}/`,
  };
  const r = { root, dir, meta, pending: new Set(), lastFile: '', timer: null, watcher: null, closed: false, abort: null, activity: '',
    errors: [], errSeq: 0, dropped: 0, sse: new Set(), listeners: new Set() };
  runs.set(runId, r);
  try {
    r.watcher = fs.watch(dir, { recursive: true }, (_ev, name) => onChange(r, name));
    r.watcher.on('error', () => {});
  } catch { r.watcher = null; }
  await writeMeta(r);
  const startEvent = emitEvent(r, { type: 'yolo-start', title: t, task: meta.task, node, url: meta.url, localUrl: meta.localUrl });
  return { runId, dir, meta: publicMeta(r), startEvent };
}

/** Listen to one run's events (yolo-update, yolo-done). Returns the unsubscribe function. */
export function onRun(runId, fn) {
  const r = runs.get(runId);
  if (!r) return () => {};
  r.listeners.add(fn);
  return () => r.listeners.delete(fn);
}

/** The agent's latest step ("Write index.html"), carried on the next yolo-update. */
export function setActivity(runId, label) {
  const r = runs.get(runId);
  if (r) r.activity = String(label || '').slice(0, 160);
}

/** Who stops the agent (POST yolo/<runId>/stop): the turn's AbortController. */
export function attachAbort(runId, ac) {
  const r = runs.get(runId);
  if (r) r.abort = ac;
}

/** Stop a running run (POST yolo/<runId>/stop). → { ok, stopped } or null for an unknown run. */
export function stopRun(runId) {
  const r = runs.get(runId);
  if (!r) return null;
  if (r.meta.status !== 'running' || !r.abort) return { ok: true, stopped: false, status: r.meta.status };
  r.stopRequested = true;
  r.abort.abort();
  return { ok: true, stopped: true };
}

/** The run ended: last writes flushed, watcher closed, meta saved, 'yolo-done' emitted. → the done event. */
export async function finishRun(runId, { ok = true, summary = '' } = {}) {
  const r = runs.get(runId);
  if (!r || r.closed) return null;
  // writes made right before the end still count (fs.watch reports them a moment later)
  await new Promise((res) => setTimeout(res, YOLO_DEBOUNCE_MS + 30));
  flush(r);
  r.closed = true;
  try { r.watcher?.close(); } catch {}
  Object.assign(r.meta, { status: r.stopRequested ? 'stopped' : ok ? 'done' : 'failed', ok: !!ok && !r.stopRequested, summary: String(summary || '').slice(0, 500), endedAt: Date.now(), errors: r.errSeq });
  r.abort = null;
  await writeMeta(r);
  const done = emitEvent(r, { type: 'yolo-done', ok: r.meta.ok, summary: r.meta.summary, step: r.meta.updates, firstFrameAt: r.meta.firstFrameAt,
    timeToFirstFrameMs: r.meta.firstFrameAt ? Math.max(0, r.meta.firstFrameAt - r.meta.startedAt) : null, errors: r.errSeq });
  for (const res of r.sse) { try { res.end(); } catch {} }
  r.sse.clear();
  r.listeners.clear();
  return done;
}

/** Is the agent still working on this run (status running in this daemon)? A run left 'running' on disk by a daemon
 * that stopped is not live (listRuns calls it 'interrupted'). */
export const isLive = (runId) => { const r = runs.get(runId); return !!r && !r.closed && r.meta.status === 'running'; };

/**
 * Keep as app (src/yolo-keep.js) finished: store `keptAs` in the run's meta (live and on disk) and emit 'yolo-kept'
 * { runId, keptAs } to the run's listeners and the /ws push. → the event, or null for an unknown run.
 */
export async function markKept(runId, keptAs, root = yoloRoot()) {
  const r = runs.get(runId);
  if (r) { r.meta.keptAs = keptAs; await writeMeta(r); } else {
    const m = await getRun(runId, root);
    if (!m) return null;
    await fsp.writeFile(metaFile(root, runId), JSON.stringify({ ...m, keptAs }, null, 2));
  }
  const ev = { type: 'yolo-kept', runId, keptAs, at: Date.now() };
  for (const fn of r?.listeners || []) { try { fn(ev); } catch {} }
  events.emit('event', ev);
  return ev;
}

/** A run's meta: live, else from disk (a run from before a restart). */
export async function getRun(runId, root = yoloRoot()) {
  if (!isRunId(runId)) return null;
  const r = runs.get(runId);
  if (r) return publicMeta(r);
  try { return JSON.parse(await fsp.readFile(metaFile(root, runId), 'utf8')); } catch { return null; }
}

/** Runs kept on this machine, newest first. A run that was running when the daemon stopped reads as 'interrupted'. */
export async function listRuns({ limit = 50, root = yoloRoot() } = {}) {
  let names = [];
  try { names = (await fsp.readdir(root)).filter((n) => n.endsWith('.json') && isRunId(n.slice(0, -5))); } catch {}
  const out = new Map();
  for (const n of names.sort().reverse().slice(0, limit)) {
    const id = n.slice(0, -5);
    const live = runs.get(id);
    if (live) { out.set(id, publicMeta(live)); continue; }
    try { const m = JSON.parse(await fsp.readFile(path.join(root, n), 'utf8')); out.set(id, m.status === 'running' ? { ...m, status: 'interrupted' } : m); } catch {}
  }
  for (const [id, r] of runs) if (!out.has(id) && r.root === root) out.set(id, publicMeta(r));
  return [...out.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
}

/** Keep the newest `keep` runs: older finished ones (folder + meta) are removed. */
async function prune(root, keep) {
  const ids = (await fsp.readdir(root)).filter(isRunId).sort();
  const old = ids.slice(0, Math.max(0, ids.length - Math.max(0, keep)));
  for (const id of old) {
    if (runs.get(id)?.meta.status === 'running') continue;
    await fsp.rm(path.join(root, id), { recursive: true, force: true });
    await fsp.rm(metaFile(root, id), { force: true });
    runs.delete(id);
  }
}

const ERROR_TYPES = ['error', 'rejection', 'console', 'resource', 'log'];
const cut = (v, n) => String(v ?? '').slice(0, n);

/** A runtime error the page reported (POST errors). → { ok, seq } or { ok: false, dropped } past the cap. */
export function recordError(runId, b = {}) {
  const r = runs.get(runId);
  if (!r) return null;
  if (r.errSeq >= MAX_ERROR_REPORTS) { r.dropped += 1; return { ok: false, dropped: r.dropped }; }
  const e = {
    seq: ++r.errSeq, type: ERROR_TYPES.includes(b?.type) ? b.type : 'error', message: cut(b?.message, 2000) || '(no message)',
    source: cut(b?.source, 300), line: Number(b?.line) || 0, col: Number(b?.col) || 0, stack: cut(b?.stack, 4000), url: cut(b?.url, 300),
    at: Number(b?.at) || Date.now(), step: r.meta.updates,
  };
  r.errors.push(e);
  if (r.errors.length > MAX_ERRORS) r.errors.splice(0, r.errors.length - MAX_ERRORS);
  r.meta.errors = r.errSeq;
  return { ok: true, seq: e.seq };
}

/** The page's runtime errors, newest last (at most `limit`, only seq > after). */
export function readErrors(runId, { after = 0, limit = 20 } = {}) {
  const r = runs.get(runId);
  if (!r) return null;
  const list = r.errors.filter((e) => e.seq > (Number(after) || 0));
  return { runId, status: r.meta.status, step: r.meta.updates, total: r.errSeq, dropped: r.dropped, errors: list.slice(-Math.max(1, Math.min(100, Number(limit) || 20))) };
}

// ── Serving ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Content types by extension, for the sandbox and for a kept app's static server (src/yolo-keep.js). */
export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const TYPES = MIME_TYPES;
/** Headers on every sandbox response: an opaque-origin sandbox that may still load its own files. */
export const SANDBOX_HEADERS = {
  'content-security-policy': 'sandbox allow-scripts allow-modals allow-popups allow-forms allow-pointer-lock allow-downloads',
  'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type',
  'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
};

/**
 * Must the server refuse this request because it comes from an opaque origin (`Origin: null`: a YOLO page under the CSP
 * sandbox, also a file:// page or a sandboxed frame) and could change something? CORS keeps such a page from READING the
 * JARVIS API, but a text/plain POST, a form post or a WebSocket needs no preflight — without this a YOLO page could still
 * drive the API blind (jarvis/send, config, terminals). Refused: every WebSocket and every method but GET/HEAD/OPTIONS.
 * Allowed: the page's own error reports (POST …/yolo/<runId>/errors) and App Cloud paths (their apps decide). Pure.
 */
export function opaqueOriginRefused({ method = 'GET', pathname = '', origin, upgrade = false } = {}) {
  if (String(origin ?? '').trim().toLowerCase() !== 'null') return false;
  if (/^\/api\/nodes\/[^/]+\/apps\//.test(pathname)) return false;
  if (upgrade) return true;
  if (['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase())) return false;
  return !/^\/api\/(?:local|nodes\/[^/]+)\/yolo\/y-\d{8}-\d{6}-[0-9a-f]{6}\/errors$/.test(pathname);
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...SANDBOX_HEADERS, 'content-type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sseSend(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}

function serveEvents(req, res, runId) {
  const r = runs.get(runId);
  res.writeHead(200, { ...SANDBOX_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' });
  res.write('retry: 1500\n\n');
  sseSend(res, 'hello', { runId, step: r?.meta.updates || 0, status: r?.meta.status || 'unknown' });
  if (!r || r.closed) { res.end(); return; }
  r.sse.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  const close = () => { clearInterval(ping); r.sse.delete(res); };
  req.on('close', close);
  res.on('close', close);
}

async function serveFile(res, runId, rest, root) {
  const dir = path.join(root, runId);
  const abs = confinePath(dir, rest);
  if (!abs) return send(res, 403, { error: 'outside the sandbox' });
  let real, realDir;
  try {
    real = await fsp.realpath(abs);
    realDir = await fsp.realpath(dir);
    if (!real.startsWith(realDir + path.sep)) return send(res, 403, { error: 'outside the sandbox' });
    const st = await fsp.stat(real);
    if (st.isDirectory()) return serveFile(res, runId, `${String(rest || '').replace(/\/?$/, '/')}`, root);
    if (!st.isFile()) return send(res, 404, { error: 'not found' });
  } catch { return send(res, 404, { error: `not found: ${String(rest || 'index.html')}` }); }
  const type = TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream';
  if (type.startsWith('text/html')) {
    const rel = path.relative(realDir, real).split(path.sep); // both resolved: a symlinked root (macOS /var → /private/var) adds no levels
    const html = injectClient(await fsp.readFile(real, 'utf8'), { prefix: '../'.repeat(rel.length - 1), step: runs.get(runId)?.meta.updates || 0 });
    return send(res, 200, html, type);
  }
  res.writeHead(200, { ...SANDBOX_HEADERS, 'content-type': type });
  fs.createReadStream(real).on('error', () => res.end()).pipe(res);
  return undefined;
}

/**
 * /api/local/yolo/<runId>[/<rest>] (server.js hands the raw rest of the path). Writes the response itself and returns
 * undefined, or returns a JSON-able value for the caller to send; throws { status } errors for the server to answer.
 */
export async function handle(req, res, runId, rest, { query = new URLSearchParams(), body = async () => ({}), root = yoloRoot() } = {}) {
  const method = req.method || 'GET';
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  if (!isRunId(runId)) throw fail(400, 'not a YOLO run id');
  if (method === 'OPTIONS') { res?.writeHead(204, SANDBOX_HEADERS); res?.end(); return undefined; }
  if (rest === 'meta' && method === 'GET') { const m = await getRun(runId, root); if (!m) throw fail(404, 'no such YOLO run on this machine'); return m; }
  if (rest === 'stop' && method === 'POST') { const s = stopRun(runId); if (!s) throw fail(404, 'no such YOLO run running here'); return s; }
  if (rest === 'errors') {
    if (method === 'POST') {
      const r = recordError(runId, await body().catch(() => ({})));
      if (!r) throw fail(404, 'no such YOLO run running here');
      if (res) { send(res, 200, r); return undefined; }
      return r;
    }
    if (method === 'GET') {
      const e = readErrors(runId, { after: query.get('after'), limit: query.get('limit') });
      if (e) return e;
      if (!(await getRun(runId, root))) throw fail(404, 'no such YOLO run on this machine');
      return { runId, status: 'ended', step: 0, total: 0, dropped: 0, errors: [] }; // a run from before a restart: its reports are gone
    }
  }
  if (method !== 'GET' && method !== 'HEAD') throw fail(405, `${method} is not allowed here`);
  if (!res) throw fail(400, 'stream only');
  if (rest === undefined) { res.writeHead(308, { location: `${runId}/`, 'cache-control': 'no-store' }); res.end(); return undefined; }
  if (rest === '__yolo/client.js') { send(res, 200, CLIENT_JS, 'text/javascript; charset=utf-8'); return undefined; }
  if (rest === '__yolo/events') { serveEvents(req, res, runId); return undefined; }
  if (!runs.has(runId) && !(await getRun(runId, root))) throw fail(404, 'no such YOLO run on this machine');
  await serveFile(res, runId, rest, root);
  return undefined;
}

/** Tests: forget the live runs (their folders stay). */
export function _resetRuns() { for (const r of runs.values()) { try { r.watcher?.close(); } catch {} clearTimeout(r.timer); } runs.clear(); }
