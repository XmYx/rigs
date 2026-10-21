// Opening a view in the JARVIS UI from a brain or an agent: MCP `ui_open` → POST /api/mesh/ui/open → a `ui-open`
// WebSocket push to the UI that made the request (else every open UI on the mesh). Today the one view is the file
// browser ("files"); a new view = a name in UI_VIEWS, its argument rules in validateOpen, and a case in the UI's
// ui-open-model.js. The parts here are pure (tested in test/ui-open.test.js); server.js wires them to the mesh.
import { matchMachine } from './workspaces.js';

export const UI_VIEWS = ['files'];

// Folders people name instead of a path: "downloads", "my home", "the desktop folder".
export const NAMED_PLACES = {
  home: '~', 'home folder': '~', 'home directory': '~', '~': '~',
  downloads: '~/Downloads', download: '~/Downloads', desktop: '~/Desktop', documents: '~/Documents', docs: '~/Documents',
  pictures: '~/Pictures', photos: '~/Pictures', music: '~/Music', movies: '~/Movies', videos: '~/Videos',
  trash: '~/.rigs/trash', 'rigs trash': '~/.rigs/trash',
  // The shared folder synced across the mesh (src/shared.js): '@shared' resolves on the machine that opens it.
  shared: '@shared', '@shared': '@shared', 'rigs shared': '@shared', 'rigs-shared': '@shared', 'mesh shared': '@shared',
  // The machine's installed apps (src/app-catalog.js): a virtual place, not a folder.
  applications: '@apps', application: '@apps', apps: '@apps', programs: '@apps', '@apps': '@apps', 'installed apps': '@apps', 'installed applications': '@apps',
  'shared apps': '@shared/apps', 'shared files': '@shared/files', 'shared reports': '@shared/reports',
};

