import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitViolation } from './autonomy.js';
import { config, RIGS_HOME } from './config.js';
import { redact } from './trace.js';
import { APP_DIR, augmentedPath, isWin, run, truncate, which, writeJsonAtomic } from './util.js';

/**
 * Tool registry: small scripts an agent wrote for one task, kept so later tasks run them instead of writing them
 * again. (src/tools.js is something else: it finds CLI binaries such as claude, rig and git.)
 *
 * One tool per folder, RIGS_HOME/tools/<id>/:
 *   manifest.json  { id, name, description, tags: [], language: node|python|bash|sh|powershell, entry: "main.py",
 *                    inputs: <JSON schema of the arguments, type object>, outputs: "what it prints" | <JSON schema>,
 *                    platforms: [linux, darwin, windows], safety: "read-only" | "mutating", version: "1.0.0",
 *                    timeoutSec?: 60, origin: { project, task, session, node, trace }, created, updated, uses, lastUsed,
 *                    smoke?: { args: <a safe call, e.g. { dryRun: true }>, expect?: <subset the result must contain> } }
 *   <entry> and any other script files it needs (plain relative names, no "..").
 *
 * Seeds: tools/<id>/ in the RIGS checkout (APP_DIR/tools, same layout) ship with every update, so every machine has
 * them. roots() lists RIGS_HOME/tools first (filed tools, and an override of a seed with the same id), then the seeds.
 * A seed folder is never written to (the checkout must stay clean for the updater): its usage counts live in
 * RIGS_HOME/tools/.usage.json. `smokeTool` runs a tool's `smoke` call; `rigs tools smoke` runs them all.
 *
 * Running: the entry runs with its interpreter in `cwd` (default the tool folder). The arguments are checked against
 * `inputs` and arrive as JSON on stdin and in RIGS_TOOL_ARGS; stdout is the result (parsed when it is JSON). Rules:
 *   - a "mutating" tool runs only with allowMutating: true (refusal code "mutating");
 *   - the git guard (src/autonomy.js): source or arguments that run a git step forbidden in that cwd are refused
 *     (code "git-guard"): no commit/push/branch switch outside a RIGS dev worktree, no push/switch inside one;
 *   - a timeout (timeoutSec from the call, else the manifest, else 60; at most 600) kills it (timedOut: true);
 *   - stdout and stderr are redacted (trace.redact) and capped before they leave the machine.
 * Each run bumps `uses` and `lastUsed` in the manifest.
 *
 * Search (`searchCatalog`, pure) ranks tools and App Cloud applets (kind "applet") together, so one tool_list finds
 * both. The mesh catalog is GET /api/tools (server.js merges every node's GET /api/local/tools plus /api/apps).
 */

export const LANGUAGES = Object.freeze(['node', 'python', 'bash', 'sh', 'powershell']);
export const PLATFORMS = Object.freeze(['linux', 'darwin', 'windows']);
export const SAFETY = Object.freeze(['read-only', 'mutating']);
export const MAX_TIMEOUT_SEC = 600;
export const DEFAULT_TIMEOUT_SEC = 60;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const FILE_RE = /^[\w][\w.-]{0,79}(?:\/[\w][\w.-]{0,79}){0,3}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 20;
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const DEFAULT_PLATFORMS = { node: PLATFORMS, python: PLATFORMS, bash: ['linux', 'darwin'], sh: ['linux', 'darwin'], powershell: ['windows'] };

/**
 * Where tools live on this machine; the first root wins when two hold the same id, and new tools go there. The seed
 * root is the checkout's tools/ folder (RIGS_SEED_TOOLS overrides it; empty switches seeds off, as tests do).
 */
export function roots() {
  const seeds = process.env.RIGS_SEED_TOOLS ?? path.join(APP_DIR, 'tools');
  return [path.join(RIGS_HOME, 'tools'), ...(seeds ? [path.resolve(seeds)] : [])].filter((r, i, all) => all.indexOf(r) === i);
}

export class ToolError extends Error { constructor(status, code, msg) { super(msg); this.name = 'ToolError'; this.status = status; this.code = code; } }

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const platformOf = (p = process.platform) => (p === 'win32' ? 'windows' : p);

/** A file name inside a tool folder: relative, forward slashes, no "..", no hidden parts. */
export const safeFile = (f) => typeof f === 'string' && FILE_RE.test(f) && !f.split('/').some((p) => p === '..' || p.startsWith('.'));

