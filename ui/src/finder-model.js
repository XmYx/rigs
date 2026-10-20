// The Finder-style file browser's logic (files.js is the DOM layer over it). Pure, no DOM at import time:
// test/finder-model.test.js. Paths come from the machine being browsed (`sep` from its files API), so nothing here
// assumes this browser's OS.

export { clickSelect, actionTargets } from './file-tools-model.js';

export const VIEWS = Object.freeze(['icon', 'list', 'column']);
export const SORT_KEYS = Object.freeze(['name', 'mtime', 'size', 'kind']);
export const SORT_LABELS = Object.freeze({ name: 'Name', mtime: 'Date Modified', size: 'Size', kind: 'Kind' });

// ------------------------------------------------------------------ sidebar

/** The favourites every rig gets, as paths its files API resolves (`~` and `@shared` resolve on that machine). */
export const FAVOURITES = Object.freeze([
  { id: 'home', label: 'Home', icon: '🏠', path: '~' },
  { id: 'desktop', label: 'Desktop', icon: '🖥', path: '~/Desktop' },
  { id: 'documents', label: 'Documents', icon: '📄', path: '~/Documents' },
  { id: 'downloads', label: 'Downloads', icon: '⬇', path: '~/Downloads' },
  { id: 'shared', label: 'RIGS Shared', icon: '🔗', path: '@shared' },
]);

const PLATFORM_ICON = { mac: '💻', linux: '🐧', windows: '🪟', win: '🪟', ios: '📱', android: '📱' };

/**
 * The sidebar from the mesh snapshot's nodes ({ id, name, online, rigs, self, platform, home }): Favourites of the rig
 * being browsed, then Locations = every machine the mesh reports. A machine is browsable when it is online and runs
 * RIGS; anything else is listed greyed out with why (offline / no RIGS) and is not clickable.
 */
export function sidebarModel(nodes = [], { current = '', home = '' } = {}) {
  const locations = (nodes || []).filter((n) => n && n.id).map((n) => {
    const browsable = n.online !== false && n.rigs !== false;
    return {
      id: n.id, name: n.name || n.id, icon: PLATFORM_ICON[n.platform] || '🖥', self: !!n.self, home: n.home || '',
      online: n.online !== false, rigs: n.rigs !== false, browsable, current: n.id === current,
      badge: n.online === false ? 'offline' : n.rigs === false ? 'no RIGS' : 'online',
    };
  });
  // This machine first, then browsable machines, then the rest; by name within each group.
  const rank = (l) => (l.self ? 0 : l.browsable ? 1 : 2);
  locations.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const cur = locations.find((l) => l.current);
  const favourites = !current || cur?.browsable === false ? [] : FAVOURITES.map((f) => ({ ...f, nodeId: current, full: favouritePath(f.path, home || cur?.home) }));
  return { locations, favourites };
}

/** A favourite's absolute path on a machine whose home is known (for "is this favourite where I am?"), else ''. */
export function favouritePath(p, home) {
  if (!home) return '';
  if (p === '~') return home;
  if (p.startsWith('~/')) return joinPath(home, p.slice(2), sepOf(home));
  return '';
}

/** The favourite the current folder is (Finder highlights it in the sidebar), else ''. */
export function activeFavourite(favourites, path) {
  return (favourites || []).find((f) => f.full && samePath(f.full, path))?.id || '';
}

// ------------------------------------------------------------------ paths

export const sepOf = (p) => (/^[a-z]:\\/i.test(String(p)) || (String(p).includes('\\') && !String(p).includes('/')) ? '\\' : '/');
const trimSep = (p, sep) => (p.length > 1 && p.endsWith(sep) && !/^[a-z]:\\$/i.test(p) ? p.slice(0, -1) : p);
export const samePath = (a, b) => trimSep(String(a || ''), sepOf(a)) === trimSep(String(b || ''), sepOf(b));
export const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

export function joinPath(dir, name, sep = sepOf(dir)) {
  const d = String(dir || '');
  return d.endsWith(sep) ? d + name : d + sep + name;
}

