// Desktop mode's pure logic (ui/src/desktop.js draws it; tested in test/desktop-mode.test.js). No DOM, no imports.
//
// The desktop shows a folder of the shared folder (src/shared.js) as icons on a grid. Positions are grid cells
// ({ col, row }), saved per machine + folder, so they survive reloads and window resizes. Cells that overlap a visible
// panel (the inspector, filters, chat, the dock — `blocked` rects) are skipped when icons are placed automatically.

export const CELL = Object.freeze({ w: 96, h: 100 });

/** a and b ({ x, y, w, h }) overlap (touching edges do not count). */
export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The rectangle between two points, whatever direction the drag went. */
export function normRect(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** How many columns and rows of `cell` fit in `area` (at least one of each). */
export function gridOf(area, cell = CELL) {
  return { cols: Math.max(1, Math.floor(area.w / cell.w)), rows: Math.max(1, Math.floor(area.h / cell.h)) };
}

/** Top-left of a cell in page pixels. */
export const cellXY = (col, row, area, cell = CELL) => ({ x: area.x + col * cell.w, y: area.y + row * cell.h });

/** The cell under a page point, clamped into the grid. */
export function cellAt(x, y, area, cell = CELL) {
  const { cols, rows } = gridOf(area, cell);
  const clamp = (v, n) => Math.max(0, Math.min(n - 1, v));
  return { col: clamp(Math.floor((x - area.x) / cell.w), cols), row: clamp(Math.floor((y - area.y) / cell.h), rows) };
}

/** Does a panel cover (part of) this cell? A few pixels of overlap are forgiven. */
export function cellBlocked(col, row, area, cell = CELL, blocked = []) {
  const p = cellXY(col, row, area, cell);
  const r = { x: p.x + 6, y: p.y + 6, w: cell.w - 12, h: cell.h - 12 };
  return blocked.some((b) => b && overlaps(r, b));
}

const key = (c, r) => `${c},${r}`;

/**
 * Where every icon goes: { [name]: { col, row, x, y } }. Saved cells are kept when they are inside the grid, free
 * and not under a panel; everything else fills the free cells column by column from the top-left, in `names` order.
 * When the grid is full, icons continue in extra columns to the right (the desktop scrolls) rather than overlap.
 */
export function layoutIcons(names, { area, cell = CELL, saved = {}, blocked = [] } = {}) {
  const { cols, rows } = gridOf(area, cell);
  const used = new Set();
  const out = {};
  const free = (c, r) => !used.has(key(c, r)) && !cellBlocked(c, r, area, cell, blocked);
  const put = (name, c, r) => { used.add(key(c, r)); out[name] = { col: c, row: r, ...cellXY(c, r, area, cell) }; };
  for (const n of names) {
    const s = saved[n];
    if (s && Number.isInteger(s.col) && Number.isInteger(s.row) && s.col >= 0 && s.row >= 0 && s.col < cols && s.row < rows && free(s.col, s.row)) put(n, s.col, s.row);
  }
  let c = 0;
  let r = 0;
  const next = () => { r++; if (r >= rows) { r = 0; c++; } };
  for (const n of names) {
    if (out[n]) continue;
    // Past the grid's last column there are no panels to dodge: an extra column always has room.
    let guard = 0;
    while (!(free(c, r) || (c >= cols && !used.has(key(c, r)))) && guard++ < 100000) next();
    put(n, c, r);
    next();
  }
  return out;
}

/** The free cell nearest to (col, row) — itself when free — searching rings outward. */
export function nearestFree(col, row, { cols, rows }, isFree) {
  if (isFree(col, row)) return { col, row };
  for (let d = 1; d < cols + rows; d++) {
    let best = null;
    for (let c = col - d; c <= col + d; c++) {
      for (let r = row - d; r <= row + d; r++) {
        if (Math.max(Math.abs(c - col), Math.abs(r - row)) !== d || c < 0 || r < 0 || c >= cols || r >= rows || !isFree(c, r)) continue;
        const dist = (c - col) ** 2 + (r - row) ** 2;
        if (!best || dist < best.dist) best = { col: c, row: r, dist };
      }
    }
    if (best) return { col: best.col, row: best.row };
  }
  return null;
}

/**
 * Icons dragged on the desktop and dropped at a point: the grabbed icon (`anchor`) lands in the cell under the point,
 * the others keep their offsets from it; any that would land on a panel, off the grid or on an icon that stays put
 * take the nearest free cell. `positions` = layoutIcons' output. → new saved cells for the moved icons only.
 */
export function placeDrop(moved, anchor, point, positions, { area, cell = CELL, blocked = [] } = {}) {
  const grid = gridOf(area, cell);
  const target = cellAt(point.x, point.y, area, cell);
  const from = positions[anchor] || target;
  const staying = new Set(Object.entries(positions).filter(([n]) => !moved.includes(n)).map(([, p]) => key(p.col, p.row)));
  const taken = new Set();
  const isFree = (c, r) => !staying.has(key(c, r)) && !taken.has(key(c, r)) && !cellBlocked(c, r, area, cell, blocked);
  const out = {};
  // The anchor first, so it gets the cell that was pointed at.
  for (const n of [anchor, ...moved.filter((x) => x !== anchor)]) {
    const p = positions[n] || from;
    const want = { col: target.col + (p.col - from.col), row: target.row + (p.row - from.row) };
    const inGrid = want.col >= 0 && want.row >= 0 && want.col < grid.cols && want.row < grid.rows;
    const got = inGrid && isFree(want.col, want.row) ? want
      : nearestFree(Math.max(0, Math.min(grid.cols - 1, want.col)), Math.max(0, Math.min(grid.rows - 1, want.row)), grid, isFree);
    if (!got) continue;
    taken.add(key(got.col, got.row));
    out[n] = { col: got.col, row: got.row };
  }
  return out;
}

/**
 * What a drop at `point` lands on: the folder icon under it (not one of the dragged icons) → its name, else null
 * (the desktop itself). icons: [{ name, dir, x, y, w, h }].
 */
export function dropTarget(point, icons, dragged = []) {
  for (const i of icons) {
    if (!i.dir || dragged.includes(i.name)) continue;
    if (point.x >= i.x && point.x < i.x + i.w && point.y >= i.y && point.y < i.y + i.h) return i.name;
  }
  return null;
}

/** Icons a rubber band touches → names. */
export const rubberSelect = (rect, icons) => icons.filter((i) => overlaps(rect, i)).map((i) => i.name);

const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Arrow-key navigation: the icon nearest `from` in that direction (straight lines first), or `from` when there is
 * none; the first icon by position when nothing is selected yet. positions: { name: { col, row } }.
 */
export function arrowMove(from, keyName, positions) {
  const d = DIRS[keyName];
  const names = Object.keys(positions);
  if (!d || !names.length) return from ?? null;
  const p = positions[from];
  if (!p) return [...names].sort((a, b) => positions[a].col - positions[b].col || positions[a].row - positions[b].row)[0];
  let best = null;
  for (const n of names) {
    if (n === from) continue;
    const q = positions[n];
    const along = (q.col - p.col) * d[0] + (q.row - p.row) * d[1];
    if (along <= 0) continue;
    const across = Math.abs((q.col - p.col) * d[1]) + Math.abs((q.row - p.row) * d[0]);
    const score = along + across * 3;
    if (!best || score < best.score) best = { n, score };
  }
  return best ? best.n : from;
}

const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const GLYPHS = [
  [/\.pdf$/i, '📕', 'PDF'], [/\.(csv|tsv)$/i, '📊', 'CSV'], [/\.json$/i, '🧾', 'JSON'], [/\.(zip|tgz|gz|7z|rar|tar)$/i, '🗜', 'Archive'],
  [/\.(md|markdown|txt|log|rtf)$/i, '📝', 'Text'], [/\.(html?|css)$/i, '🌐', 'Web page'],
  [/\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|sh|ps1|sql|yml|yaml|toml|ini)$/i, '📜', 'Code'],
  [/\.(mp4|webm|mov|mkv)$/i, '🎞', 'Video'], [/\.(mp3|wav|ogg|flac|m4a)$/i, '🎵', 'Audio'],
];