/** Check a JSON schema just enough to use it for argument checks; problems go onto `errors` under `where`. */
function checkSchema(s, where, errors, depth = 0) {
  if (!plainObject(s)) { errors.push(`${where} must be a JSON schema object`); return; }
  if (depth > 8) { errors.push(`${where} nests too deep`); return; }
  for (const t of s.type === undefined ? [] : [].concat(s.type)) if (!SCHEMA_TYPES.includes(t)) errors.push(`${where}.type "${t}" is not a JSON schema type`);
  if (s.properties !== undefined) {
    if (!plainObject(s.properties)) errors.push(`${where}.properties must be an object`);
    else for (const [k, v] of Object.entries(s.properties)) checkSchema(v, `${where}.properties.${k}`, errors, depth + 1);
  }
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((r) => typeof r === 'string'))) errors.push(`${where}.required must be an array of property names`);
  if (s.items !== undefined) checkSchema(s.items, `${where}.items`, errors, depth + 1);
  if (s.enum !== undefined && !Array.isArray(s.enum)) errors.push(`${where}.enum must be an array`);
}

const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

/**
 * Validate a tool manifest. Returns { manifest, errors }; manifest is null when errors is non-empty, otherwise the
 * normalized manifest (lower-case id and tags, default platforms/version/inputs, numeric uses). Pure; `now` fills
 * created/updated when they are missing.
 */
export function validateManifest(raw, { now = Date.now() } = {}) {
  if (!plainObject(raw)) return { manifest: null, errors: ['manifest must be an object'] };
  const errors = [];
  const id = str(raw.id).toLowerCase();
  if (!ID_RE.test(id)) errors.push('id must be 1-40 chars of a-z, 0-9, - or _, starting with a letter or digit');
  const name = str(raw.name);
  if (!name) errors.push('name is required');
  else if (name.length > 80) errors.push('name must be at most 80 characters');
  const description = str(raw.description);
  if (description.length < 10) errors.push('description is required: say what the tool does and when to use it (10+ characters)');
  else if (description.length > 2000) errors.push('description must be at most 2000 characters');
  let tags = [];
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === 'string' && /^[\w.+-]{1,32}$/.test(t.trim()))) errors.push('tags must be an array of short words (a-z, 0-9, . + - _)');
    else tags = [...new Set(raw.tags.map((t) => t.trim().toLowerCase()))].slice(0, 20);
  }
  const language = str(raw.language).toLowerCase();
  if (!LANGUAGES.includes(language)) errors.push(`language must be one of ${LANGUAGES.join(', ')}`);
  const entry = str(raw.entry);
  if (!safeFile(entry)) errors.push('entry must be a relative file name inside the tool folder (e.g. "main.py")');
  let inputs = { type: 'object', properties: {} };
  if (raw.inputs !== undefined) {
    const before = errors.length;
    checkSchema(raw.inputs, 'inputs', errors);
    if (errors.length === before && raw.inputs.type !== undefined && raw.inputs.type !== 'object') errors.push('inputs must describe an object (type "object"): tools take named JSON arguments');
    inputs = { type: 'object', properties: {}, ...raw.inputs };
  }
  let outputs = '';
  if (raw.outputs !== undefined) {
    if (typeof raw.outputs === 'string') outputs = raw.outputs.trim();
    else { checkSchema(raw.outputs, 'outputs', errors); outputs = raw.outputs; }
  }
  let platforms = DEFAULT_PLATFORMS[language] || PLATFORMS;
  if (raw.platforms !== undefined) {
    if (!Array.isArray(raw.platforms) || !raw.platforms.length || !raw.platforms.every((p) => PLATFORMS.includes(p))) errors.push(`platforms must be a non-empty list of ${PLATFORMS.join(', ')}`);
    else platforms = [...new Set(raw.platforms)];
  }
  const safety = str(raw.safety);
  if (!SAFETY.includes(safety)) errors.push('safety must be "read-only" or "mutating" (anything that writes files, changes state or calls out to change something is mutating)');
  const version = raw.version === undefined ? '1.0.0' : str(raw.version);
  if (!VERSION_RE.test(version)) errors.push('version must look like 1.2.3');
  let timeoutSec;
  if (raw.timeoutSec !== undefined) {
    timeoutSec = Number(raw.timeoutSec);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > MAX_TIMEOUT_SEC) errors.push(`timeoutSec must be a number of seconds, 1-${MAX_TIMEOUT_SEC}`);
  }
  let smoke;
  if (raw.smoke !== undefined) {
    if (!plainObject(raw.smoke) || !plainObject(raw.smoke.args) || (raw.smoke.expect !== undefined && !plainObject(raw.smoke.expect))) errors.push('smoke must be { args: {…}, expect?: {…} }: a safe call and what its result must contain');
    else smoke = { args: raw.smoke.args, ...(raw.smoke.expect ? { expect: raw.smoke.expect } : {}) };
  }
  const origin = {};
  if (raw.origin !== undefined) {
    if (!plainObject(raw.origin)) errors.push('origin must be an object { project, task, session, node, trace }');
    else for (const k of ['project', 'task', 'session', 'node', 'trace']) if (raw.origin[k] != null && raw.origin[k] !== '') origin[k] = String(raw.origin[k]).slice(0, 200);
  }
  if (errors.length) return { manifest: null, errors: errors.map((e) => `${id || '?'}: ${e}`) };
  return {
    manifest: {
      id, name, description, tags, language, entry, inputs, outputs, platforms, safety, version,
      ...(timeoutSec ? { timeoutSec } : {}), ...(smoke ? { smoke } : {}), origin,
      created: time(raw.created) || now, updated: time(raw.updated) || now,
      uses: Math.max(0, Math.floor(Number(raw.uses) || 0)), lastUsed: time(raw.lastUsed),
    },
    errors: [],
  };
}