/** The enclosing folder of `p` ('/' and 'C:\\' have none → null). */
export function parentOf(p, sep = sepOf(p)) {
  const s = trimSep(String(p || ''), sep);
  if (s === '/' || /^[a-z]:\\?$/i.test(s)) return null;
  const i = s.lastIndexOf(sep);
  if (i < 0) return null;
  if (i === 0) return sep;
  const up = s.slice(0, i);
  return /^[a-z]:$/i.test(up) ? up + '\\' : up;
}

/** Path-bar crumbs, root first: [{ name, path }]. The root is named after the machine (Finder: "Macintosh HD"). */
export function crumbs(p, { sep = sepOf(p), rootName = '' } = {}) {
  const s = trimSep(String(p || ''), sep);
  if (!s) return [];
  const out = [];
  let cur = s;
  while (cur) {
    out.unshift({ name: baseName(cur) || cur, path: cur });
    cur = parentOf(cur, sep);
  }
  if (out.length && rootName) out[0] = { ...out[0], name: rootName };
  return out;
}

/** Is `p` the folder `dir` or inside it? */
export function isInside(p, dir, sep = sepOf(dir)) {
  const a = trimSep(String(p || ''), sep);
  const d = trimSep(String(dir || ''), sep);
  return !!d && (a === d || a.startsWith(d.endsWith(sep) ? d : d + sep));
}

/**
 * The Miller columns that show `p`: every folder from the column root down to `p`, root first. The root is the
 * deepest of `roots` (home, the shared folder, a drive…) that holds `p`, else the filesystem root.
 */
export function columnPaths(p, { roots = [], sep = sepOf(p) } = {}) {
  const chain = crumbs(p, { sep }).map((c) => c.path);
  const root = (roots || []).filter((r) => r && isInside(p, r, sep)).sort((a, b) => b.length - a.length)[0];
  if (!root) return chain;
  const i = chain.findIndex((c) => samePath(c, root));
  return i >= 0 ? chain.slice(i) : chain;
}

// ------------------------------------------------------------------ history

export const emptyHistory = () => ({ stack: [], index: -1 });
const sameLoc = (a, b) => !!a && !!b && a.nodeId === b.nodeId && samePath(a.path, b.path);

/** Go somewhere new: drops the forward entries; the same place as now is not pushed twice. Capped. */
export function histPush(h, loc, cap = 100) {
  const cur = h.stack[h.index];
  if (sameLoc(cur, loc)) return h;
  const stack = [...h.stack.slice(0, h.index + 1), { nodeId: loc.nodeId, path: loc.path }].slice(-cap);
  return { stack, index: stack.length - 1 };
}
export const canBack = (h) => h.index > 0;
export const canForward = (h) => h.index < h.stack.length - 1;
/** Step back/forward → { history, loc } (loc null when there is nowhere to go). */
export function histGo(h, delta) {
  const i = h.index + delta;
  if (i < 0 || i >= h.stack.length) return { history: h, loc: null };
  return { history: { ...h, index: i }, loc: h.stack[i] };
}
/** The current entry's path changed in place (a load resolved `~` to /Users/x): keep history on the real path. */
export function histReplace(h, loc) {
  if (h.index < 0) return histPush(h, loc);
  const stack = h.stack.slice();
  stack[h.index] = { nodeId: loc.nodeId, path: loc.path };
  return { ...h, stack };
}

// ------------------------------------------------------------------ kinds, icons, sorting, filtering

const KINDS = [
  [/\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i, 'image', '🖼'],
  [/\.svg$/i, 'SVG image', '🖼'],
  [/\.(mp4|mov|webm|mkv|avi|m4v)$/i, 'video', '🎞'],
  [/\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i, 'audio', '🎵'],
  [/\.pdf$/i, 'PDF document', '📕'],
  [/\.(zip|tar|tgz|gz|bz2|xz|7z|rar)$/i, 'archive', '🗜'],
  [/\.(md|markdown)$/i, 'Markdown document', '📝'],
  [/\.(txt|log|rtf)$/i, 'Plain Text', '📄'],
  [/\.(csv|tsv)$/i, 'CSV document', '📊'],
  [/\.json$/i, 'JSON', '🧾'],
  [/\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|sh|zsh|ps1|swift|kt|php|lua|sql|html|css|xml|ya?ml|toml|ini)$/i, 'source code', '📜'],
  [/\.(app|exe|dmg|pkg|deb|rpm|msi)$/i, 'application', '⚙'],
];

