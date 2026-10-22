// Opening a view in the JARVIS UI from a brain or an agent: MCP `ui_open` → POST /api/mesh/ui/open → a `ui-open`
// WebSocket push to the UI that made the request (else every open UI on the mesh). Views (UI_VIEWS): the file browser
// ("files", the default), an App Cloud app window ("app"), a page in a sandboxed window ("url"), the Projects window on
// a project ("project"), the trace explorer ("trace"), the 3D viewer for a .glb/.gltf/.obj ("model") and a file in one
// built-in tool ("tool"), the YOLO history list ("yolo"). A new view = a name in UI_VIEWS, its argument rules in validateOpen, and a case in the UI's
// ui-open-model.js. The parts here are pure (tested in test/ui-open.test.js); server.js wires them to the mesh.
import { matchMachine } from './workspaces.js';

export const UI_VIEWS = ['files', 'app', 'url', 'project', 'trace', 'model', 'tool', 'yolo'];
/** The built-in file tools `view: 'tool'` can name (ui/src/file-tools.js): csv grid, json tree, pdf, image, text, rendered html, 3D model. */
export const FILE_TOOLS = ['text', 'image', 'pdf', 'csv', 'json', 'html', 'model'];
/** What `view: 'url'` may show: an http(s) page, or a same-origin API path (an app's route, a raw file, a report). */
export const isAllowedUrl = (u) => /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(String(u || '')) || /^\/api\/[^\s]*$/.test(String(u || ''));

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

/** The virtual place that lists a machine's applications; it has no folder to look up. */
export const APPS_PLACE = '@apps';

/** Looks like a filesystem path (~, /, \, ., C:\ or a separator inside), not a name like "MadMikeUnity". */
export const isPathLike = (p) => /^(?:~|\/|\\|\.{1,2}(?:[\\/]|$)|[a-z]:[\\/])/i.test(String(p || '')) || /[\\/]/.test(String(p || ''));

function bad(msg) { const e = new Error(msg); e.status = 400; e.code = 'bad-request'; return e; }

/**
 * The tool's arguments, checked. Every view gets { view, node, path } (node = `node` or `machine`, mesh_workspaces'
 * word for it) plus its own fields: app → { app, path? (a route inside it) }, url → { url }, project → { project },
 * trace → { trace }, tool → { tool }; `title` rides along when given. Throws a 400 for an unknown view, a missing
 * required field or a malformed value. `files` is exactly as before: { view, node, path }.
 */
export function validateOpen(a = {}) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) throw bad('ui_open needs an object of arguments');
  const view = a.view === undefined || a.view === '' ? 'files' : a.view;
  if (typeof view !== 'string' || !UI_VIEWS.includes(view)) throw bad(`unknown view "${view}" (one of: ${UI_VIEWS.join(', ')})`);
  for (const k of ['node', 'machine', 'path', 'app', 'url', 'project', 'trace', 'tool', 'title']) {
    if (a[k] !== undefined && a[k] !== null && typeof a[k] !== 'string') throw bad(`${k} must be a string`);
  }
  // `machine` is what mesh_workspaces calls it, and brains carry it over: the same thing as node.
  const node = String(a.node || a.machine || '').trim();
  const path = String(a.path ?? '').trim();
  if (node.length > 120) throw bad('node is too long');
  if (path.length > 4096) throw bad('path is too long');
  if (/\0/.test(path)) throw bad('path has a NUL byte');
  const out = { view, node, path };
  const title = String(a.title ?? '').trim();
  if (title.length > 200) throw bad('title is too long');
  if (title) out.title = title;
  switch (view) {
    case 'files': return out;
    case 'yolo': return out; // the YOLO history window: one list of past runs from every machine (no arguments)
    case 'app': {
      const app = String(a.app ?? '').trim();
      if (!app) throw bad('view "app" needs app: the App Cloud app id (see mesh_apps)');
      if (!/^[a-z0-9-]{1,80}$/.test(app)) throw bad('app must be an App Cloud id: lowercase letters, digits and dashes');
      if (path && !path.startsWith('/')) throw bad('path for an app is a route inside it and starts with /');
      return { ...out, app };
    }
    case 'url': {
      const url = String(a.url ?? '').trim();
      if (!url) throw bad('view "url" needs url: an http(s) page or a /api/... path');
      if (url.length > 4096) throw bad('url is too long');
      if (!isAllowedUrl(url)) throw bad('url must be http(s) or a same-origin /api/... path');
      return { ...out, url };
    }
    case 'project': {
      const project = String(a.project ?? '').trim();
      if (!project) throw bad('view "project" needs project: the project id');
      if (!/^[\w.-]{1,120}$/.test(project)) throw bad('project must be an id (letters, digits, - _ .)');
      return { ...out, project };
    }
    case 'trace': {
      const trace = String(a.trace ?? '').trim();
      if (!trace) throw bad('view "trace" needs trace: the request trace id (tr-…)');
      if (!/^tr-\d{8}-[0-9a-f]{12}$/.test(trace)) throw bad('trace must be a trace id like tr-20261022-0123456789ab');
      return { ...out, trace };
    }
    case 'model': {
      if (!path) throw bad('view "model" needs path: the .glb, .gltf or .obj file');
      return out;
    }
    case 'tool': {
      const tool = String(a.tool ?? '').trim().toLowerCase();
      if (!path) throw bad('view "tool" needs path: the file to open');
      if (!tool) throw bad(`view "tool" needs tool: one of ${FILE_TOOLS.join(', ')}`);
      if (!FILE_TOOLS.includes(tool)) throw bad(`unknown tool "${tool}" (one of: ${FILE_TOOLS.join(', ')})`);
      return { ...out, tool };
    }
    default: return out;
  }
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
const pushId = () => `uo-${Date.now().toString(36)}-${(++seq).toString(36)}`;
/** The push the UI receives. `requested` is what was asked for; `path` what opens; `missing` means it fell back. */
export function uiOpenEvent({ view = 'files', node, located, requested = '', trace = '', workspace = '' }) {
  return {
    type: 'ui-open', id: pushId(), view,
    nodeId: node.id, nodeName: node.name, path: located.folder, select: located.select || '', missing: !!located.missing,
    requested: String(requested || ''), ...(workspace ? { workspace } : {}), ...(trace ? { trace } : {}),
  };
}

/**
 * The push for the other views: { type: 'ui-open', id, view, ...fields, trace? }. app → { app, node, nodeId, path };
 * url → { url, title? }; project → { project, node?, nodeId? }; trace → { trace }; model / tool → { node, nodeId, path
 * (the file), folder, tool? }. Empty fields are left out.
 */
export function uiOpenPush({ view, trace = '', ...fields }) {
  const out = { type: 'ui-open', id: pushId(), view };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  if (trace) out.trace = trace;
  return out;
}

/** How many UIs a delivery round reached: [{ node, delivered }] → n. */
export const deliveredCount = (rounds = []) => rounds.reduce((s, r) => s + (Number(r?.delivered) || 0), 0);