/** Check call arguments against a tool's `inputs` schema (required, types, enums, nested properties/items). Pure. */
export function validateArgs(schema, args) {
  if (!plainObject(args)) return ['arguments must be a JSON object'];
  const errors = [];
  const typeOk = (t, v) => (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
    : t === 'array' ? Array.isArray(v) : t === 'object' ? plainObject(v) : t === 'null' ? v === null : typeof v === t);
  const check = (s, v, where, depth) => {
    if (!plainObject(s) || depth > 8) return;
    const types = s.type === undefined ? [] : [].concat(s.type);
    if (types.length && !types.some((t) => typeOk(t, v))) { errors.push(`${where} must be ${types.join(' or ')}`); return; }
    if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${where} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    const at = (k) => (where === 'args' ? k : `${where}.${k}`);
    if (plainObject(v)) {
      for (const r of s.required || []) if (v[r] === undefined) errors.push(`${at(r)} is required`);
      for (const [k, sub] of Object.entries(s.properties || {})) if (v[k] !== undefined) check(sub, v[k], at(k), depth + 1);
    }
    if (Array.isArray(v) && s.items) v.forEach((x, i) => check(s.items, x, `${where}[${i}]`, depth + 1));
  };
  check(schema || {}, args, 'args', 0);
  return errors;
}

// ---------------------------------------------------------------- search (pure)

const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

/**
 * Search metadata for applets that registered without a description or tags: tools/applets.json in the checkout,
 * { "<app id>": { description, tags } } (keys starting with "_" are comments). Bad entries are skipped. Never throws.
 */
export function appletMeta({ file = path.join(APP_DIR, 'tools', 'applets.json') } = {}) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  const out = {};
  for (const [id, m] of Object.entries(plainObject(raw) ? raw : {})) {
    if (id.startsWith('_') || !plainObject(m)) continue;
    out[id] = {
      description: typeof m.description === 'string' ? m.description.trim().slice(0, 500) : '',
      tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string' && /^[\w.+-]{1,32}$/.test(t)).map((t) => t.toLowerCase()) : [],
    };
  }
  return out;
}

/** A mesh App Cloud app as a search entry next to the tools (kind "applet"). `meta` is appletMeta(): used where the app has none of its own. */
export function appletEntry(app, meta = {}) {
  const own = Array.isArray(app.tags) && app.tags.length ? app.tags : null;
  const fallback = meta && !Array.isArray(meta) ? meta[app.id] : null;
  return {
    kind: 'applet', id: app.id, name: app.name || app.id, node: app.node, icon: app.icon,
    description: app.description || fallback?.description || `${app.name || app.id}: web applet in the App Cloud on ${app.node}`,
    tags: ['applet', ...(own || fallback?.tags || [])], status: app.health?.status || 'unknown',
    path: `/api/nodes/${encodeURIComponent(app.node)}/apps/${app.id}/`,
  };
}