/** Finder's Kind column: "Folder", "PNG image", "Plain Text"… */
export function kindOf(e) {
  if (!e) return '';
  if (e.type === 'dir') return 'Folder';
  if (e.type === 'link') return 'Alias';
  const name = String(e.name || baseName(e.path));
  const ext = (/\.([^.]+)$/.exec(name)?.[1] || '').toUpperCase();
  const k = KINDS.find(([re]) => re.test(name));
  if (!k) return ext ? `${ext} file` : 'Document';
  return ['image', 'video', 'audio', 'archive', 'source code'].includes(k[1]) ? `${ext} ${k[1]}` : k[1];
}

export function iconOf(e) {
  if (!e) return '📄';
  if (e.type === 'dir') return '📁';
  if (e.type === 'link') return '🔗';
  return KINDS.find(([re]) => re.test(String(e.name || '')))?.[2] || '📄';
}

/** The sort to use after a click on a column header: the same column flips, another starts the way Finder does. */
export function nextSort(sort, key) {
  if (!SORT_KEYS.includes(key)) return sort;
  if (sort?.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'mtime' || key === 'size' ? 'desc' : 'asc' };
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base', numeric: true });

/** Entries in display order: folders first (Finder's "Keep folders on top"), then by the sort key; ties by name. */
export function sortEntries(entries = [], { key = 'name', dir = 'asc' } = {}, { foldersFirst = true } = {}) {
  const m = dir === 'desc' ? -1 : 1;
  const cmp = {
    name: byName,
    mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0),
    size: (a, b) => (a.type === 'dir' ? -1 : a.size || 0) - (b.type === 'dir' ? -1 : b.size || 0),
    kind: (a, b) => kindOf(a).localeCompare(kindOf(b)),
  }[key] || byName;
  return [...entries].sort((a, b) => (foldersFirst ? (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) : 0) || m * cmp(a, b) || byName(a, b));
}

/** The search box: a case-insensitive match on the name (every word must appear). */
export function filterEntries(entries = [], query = '') {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  return entries.filter((e) => { const n = String(e.name).toLowerCase(); return words.every((w) => n.includes(w)); });
}