/** "my Downloads folder", "the home directory", "Desktop" → "~/Downloads", "~", "~/Desktop"; null when it names no place. */
export function placePath(text) {
  const t = String(text || '').trim().toLowerCase()
    .replace(/^(?:(?:my|the|sir'?s|his|our)\s+)+/, '').replace(/\s+(?:folder|directory|dir)$/, '').trim();
  return Object.hasOwn(NAMED_PLACES, t) ? NAMED_PLACES[t] : null;
}

/** Looks like a filesystem path (~, /, \, ., C:\ or a separator inside), not a name like "MadMikeUnity". */
/** The virtual place that lists a machine's applications; it has no folder to look up. */
export const APPS_PLACE = '@apps';

export const isPathLike = (p) => /^(?:~|\/|\\|\.{1,2}(?:[\\/]|$)|[a-z]:[\\/])/i.test(String(p || '')) || /[\\/]/.test(String(p || ''));

function bad(msg) { const e = new Error(msg); e.status = 400; e.code = 'bad-request'; return e; }

/** The tool's arguments, checked: { view, node, path }. Throws a 400 for an unknown view or a malformed value. */
export function validateOpen(a = {}) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) throw bad('ui_open needs an object of arguments');
  const view = a.view === undefined || a.view === '' ? 'files' : a.view;
  if (typeof view !== 'string' || !UI_VIEWS.includes(view)) throw bad(`unknown view "${view}" (one of: ${UI_VIEWS.join(', ')})`);
  for (const k of ['node', 'machine', 'path']) {
    if (a[k] !== undefined && a[k] !== null && typeof a[k] !== 'string') throw bad(`${k} must be a string`);
  }
  // `machine` is what mesh_workspaces calls it, and brains carry it over: the same thing as node.
  const node = String(a.node || a.machine || '').trim();
  const path = String(a.path ?? '').trim();
  if (node.length > 120) throw bad('node is too long');
  if (path.length > 4096) throw bad('path is too long');
  if (/\0/.test(path)) throw bad('path has a NUL byte');
  return { view, node, path };
}

/**
 * Which machine does `ref` mean? '' / "self" / "this machine" / "here" → this one; a node name or id (any case); a
 * phrase ("on the linux machine", "magix") through workspaces.matchMachine — online machines first. null when it
 * matches none, or several equally.
 */
export function resolveMachine(ref, nodes = []) {
  const live = nodes.filter((n) => n.online !== false && n.rigs !== false);
  const self = nodes.find((n) => n.self) || null;
  const r = String(ref || '').trim().toLowerCase().replace(/^on\s+/, '');
  if (!r || /^(?:self|local|localhost|here|this (?:machine|mac|computer|box|one))$/.test(r)) return self;
  const exact = nodes.find((n) => String(n.name || '').toLowerCase() === r || String(n.id || '').toLowerCase() === r);
  if (exact) return exact;
  for (const pool of [live, nodes]) {
    const names = matchMachine(r, pool.map((n) => ({ name: n.name, platform: n.platform })));
    if (names.length === 1) return pool.find((n) => n.name === names[0]);
    if (names.length > 1) return null; // "the mac" with two Macs: not ours to guess
  }
  return null;
}

/**
 * Where to go: the machine and the path to look up there. A path stays as given (~ and relative paths resolve on that
 * machine); a named place becomes its ~ path; anything else is tried as a workspace nickname (`findWorkspace(name,
 * machineRef)` → { node, path } from mesh_workspaces' resolver), which may move the request to the machine that holds
 * it. → { node, path, via: 'path' | 'place' | 'workspace' | 'default', workspace? } or throws 404.
 */
export async function resolveTarget({ node = '', path = '' }, { nodes = [], findWorkspace = async () => null } = {}) {
  const machine = resolveMachine(node, nodes);
  if (node && !machine) { const e = new Error(`no machine "${node}" in the mesh`); e.status = 404; e.code = 'not-found'; throw e; }
  if (!path) return { node: machine, path: '~', via: 'default' };
  if (isPathLike(path)) return { node: machine, path, via: 'path' };
  const place = placePath(path);
  if (place) return { node: machine, path: place, via: 'place' };
  const ws = await findWorkspace(path, node);
  if (ws?.path) {
    const at = resolveMachine(ws.node, nodes) || machine;
    return { node: at, path: ws.path, via: 'workspace', workspace: ws.name || path, ...(machine && at && at.name !== machine.name ? { moved: machine.name } : {}) };
  }
  // A bare name ("rigs-dev") that is no workspace: a folder under home on that machine.
  return { node: machine, path: `~/${path}`, via: 'path' };
}

/**
 * The nearest folder to open for `full` (an absolute path on the target machine): itself when it is a folder, its
 * folder with the file selected when it is a file, else the nearest existing parent (missing: true). `kind(p)` →
 * 'dir' | 'file' | null; `parent(p)` → the parent (itself at the root). Pure given those two.
 */
export function nearestExisting(full, kind, parent) {
  let p = full;
  for (let i = 0; i < 256; i++) {
    const k = kind(p);
    if (k === 'dir') return { folder: p, select: '', missing: p !== full };
    if (k === 'file') return p === full ? { folder: parent(p), select: p, missing: false } : { folder: parent(p), select: '', missing: true };
    const up = parent(p);
    if (!up || up === p) break;
    p = up;
  }
  return { folder: '', select: '', missing: true };
}

let seq = 0;
/** The push the UI receives. `requested` is what was asked for; `path` what opens; `missing` means it fell back. */
export function uiOpenEvent({ view = 'files', node, located, requested = '', trace = '', workspace = '' }) {
  return {
    type: 'ui-open', id: `uo-${Date.now().toString(36)}-${(++seq).toString(36)}`, view,
    nodeId: node.id, nodeName: node.name, path: located.folder, select: located.select || '', missing: !!located.missing,
    requested: String(requested || ''), ...(workspace ? { workspace } : {}), ...(trace ? { trace } : {}),
  };
}

/** How many UIs a delivery round reached: [{ node, delivered }] → n. */
export const deliveredCount = (rounds = []) => rounds.reduce((s, r) => s + (Number(r?.delivered) || 0), 0);