/**
 * Score one catalog entry against a query: the exact id or name gets a bonus; each query word scores 30 as a word
 * of the id/name, 20 inside the id/name, 15 as a tag, 5-8 in the description. Every word must hit somewhere or the
 * score is 0. An empty query matches everything with 1. Pure.
 */
export function scoreEntry(e, q) {
  const qs = words(q);
  if (!qs.length) return 1;
  const id = String(e.id || '').toLowerCase();
  const name = String(e.name || '').toLowerCase();
  const phrase = String(q).trim().toLowerCase();
  let score = id === phrase || name === phrase ? 100 : 0;
  const own = new Set([...words(id), ...words(name)]);
  const tagw = new Set((e.tags || []).flatMap((t) => [String(t).toLowerCase(), ...words(t)]));
  const descw = words(e.description);
  for (const w of qs) {
    let s = own.has(w) ? 30 : id.includes(w) || name.includes(w) ? 20 : 0;
    if (tagw.has(w)) s = Math.max(s, 15);
    const inDesc = descw.filter((d) => d === w || (w.length > 3 && d.startsWith(w))).length;
    if (inDesc) s = Math.max(s, 5 + Math.min(inDesc, 3));
    if (!s) return 0;
    score += s;
  }
  return score;
}

/**
 * Rank tools and applets for a query and/or tag; ties go to the most used, then by name. kind filters to "tool"
 * or "applet". Returns the matching entries with their `score`. Pure.
 */
export function searchCatalog(entries, { q = '', tag = '', kind = '', limit = 50 } = {}) {
  const t = String(tag || '').trim().toLowerCase();
  const out = [];
  for (const e of entries) {
    const k = e.kind || 'tool';
    if (kind && k !== kind) continue;
    if (t && !(e.tags || []).some((x) => String(x).toLowerCase() === t)) continue;
    const score = scoreEntry(e, q);
    if (score > 0) out.push({ ...e, kind: k, score });
  }
  out.sort((a, b) => b.score - a.score || (b.uses || 0) - (a.uses || 0) || String(a.name).localeCompare(String(b.name)) || String(a.node || '').localeCompare(String(b.node || '')));
  return limit ? out.slice(0, limit) : out;
}

// ---------------------------------------------------------------- reuse hints for briefs and the planner (pure)

// Words that say nothing about WHICH tool a task needs. Matching is on stems, so these are stems too.
const STOP = new Set(('the and for with from that this these those then than into onto over under about after before when while where which what who how why '
  + 'are was were been being have has had can could should would will shall may might must not all any each every some more most other such only own same '
  + 'also its our your their there here get got use used using make made need needs needed new old one two task tool agent code file write read run add '
  + 'check create build work project step item list set sir rig mesh node machine').split(' '));