/**
 * How an entry looks: { glyph, kind, thumb } — thumb: draw the image itself (images up to `maxThumb` bytes).
 * `app`: a registered App Cloud app this folder is (apps/<id>).
 */
export function iconFor(entry, { app = null, maxThumb = 8 * 1024 * 1024 } = {}) {
  if (entry.type === 'dir') return app ? { glyph: app.icon || '▦', kind: 'App', thumb: false } : { glyph: '📁', kind: 'Folder', thumb: false };
  if (IMG.test(entry.name)) return { glyph: '🖼', kind: 'Image', thumb: (entry.size || 0) <= maxThumb };
  for (const [re, glyph, kind] of GLYPHS) if (re.test(entry.name)) return { glyph, kind, thumb: false };
  return { glyph: '📄', kind: 'File', thumb: false };
}

/** The App Cloud app an apps/<id> folder is: a registered app on this machine whose id is the folder name. */
export function appForFolder(entry, folderRel, apps = [], self = {}) {
  if (entry?.type !== 'dir' || folderRel !== 'apps') return null;
  const id = String(entry.name).toLowerCase();
  return apps.find((a) => String(a.id).toLowerCase() === id && (a.nodeId === self.id || a.node === self.name)) || null;
}

/** 'apps/web' from the shared root + a full path (any separator); '' for the root itself, null when outside it. */
export function relPath(root, full) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const f = norm(full);
  if (f === r) return '';
  return f.startsWith(r + '/') ? f.slice(r.length + 1) : null;
}