/** "untitled folder", then "untitled folder 2", … — the first name not in `names`. */
export function uniqueName(base, names = []) {
  const taken = new Set([...names].map((n) => String(n).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** A name a rename may use: not empty, no path separators, not . or .. → the reason it can't, else ''. */
export function badName(name) {
  const n = String(name ?? '');
  if (!n.trim()) return 'A name is required.';
  if (/[\\/]/.test(n)) return 'A name can’t contain “/” or “\\”.';
  if (n === '.' || n === '..') return 'That name is reserved.';
  return '';
}

// ------------------------------------------------------------------ selection

export const selectAll = (paths) => ({ picked: [...paths], anchor: paths[0] ?? null });

/**
 * Arrow keys over the rows in display order. `cols` = items per row (1 in list/column views, the grid's width in
 * icon view): Up/Down move a row, Left/Right one item (icon view only). Shift extends from the anchor.
 * → { picked, anchor, focus } (focus = the item the keyboard is on now).
 */
export function arrowSelect({ picked = [], anchor = null, focus = null }, paths, key, { cols = 1, shift = false } = {}) {
  if (!paths.length) return { picked: [], anchor: null, focus: null };
  const step = { ArrowUp: -cols, ArrowDown: cols, ArrowLeft: cols > 1 ? -1 : 0, ArrowRight: cols > 1 ? 1 : 0, Home: -Infinity, End: Infinity }[key];
  if (step === undefined || step === 0) return { picked, anchor, focus };
  const from = paths.indexOf(focus ?? picked[picked.length - 1]);
  let i;
  if (from < 0) i = step > 0 ? 0 : paths.length - 1;
  else i = Math.max(0, Math.min(paths.length - 1, from + step));
  const to = paths[i];
  if (shift && anchor && paths.includes(anchor)) {
    const a = paths.indexOf(anchor);
    const [lo, hi] = a < i ? [a, i] : [i, a];
    return { picked: paths.slice(lo, hi + 1), anchor, focus: to };
  }
  return { picked: [to], anchor: to, focus: to };
}

/** Type-to-select: the first name (in display order) that starts with what was typed, else null. */
export function typeSelect(entries, typed) {
  const t = String(typed || '').toLowerCase();
  if (!t) return null;
  return entries.find((e) => String(e.name).toLowerCase().startsWith(t))?.path ?? null;
}

// ------------------------------------------------------------------ keyboard

/**
 * A keydown → the browser action it means, or '' (Finder's shortcuts; Ctrl stands in for ⌘ off a Mac).
 * `typing`: focus is in a text field — then only the window-level shortcuts that never edit text apply.
 */
export function shortcutFor(e, { typing = false } = {}) {
  if (!e) return '';
  const cmd = !!(e.metaKey || e.ctrlKey);
  const { shiftKey: shift, altKey: alt } = e;
  const code = e.code || '';
  const key = e.key || '';
  if (alt) return '';
  if (cmd && shift) {
    if (code === 'Period' || key === '.' || key === '>') return 'toggleHidden';
    if (code === 'KeyN' || key.toLowerCase() === 'n') return 'newFolder';
    if (code === 'KeyP' || key.toLowerCase() === 'p') return 'togglePreview';
    if (code === 'KeyG' || key.toLowerCase() === 'g') return 'goTo';
    return '';
  }
  if (cmd) {
    if (key === 'ArrowUp') return 'up';
    if (key === 'ArrowDown' || code === 'KeyO' || key.toLowerCase() === 'o') return typing ? '' : 'open';
    if (code === 'BracketLeft' || key === '[') return 'back';
    if (code === 'BracketRight' || key === ']') return 'forward';
    if (key === 'Backspace' || key === 'Delete') return typing ? '' : 'trash';
    if (code === 'KeyA' || key.toLowerCase() === 'a') return typing ? '' : 'selectAll';
    if (code === 'KeyF' || key.toLowerCase() === 'f') return 'find';
    if (key === '1' || code === 'Digit1') return 'view:icon';
    if (key === '2' || code === 'Digit2') return 'view:list';
    if (key === '3' || code === 'Digit3') return 'view:column';
    return '';
  }
  if (typing) return '';
  if (key === 'Enter' && !shift) return 'rename';
  if (key === 'F2') return 'rename';
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return 'arrow';
  return '';
}

// ------------------------------------------------------------------ preferences

export const PREFS_KEY = 'rigs.finder';
export const LIMITS = Object.freeze({ sidebar: [140, 360], preview: [200, 640] });
export const DEFAULT_PREFS = Object.freeze({ view: 'list', sort: { key: 'name', dir: 'asc' }, sidebarW: 190, previewW: 300, previewOpen: true });
const clamp = (n, [lo, hi], d) => (Number.isFinite(+n) ? Math.max(lo, Math.min(hi, Math.round(+n))) : d);

/** Saved preferences, repaired: unknown views and sorts fall back, widths stay in range. */
export function normalizePrefs(p) {
  const s = p && typeof p === 'object' ? p : {};
  const sort = s.sort && SORT_KEYS.includes(s.sort.key) ? { key: s.sort.key, dir: s.sort.dir === 'desc' ? 'desc' : 'asc' } : DEFAULT_PREFS.sort;
  return {
    view: VIEWS.includes(s.view) ? s.view : DEFAULT_PREFS.view, sort,
    sidebarW: clamp(s.sidebarW, LIMITS.sidebar, DEFAULT_PREFS.sidebarW),
    previewW: clamp(s.previewW, LIMITS.preview, DEFAULT_PREFS.previewW),
    previewOpen: s.previewOpen === undefined ? DEFAULT_PREFS.previewOpen : !!s.previewOpen,
  };
}
export function loadPrefs(storage) {
  try { return normalizePrefs(JSON.parse(storage?.getItem(PREFS_KEY) || 'null')); } catch { return normalizePrefs(null); }
}
export function savePrefs(storage, prefs) {
  const p = normalizePrefs(prefs);
  try { storage?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
  return p;
}

/** The status line under the files: "12 items", "3 of 12 selected", with the filter's count when one is on. */
export function statusText({ total = 0, shown = total, selected = 0, filtered = false } = {}) {
  const items = (n) => `${n} item${n === 1 ? '' : 's'}`;
  if (selected) return `${selected} of ${items(shown)} selected`;
  return filtered ? `${items(shown)} of ${total}` : items(total);
}