/** A cheap stem: lower case, plural / -ing / -ed / -es removed ("screenshots" → "screenshot", "publishing" → "publish"). */
export function stem(w) {
  let s = String(w || '').toLowerCase();
  if (s.length > 4 && s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (/(?:sh|ch|x|ss|z)es$/.test(s) && s.length > 5) return s.slice(0, -2);
  if ((s.length > 5 && s.endsWith('ing')) || (s.length > 4 && s.endsWith('ed'))) {
    s = s.slice(0, s.endsWith('ing') ? -3 : -2);
    return s.length > 3 && s.at(-1) === s.at(-2) ? s.slice(0, -1) : s; // "running" → "run"
  }
  return s.length > 3 && s.endsWith('s') && !s.endsWith('ss') ? s.slice(0, -1) : s;
}

/** The distinct stems of the words of a task or goal that can tell tools apart. Pure. */
export function keywords(text) {
  return [...new Set(words(text).map(stem).filter((w) => w.length > 2 && !STOP.has(w)))];
}

/**
 * Which tools and applets could save this task a helper script. Keyword match, no model: each keyword scores 3 when
 * it is a word of an entry's id or name, 2 as a tag, 1 in its description (stemmed whole words); an entry needs 3
 * points to count (one id/name word, or a tag plus a description word, or three description words). Best first, ties
 * to the most used; at most `limit`. Pure.
 */
export function matchTools(entries, text, { limit = 3, min = 3 } = {}) {
  const ks = keywords(text);
  if (!ks.length) return [];
  const out = [];
  for (const e of entries || []) {
    const own = new Set([...words(e.id), ...words(e.name)].map(stem));
    const tags = new Set((e.tags || []).flatMap((t) => [String(t).toLowerCase(), ...words(t)].map(stem)));
    const desc = new Set(words(e.description).map(stem));
    let score = 0;
    for (const k of ks) score += own.has(k) ? 3 : tags.has(k) ? 2 : desc.has(k) ? 1 : 0;
    if (score >= min) out.push({ ...e, kind: e.kind || 'tool', score });
  }
  out.sort((a, b) => b.score - a.score || (b.uses || 0) - (a.uses || 0) || String(a.id).localeCompare(String(b.id)));
  return out.slice(0, limit);
}

/** One line per match for a prompt: "- `id` (tool on node): what it does". */
export function hintLines(matches, { width = 90 } = {}) {
  return (matches || []).map((m) => {
    const d = String(m.description || '').replace(/\s+/g, ' ').trim();
    return `- \`${m.id}\` (${m.kind === 'applet' ? 'applet' : 'tool'}${m.node ? ` on ${m.node}` : ''}): ${d.length > width ? `${d.slice(0, width - 1)}…` : d}`;
  });
}

// What agents are told. Each stays a few hundred characters: it is paid for in every brief and every setup.

/** The paragraph of a task brief's tool section. */
export const BRIEF_NOTE = 'Before writing a helper script, call the rigs MCP tool `tool_list` with what you need (filed tools and published applets are ranked together); run a hit with `tool_run`, open an applet instead of building another. When you write a script another task could reuse (a check, converter, publisher, parser), file it with `tool_register`: arguments as JSON on stdin, result on stdout, no secrets.';

/** The task brief's "Reusable tools" section: the paragraph plus this task's likely matches. */
export function briefSection(matches) {
  const lines = hintLines(matches);
  return `## Reusable tools\n${BRIEF_NOTE}\n${lines.length ? `Likely matches for this task (read with \`tool_get\` first):\n${lines.join('\n')}\n` : ''}\n`;
}

/** The planning prompt's tool rule with the filed tools that fit the goal. */
export function planNote(matches) {
  const lines = hintLines(matches, { width: 70 });
  return `- Agents reuse filed tools: before writing a helper they call \`tool_list\`, and they file reusable scripts with \`tool_register\`. Where a filed tool fits, name it in the task description so the agent runs it with \`tool_run\` instead of writing it again.${lines.length ? `\n  Filed tools that fit this goal:\n${lines.map((l) => `  ${l}`).join('\n')}` : ''}`;
}

/** The agent instructions bullet written by `rigs setup`. */
export const AGENT_NOTE = '**Reusable tools**: before writing a helper script, search the registry with `tool_list` (tools other agents filed plus App Cloud applets) and run a hit with `tool_run`. When you write a script another task could reuse, file it with `tool_register` (JSON arguments on stdin, result on stdout, no secrets).';

/**
 * Merge per-node results like aggregateApps: [{ node: {id,name}, tools?: [...], error? }] → { tools, errors }.
 * A node whose answer has no `tools` list runs an older RIGS (its /api/local/tools was the CLI-binary report).
 */
export function aggregateTools(results) {
  const tools = [];
  const errors = [];
  for (const r of results) {
    if (r.error) { errors.push({ node: r.node.name, error: r.error }); continue; }
    if (!Array.isArray(r.tools)) { errors.push({ node: r.node.name, error: 'no tool registry (older RIGS)' }); continue; }
    for (const t of r.tools) tools.push({ ...t, kind: 'tool', node: r.node.name, nodeId: r.node.id });
  }
  tools.sort((a, b) => a.node.localeCompare(b.node) || a.id.localeCompare(b.id));
  return { tools, errors };
}

/** What a listing shows of a tool: no source and only project/task of its origin. */
export const summary = (m) => ({
  id: m.id, name: m.name, description: m.description, tags: m.tags, language: m.language, platforms: m.platforms,
  safety: m.safety, version: m.version, inputs: m.inputs, outputs: m.outputs, uses: m.uses, lastUsed: m.lastUsed, updated: m.updated,
  ...(m.seed ? { seed: true } : {}),
  ...(m.origin?.project || m.origin?.task ? { origin: { project: m.origin.project, task: m.origin.task } } : {}),
});

// ---------------------------------------------------------------- storage

async function readManifest(dir) {
  const { manifest, errors } = validateManifest(JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')));
  if (!manifest) throw new Error(errors.join('; '));
  if (manifest.id !== path.basename(dir)) throw new Error(`${manifest.id}: manifest id does not match its folder ${path.basename(dir)}`);
  return manifest;
}

// Seed tools live in the checkout, which must stay clean: their usage counts are kept beside the filed tools.
const usageFile = (root) => path.join(root, '.usage.json');
async function readUsage(root) { try { return JSON.parse(await fsp.readFile(usageFile(root), 'utf8')); } catch { return {}; } }
const seedView = (m, usage) => ({ ...m, seed: true, ...(usage[m.id] ? { uses: Number(usage[m.id].uses) || 0, lastUsed: usage[m.id].lastUsed || null } : {}) });
async function bumpUsage(dir, manifest, home) {
  if (path.dirname(dir) === home) return writeJsonAtomic(path.join(dir, 'manifest.json'), { ...manifest, uses: manifest.uses + 1, lastUsed: Date.now() });
  const usage = await readUsage(home);
  usage[manifest.id] = { uses: manifest.uses + 1, lastUsed: Date.now() };
  await fsp.mkdir(home, { recursive: true });
  return writeJsonAtomic(usageFile(home), usage);
}

/** Every tool on this machine: { node, tools: [summary], errors: [{ id, error }] } (a broken manifest is reported). */
export async function listLocal({ dirs = roots() } = {}) {
  const seen = new Map();
  const errors = [];
  const usage = dirs.length > 1 ? await readUsage(dirs[0]) : {};
  for (const root of dirs) {
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      if (!d.isDirectory() || seen.has(d.name) || d.name.startsWith('.')) continue;
      try { const m = await readManifest(path.join(root, d.name)); seen.set(d.name, root === dirs[0] ? m : seedView(m, usage)); } catch (e) { errors.push({ id: d.name, error: e.code === 'ENOENT' ? 'no manifest.json' : e.message }); }
    }
  }
  const tools = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { node: config().name, tools: tools.map(summary), errors };
}

async function find(id, dirs) {
  const key = String(id || '').trim().toLowerCase();
  if (!ID_RE.test(key)) throw new ToolError(400, 'bad-id', `"${id}" is not a tool id`);
  for (const root of dirs) {
    const dir = path.join(root, key);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
    try { const m = await readManifest(dir); return { dir, manifest: root === dirs[0] ? m : seedView(m, await readUsage(dirs[0])) }; } catch (e) { throw new ToolError(500, 'bad-manifest', e.message); }
  }
  throw new ToolError(404, 'not-found', `no tool "${key}" on ${config().name}`);
}

async function listFiles(dir, rel = '', depth = 0) {
  const out = [];
  for (const d of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const f = rel ? `${rel}/${d.name}` : d.name;
    if (d.name.startsWith('.') || f === 'manifest.json') continue;
    if (d.isDirectory() && depth < 3) out.push(...await listFiles(dir, f, depth + 1));
    else if (d.isFile()) out.push(f);
  }
  return out;
}

/** The text of a tool's files ({ name: content }); big or binary files are listed in `skipped`. */
async function readFiles(dir) {
  const files = {};
  const skipped = [];
  for (const f of (await listFiles(dir)).slice(0, MAX_FILES)) {
    const buf = await fsp.readFile(path.join(dir, f));
    if (buf.length > MAX_FILE_BYTES || buf.includes(0)) skipped.push(f); else files[f] = buf.toString('utf8');
  }
  return { files, skipped };
}

/** One tool: its manifest plus its source files. */
export async function getTool(id, { dirs = roots() } = {}) {
  const { dir, manifest } = await find(id, dirs);
  const { files, skipped } = await readFiles(dir);
  return { node: config().name, manifest, files, ...(skipped.length ? { skipped } : {}) };
}

/**
 * File a tool: { ...manifest, files?: { name: text }, source?: text of the entry }. Re-registering an id updates
 * it in place (created and uses are kept). Rejects an invalid manifest with every problem listed, and a missing entry
 * file. Returns { node, tool: summary, created }.
 */
export async function registerTool(body, { dirs = roots(), now = Date.now() } = {}) {
  if (!plainObject(body)) throw new ToolError(400, 'invalid', 'body must be a JSON object: the manifest plus files or source');
  const { files: rawFiles, source, created, updated, uses, lastUsed, ...raw } = body;
  const { manifest, errors } = validateManifest(raw, { now });
  if (!manifest) throw new ToolError(400, 'invalid', `invalid tool manifest: ${errors.join('; ')}`);
  const files = {};
  if (rawFiles !== undefined) {
    if (!plainObject(rawFiles)) throw new ToolError(400, 'invalid', 'files must be an object { "name": "text" }');
    for (const [f, text] of Object.entries(rawFiles)) {
      if (!safeFile(f) || f === 'manifest.json') throw new ToolError(400, 'invalid', `file name "${f}" must be relative, without "..", hidden parts or manifest.json`);
      if (typeof text !== 'string') throw new ToolError(400, 'invalid', `files["${f}"] must be text`);
      files[f] = text;
    }
  }
  if (source !== undefined) {
    if (typeof source !== 'string') throw new ToolError(400, 'invalid', 'source must be the text of the entry file');
    files[manifest.entry] = source;
  }
  if (Object.keys(files).length > MAX_FILES) throw new ToolError(400, 'invalid', `at most ${MAX_FILES} files per tool`);
  for (const [f, text] of Object.entries(files)) if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new ToolError(400, 'invalid', `${f} is larger than ${MAX_FILE_BYTES / 1024} KB`);
  const dir = path.join(dirs[0], manifest.id);
  let prev = null;
  try { prev = await readManifest(dir); } catch {}
  if (files[manifest.entry] === undefined && !fs.existsSync(path.join(dir, ...manifest.entry.split('/')))) throw new ToolError(400, 'invalid', `${manifest.id}: the entry file "${manifest.entry}" is missing: send it as source or in files`);
  const out = { ...manifest, origin: Object.keys(manifest.origin).length ? manifest.origin : prev?.origin || {}, created: prev?.created || now, updated: now, uses: prev?.uses || 0, lastUsed: prev?.lastUsed || null };
  await fsp.mkdir(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(dir, ...f.split('/'));
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, text, { mode: f === manifest.entry ? 0o755 : 0o644 });
  }
  await writeJsonAtomic(path.join(dir, 'manifest.json'), out);
  return { node: config().name, tool: summary(out), created: !prev };
}