/** A child path with the machine's separator. */
export const joinPath = (dir, name, sep = '/') => `${String(dir).replace(/[\\/]+$/, '')}${sep}${name}`;

/** The positions store key: per machine and folder of the shared folder. */
export const positionsKey = (nodeId, folderRel = '') => `desktop.pos.${nodeId || 'self'}.${folderRel || '.'}`;

/** Saved positions after a rename (same cell, new name) and without entries that no longer exist. */
export function renameSaved(saved, from, to) {
  if (!saved?.[from]) return { ...saved };
  const { [from]: p, ...rest } = saved;
  return { ...rest, [to]: p };
}
export const pruneSaved = (saved, names) => Object.fromEntries(Object.entries(saved || {}).filter(([n]) => names.includes(n)));

/** A cheap fingerprint of a listing, to skip re-rendering when a poll finds nothing new. */
export const listingSig = (entries = []) => entries.map((e) => `${e.name}|${e.type}|${e.size}|${Math.floor(e.mtime || 0)}`).sort().join('\n');

function agoText(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

/**
 * The sync badge from GET /api/local/shared: { text, tone: ok | warn | bad | idle, title }. Peers that are offline or
 * on an older RIGS don't make it red; an error on a reachable peer does.
 */
export function syncBadge(st, now = Date.now()) {
  if (!st) return { text: 'Shared folder unavailable', tone: 'bad', title: 'This machine did not answer /api/local/shared' };
  const peers = st.peers || [];
  const live = peers.filter((p) => p.state !== 'offline' && p.state !== 'unsupported');
  const bad = live.filter((p) => p.state === 'error');
  const synced = live.filter((p) => p.state === 'synced' || p.state === 'partial');
  const when = st.lastSync ? agoText(st.lastSync, now) : 'not yet';
  const title = [`${st.path}`, ...peers.map((p) => `${p.node}: ${p.state}${p.lastSync ? ` · ${agoText(p.lastSync, now)}` : ''}${p.error ? ` · ${p.error}` : ''}`)].join('\n');
  if (st.syncing) return { text: 'Syncing…', tone: 'idle', title };
  if (bad.length) return { text: `Sync error · ${bad.map((p) => p.node).join(', ')}`, tone: 'bad', title };
  if (!peers.length) return { text: `Local only · scanned ${when}`, tone: 'idle', title };
  if (!live.length) return { text: `Peers offline · ${when}`, tone: 'warn', title };
  return { text: `Synced ${when} · ${synced.length}/${live.length} peer${live.length === 1 ? '' : 's'}`, tone: synced.length === live.length ? 'ok' : 'warn', title };
}

/**
 * Files dropped from the OS, flattened with their place under the drop folder: [{ rel, file }] from
 * [{ path: 'photos/a.jpg' | 'a.jpg', file }]. Paths with '..' or empty parts are dropped (the server refuses them too).
 */
export function uploadTargets(items, folderRel = '') {
  const out = [];
  for (const it of items || []) {
    const parts = String(it.path || it.file?.name || '').split(/[\\/]+/).filter((p) => p && p !== '.');
    if (!parts.length || parts.some((p) => p === '..')) continue;
    out.push({ rel: [folderRel, ...parts].filter(Boolean).join('/'), file: it.file });
  }
  return out;
}

/** Breadcrumb of a folder under the shared root: [{ label, rel }] from the root. */
export function crumbs(folderRel = '', rootLabel = 'Shared') {
  const parts = String(folderRel || '').split('/').filter(Boolean);
  return [{ label: rootLabel, rel: '' }, ...parts.map((p, i) => ({ label: p, rel: parts.slice(0, i + 1).join('/') }))];
}
