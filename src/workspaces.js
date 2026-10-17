import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { HOME, log, readJsonSync, writeJsonAtomic } from './util.js';

/**
 * Workspaces: the code projects that live on this machine, so a request like "improve the fps on
 * MadMikeUnity on the linux machine" can be bound to a real folder before any agent starts.
 *
 * A workspace is the top-most folder with a project marker (git, AGENTS.md/CLAUDE.md, a Unity/Godot/
 * Unreal project, package.json, pyproject…). Nested projects inside it (a Unity project in `share/`,
 * extra git repos) are recorded as parts. Its title comes from the first heading of its agent guide or
 * README — that's how "Mad Mike" finds the folder named MadMaxUnity.
 */

const FILE = path.join(RIGS_HOME, 'workspaces.json');
const TTL = 30 * 60 * 1000;
const SKIP = new Set([
  'node_modules', 'Library', 'Temp', 'Logs', 'obj', 'Builds', 'build', 'dist', 'venv', '.venv', 'env', '__pycache__',
  'site-packages', 'PackageCache', 'UserSettings', 'vendor', 'target', 'Pictures', 'Music', 'Movies', 'Videos', 'Photos',
  'snap', 'Applications', 'miniconda3', 'anaconda3', 'Downloads', 'Public', 'Templates', 'rigs-work', 'rigs-dev',
  'AppData', 'OneDrive', 'Dropbox', 'Google Drive', 'Creative Cloud Files', 'go', 'Unity',
]);
const MARKER_FILES = ['AGENTS.md', 'CLAUDE.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'project.godot', 'setup.py', 'requirements.txt'];
const KIND_OF = { 'package.json': 'node', 'pyproject.toml': 'python', 'setup.py': 'python', 'requirements.txt': 'python', 'Cargo.toml': 'rust', 'go.mod': 'go', 'project.godot': 'godot' };

function readdir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function unityVersion(dir) {
  try {
    const t = fs.readFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
    return (t.match(/m_EditorVersion:\s*(\S+)/) || [])[1] || 'unknown';
  } catch { return null; }
}

/** What kind of project is this folder (on its own)? */
function markersOf(dir, entries) {
  const names = new Set(entries.map((e) => e.name));
  const kinds = new Set();
  const guides = [];
  if (names.has('.git')) kinds.add('git');
  for (const f of MARKER_FILES) {
    if (!names.has(f)) continue;
    if (f === 'AGENTS.md' || f === 'CLAUDE.md') guides.push(f);
    else kinds.add(KIND_OF[f]);
  }
  let unity = null;
  if (names.has('Assets') && names.has('ProjectSettings')) { unity = unityVersion(dir); if (unity) kinds.add('unity'); }
  if (entries.some((e) => e.isFile() && e.name.endsWith('.uproject'))) kinds.add('unreal');
  return { kinds, guides, unity, any: kinds.size > 0 || guides.length > 0 };
}

function titleOf(dir, guides) {
  for (const f of [...guides, 'README.md', 'readme.md']) {
    try {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000);
      const m = head.match(/^#\s+(.+)$/m);
      if (m) return m[1].replace(/[*_`]/g, '').trim().slice(0, 120);
    } catch {}
  }
  return '';
}

/** Nested projects inside a workspace (Unity projects, extra repos), up to `depth` levels down. */
function partsOf(root, depth = 3) {
  const parts = [];
  const walk = (dir, d) => {
    if (d > depth || parts.length >= 24) return;
    for (const e of readdir(dir)) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name) || e.name === 'Assets') continue;
      const p = path.join(dir, e.name);
      const entries = readdir(p);
      const m = markersOf(p, entries);
      if (m.kinds.has('unity')) parts.push({ rel: path.relative(root, p), kind: 'unity', version: m.unity });
      else if (m.kinds.has('unreal')) parts.push({ rel: path.relative(root, p), kind: 'unreal' });
      if (m.kinds.has('git')) parts.push({ rel: path.relative(root, p), kind: 'git' });
      if (!m.kinds.has('unity')) walk(p, d + 1);
    }
  };
  walk(root, 1);
  return parts;
}

function describe(dir, entries, m) {
  const parts = partsOf(dir);
  const kinds = new Set(m.kinds);
  for (const x of parts) kinds.add(x.kind);
  let updatedAt = 0;
  for (const f of [...m.guides, '.git', 'Assets', 'package.json']) { try { updatedAt = Math.max(updatedAt, fs.statSync(path.join(dir, f)).mtimeMs); } catch {} }
  return {
    name: path.basename(dir), path: dir, title: titleOf(dir, m.guides), kinds: [...kinds], guides: m.guides,
    unity: m.unity, parts, updatedAt: Math.round(updatedAt) || undefined,
  };
}

/** Walk the home folder (plus configured roots and folders agents recently worked in). */
export function scan({ roots, extraDirs = [], maxDepth = 4, budgetMs = 15000, home = HOME } = {}) {
  const started = Date.now();
  const found = new Map();
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || Date.now() - started > budgetMs || visited > 40000) return;
    visited++;
    const entries = readdir(dir);
    const m = markersOf(dir, entries);
    if (m.any && dir !== home) { if (!found.has(dir)) found.set(dir, describe(dir, entries, m)); return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots || [home, ...(config().workspaces?.roots || []).map((x) => x.replace(/^~(?=$|[\\/])/, home))]) walk(r, r === home ? 0 : 1);
  // A folder an agent worked in counts even outside the roots: take its top-most marked ancestor below home.
  for (const d of extraDirs) {
    if (!d || !d.startsWith(home + path.sep) || [...found.keys()].some((k) => d === k || d.startsWith(k + path.sep))) continue;
    let top = null;
    for (let cur = d; cur.startsWith(home + path.sep); cur = path.dirname(cur)) {
      const entries = readdir(cur);
      const m = markersOf(cur, entries);
      if (m.any) top = { cur, entries, m };
    }
    if (top && !found.has(top.cur)) found.set(top.cur, describe(top.cur, top.entries, top.m));
  }
  return [...found.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

let cache = readJsonSync(FILE, null);
let scanning = null;

/** This machine's workspaces (cached; rescanned in the background after 30 min, or now with force). */
export async function list({ force = false, extraDirs = [] } = {}) {
  const fresh = cache && Date.now() - cache.at < TTL;
  if (fresh && !force) return cache.list;
  if (!scanning) {
    scanning = new Promise((resolve) => setImmediate(() => resolve(scan({ extraDirs }))))
      .then(async (found) => {
        cache = { at: Date.now(), list: found };
        await writeJsonAtomic(FILE, cache).catch(() => {});
        return found;
      })
      .catch((e) => { log('workspaces scan:', e.message); return cache?.list || []; })
      .finally(() => { scanning = null; });
  }
  return cache && !force ? cache.list : scanning;
}

// ---------------------------------------------------------------- matching (pure)

const STOP = new Set(['the', 'and', 'for', 'on', 'of', 'in', 'to', 'a', 'an', 'my', 'project', 'repo', 'folder', 'guide', 'developer', 'codex', 'claude', 'agents', 'how', 'build', 'md']);

/** "MadMikeUnity" → ["mad", "mike", "unity"]; "Mad Mike's Garage" → ["mad", "mike", "garage"]. */
export function tokens(s) {
  return String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/'s\b/g, '')
    .toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function bigrams(s) { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; }
function dice(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const pool = [...B];
  let n = 0;
  for (const g of A) { const i = pool.indexOf(g); if (i >= 0) { n++; pool.splice(i, 1); } }
  return (2 * n) / (A.length + B.length);
}

/** How well does `query` name this workspace? 0…1. */
export function score(query, ws) {
  const q = flat(query);
  const qt = tokens(query);
  if (!q) return 0;
  const names = [ws.name, ws.title, ...(ws.parts || []).map((p) => path.basename(p.rel))].filter(Boolean);
  let best = 0;
  for (const s of names) {
    const f = flat(s);
    if (!f) continue;
    if (f === q) return 1;
    if (q.length >= 5 && (f.includes(q) || q.includes(f) && f.length >= 5)) best = Math.max(best, 0.9);
    best = Math.max(best, dice(q, f));
    const st = new Set(tokens(s));
    if (qt.length) best = Math.max(best, qt.filter((t) => st.has(t)).length / qt.length);
  }
  // Name and title both pointing at it is stronger than either alone ("MadMikeUnity": Mad·Mike from the title, Unity from the name).
  const all = new Set(names.flatMap(tokens));
  if (qt.length > 1) best = Math.max(best, Math.min(0.95, qt.filter((t) => all.has(t)).length / qt.length));
  return Math.round(best * 100) / 100;
}

/** Which machine does a phrase mean? "the linux machine", "magix", "my mac" → node names (empty when unclear). */
export function matchMachine(phrase, nodes) {
  const p = String(phrase || '').toLowerCase();
  if (!p.trim()) return [];
  const byName = nodes.filter((n) => p.includes(n.name.toLowerCase()) || n.name.toLowerCase().split(/[-_.]/).some((part) => part.length >= 4 && p.includes(part)));
  if (byName.length) return byName.map((n) => n.name);
  const os = /linux|ubuntu|debian|fedora|\barch\b/.test(p) ? 'linux' : /\bmac\b|macbook|\bosx\b|macos|imac/.test(p) ? 'mac' : /windows|\bwin\b|\bpc\b/.test(p) ? 'windows' : '';
  // Nodes report "mac"/"linux"/"windows" (Node's own names "darwin"/"win32" are accepted too).
  const family = (x) => (/darwin|mac/.test(x || '') ? 'mac' : /win/.test(x || '') ? 'windows' : x);
  return os ? nodes.filter((n) => family(n.platform) === os).map((n) => n.name) : [];
}

/**
 * Bind one work item to a workspace. `catalog` = [{ node, platform, items: [workspace] }].
 * Returns { node, workspace, score, alternatives } or { candidates } when it's not clear.
 */
export function resolve({ workspace = '', machine = '', text = '' }, catalog, { previousNode = '' } = {}) {
  const nodes = catalog.map((c) => ({ name: c.node, platform: c.platform }));
  // "on the same machine" / "there" refers to the machine of the previous item.
  const same = previousNode && /\b(same|that|this) (machine|box|computer|node|one)\b|\bthere\b/i.test(machine);
  const machines = same ? [previousNode] : matchMachine(machine, nodes);
  const pool = catalog.filter((c) => !machines.length || machines.includes(c.node))
    .flatMap((c) => (c.items || []).map((ws) => ({ node: c.node, ws })));
  const query = workspace || text;
  const ranked = pool.map((x) => ({ ...x, score: score(query, x.ws) })).filter((x) => x.score >= 0.45).sort((a, b) => b.score - a.score);
  if (!ranked.length && !workspace && text) {
    // No name given: try each word of the request on its own ("…the fps on MadMikeUnity…").
    const words = String(text).match(/[A-Za-z][\w'-]{3,}/g) || [];
    const hits = pool.map((x) => ({ ...x, score: Math.max(0, ...words.map((w) => score(w, x.ws))) })).filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score);
    ranked.push(...hits);
  }
  const top = ranked[0];
  const alternatives = ranked.slice(1, 4).map((x) => ({ node: x.node, name: x.ws.name, path: x.ws.path, score: x.score }));
  if (!top) return { candidates: [] , machines };
  const clear = top.score >= 0.6 && (!ranked[1] || top.score - ranked[1].score >= 0.12 || ranked[1].ws.path.startsWith(top.ws.path + path.sep));
  if (!clear) return { candidates: [top, ...ranked.slice(1, 4)].map((x) => ({ node: x.node, name: x.ws.name, title: x.ws.title, path: x.ws.path, score: x.score })), machines };
  return { node: top.node, workspace: top.ws, score: top.score, alternatives, machines };
}

/** One line per workspace for prompts. */
export function catalogLines(catalog, { perNode = 40 } = {}) {
  return catalog.flatMap((c) => (c.items || []).slice(0, perNode).map((ws) => {
    const parts = (ws.parts || []).filter((p) => p.kind === 'unity').map((p) => `unity ${p.version} in ${p.rel}`);
    return `- ${c.node} (${c.platform}): ${ws.name}${ws.title ? ` — "${ws.title}"` : ''} [${[...ws.kinds, ...parts].join(', ')}] ${ws.path}`;
  }));
}