// ---------------------------------------------------------------- running

/** The interpreter command line for a language on this machine, or null when it is not installed. */
export function interpreter(language, { lookup = which, win = isWin } = {}) {
  if (language === 'node') return [process.execPath];
  if (language === 'python') { const p = win ? lookup('python') || lookup('py') : lookup('python3') || lookup('python'); return p ? [p] : null; }
  if (language === 'bash' || language === 'sh') { const p = lookup(language); return p ? [p] : null; }
  if (language === 'powershell') { const p = win ? lookup('powershell') || lookup('pwsh') : lookup('pwsh'); return p ? [p, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] : null; }
  return null;
}

/**
 * Why a run must not go ahead, or null. Pure: a mutating tool without allowMutating: true, a platform the tool
 * does not support, bad arguments, or a git step the guard forbids in this cwd (in any source file or the arguments).
 */
export function refusal(manifest, args, { allowMutating = false, platform = platformOf(), sources = [], devWorktree = false } = {}) {
  if (manifest.safety === 'mutating' && allowMutating !== true) return { code: 'mutating', status: 403, error: `${manifest.id} is a mutating tool (it changes files or state): run it only when that is wanted, with allowMutating: true` };
  if (!manifest.platforms.includes(platform)) return { code: 'platform', status: 400, error: `${manifest.id} runs on ${manifest.platforms.join(', ')}, not ${platform}` };
  const bad = validateArgs(manifest.inputs, args);
  if (bad.length) return { code: 'bad-args', status: 400, error: `${manifest.id}: ${bad.join('; ')}` };
  for (const text of [...sources, JSON.stringify(args)]) {
    for (const line of String(text).split('\n')) {
      const step = gitViolation(line, { devWorktree });
      if (step) return { code: 'git-guard', status: 403, error: `${manifest.id} would run "git ${step}", which the git guard forbids ${devWorktree ? 'even in a RIGS dev worktree' : 'outside a RIGS dev worktree'}` };
    }
  }
  return null;
}

const parseOut = (s) => { const t = s.trim(); if (!t) return null; try { return JSON.parse(t); } catch { return t; } };

/**
 * Run a tool on this machine. Throws a ToolError (status + code) when it is refused; otherwise returns
 * { node, id, version, ok, code, timedOut, durationMs, result, stderr }. `deps` lets tests inject the runner,
 * the interpreter lookup and the dev-worktree check.
 */
export async function runTool(id, { args = {}, allowMutating = false, timeoutSec, cwd, dirs = roots(), deps = {}, count = true } = {}) {
  const { dir, manifest } = await find(id, dirs);
  const isDev = deps.isDevWorktree || (await import('./work.js')).isDevWorktree;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const workDir = cwd ? path.resolve(String(cwd).replace(/^~(?=$|[\\/])/, home)) : dir;
  if (!fs.existsSync(workDir)) throw new ToolError(400, 'bad-cwd', `cwd ${workDir} does not exist`);
  const { files } = await readFiles(dir);
  const no = refusal(manifest, args ?? {}, { allowMutating, sources: Object.values(files), devWorktree: isDev(workDir) });
  if (no) throw new ToolError(no.status, no.code, no.error);
  const cmd = (deps.interpreter || interpreter)(manifest.language);
  if (!cmd) throw new ToolError(400, 'no-interpreter', `${manifest.id} needs ${manifest.language}, which is not installed on ${config().name}`);
  const limit = Math.min(MAX_TIMEOUT_SEC, Number(timeoutSec) > 0 ? Number(timeoutSec) : manifest.timeoutSec || DEFAULT_TIMEOUT_SEC);
  const input = JSON.stringify(args ?? {});
  const start = Date.now();
  const r = await (deps.run || run)(cmd[0], [...cmd.slice(1), path.join(dir, ...manifest.entry.split('/'))], {
    cwd: workDir, input, timeout: limit * 1000,
    env: { ...process.env, PATH: augmentedPath(), RIGS_TOOL: manifest.id, RIGS_TOOL_DIR: dir, RIGS_TOOL_ARGS: input, RIGS_APP_DIR: APP_DIR },
  });
  const durationMs = Date.now() - start;
  const timedOut = r.code === -2;
  // The usage count is best effort: it never fails a run.
  if (count) await bumpUsage(dir, manifest, dirs[0]).catch(() => {});
  return {
    node: config().name, id: manifest.id, version: manifest.version, ok: r.code === 0, code: r.code, timedOut, durationMs,
    ...(timedOut ? { error: `timed out after ${limit}s` } : {}),
    result: parseOut(truncate(redact(r.stdout || ''), 200000)),
    stderr: truncate(redact(r.stderr || ''), 50000),
  };
}

/** Does `actual` contain everything in `expected`? Objects are compared key by key (extra keys are fine), the rest strictly. Pure. */
export function containsSubset(actual, expected) {
  if (plainObject(expected)) return plainObject(actual) && Object.entries(expected).every(([k, v]) => containsSubset(actual[k], v));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Run a tool's declared `smoke` call (a dry run or other safe call) in a scratch cwd and check the result against
 * its `expect`. Does not count as a use. Returns { id, ok, durationMs, problem? }; a tool without `smoke` is
 * { ok: false, skipped: true }.
 */
export async function smokeTool(id, { dirs = roots(), deps = {} } = {}) {
  const { manifest } = await find(id, dirs);
  if (!manifest.smoke) return { id: manifest.id, ok: false, skipped: true, problem: 'no smoke check declared in the manifest' };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-smoke-'));
  try {
    // The smoke call is declared safe by the tool's author, so a mutating tool may run it.
    const r = await runTool(manifest.id, { args: manifest.smoke.args, allowMutating: true, cwd, dirs, deps, count: false });
    const problem = !r.ok ? `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${String(r.stderr || (typeof r.result === 'string' ? r.result : r.result?.error) || '').slice(0, 300)}`
      : manifest.smoke.expect && !containsSubset(r.result, manifest.smoke.expect) ? `result does not contain ${JSON.stringify(manifest.smoke.expect)}: got ${JSON.stringify(r.result).slice(0, 300)}` : '';
    return { id: manifest.id, ok: !problem, durationMs: r.durationMs, ...(problem ? { problem } : {}) };
  } catch (e) {
    return { id: manifest.id, ok: false, problem: e.message };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
