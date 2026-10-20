import { api, fmtBytes, h, node, toast } from './api.js';
import { openWindow } from './wm.js';
import { isPhone } from './mobile.js';
import { nativeCtx, tagCtx } from './ctx-tag.js';
import { openFileTool } from './file-tools.js';
import { TOOLS, isZip, toolFor, toolsFor } from './file-tools-model.js';
import {
  SORT_LABELS, actionTargets, activeFavourite, arrowSelect, badName, baseName, canBack, canForward, clickSelect,
  columnPaths, crumbs, emptyHistory, filterEntries, histGo, histPush, histReplace, iconOf, joinPath, kindOf, loadPrefs,
  nextSort, normalizePrefs, parentOf, samePath, savePrefs, selectAll, shortcutFor, sidebarModel, sortEntries, statusText, typeSelect,
  uniqueName,
} from './finder-model.js';

const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
const TEXT = /\.(txt|md|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|sh|zsh|ps1|yml|yaml|toml|ini|cfg|conf|log|csv|html|css|xml|sql|env|gitignore|dockerfile)$/i;
const FILE_TYPE = 'application/x-rigs-file'; // what a dragged row carries (desktop.js and other file windows read it)
const storage = () => { try { return localStorage; } catch { return null; } };

// ------------------------------------------------------------------ preview pane slot
// The right-hand pane shows what is selected. A renderer draws into the pane's element and may return a cleanup
// (stop playback, drop object URLs) that runs before the next selection is drawn and when the window closes.
//   renderer(el, { entry, entries, nodeId, nodeName, rawUrl(path), actions }) → cleanup?
// entry = the one selected item (null with none or several), entries = every selected item. `actions` is the window's
// own: open, openWith, download, zip, unzip, rename, trash, terminalHere, copyTo, machines(). The default renderer
// below keeps the browser's earlier preview; setPreviewRenderer swaps in another for every file browser.
let previewRenderer = null;
export function setPreviewRenderer(fn) { previewRenderer = typeof fn === 'function' ? fn : null; }

/**
 * Finder-style file browser for every machine on the mesh (logic: finder-model.js): a sidebar with Favourites and
 * every rig (Locations), back/forward/enclosing folder, icon · list · column views, a search box, a path bar, Finder's
 * selection and keyboard shortcuts, and a preview pane (setPreviewRenderer). Keeps upload, download, rename, trash
 * (to ~/.rigs/trash), copy to another machine, zip/unzip, terminal here and the built-in file tools (file-tools.js).
 * `rigs()` → the mesh snapshot's nodes (every machine, offline ones too) for the sidebar; `machines()` → the online
 * ones for "Copy to machine"; `onNodeChange(id, name, prevId)` when the sidebar moves the window to another machine.
 */
export function openFiles({ nodeId, nodeName, path = '~', select = '', showHidden: hidden = false, machines = () => [], rigs = () => [], onTerminalHere, onNodeChange } = {}) {
  let rig = { id: nodeId, name: nodeName };
  let cur = { path, entries: [], parent: null, sep: '/', roots: [] };
  let shown = []; // cur.entries filtered + sorted: what the view shows, in order
  let showHidden = !!hidden;
  let sel = { picked: [], anchor: null, focus: null };
  let hist = emptyHistory();
  let prefs = loadPrefs(storage());
  let query = '';
  let closed = false;
  let seq = 0; // the newest load; an older answer arriving late is dropped
  let renaming = null; // the path being renamed in place
  let sheet = false; // phone: the preview sheet is up
  let sheetTimer = 0;
  const colCache = new Map(); // `${nodeId}|${path}` → entries of a column view folder above the current one
  let previewCleanup = null;
  let previewKey = '';

  // ---------------------------------------------------------------- DOM
  const btn = (label, title, onclick, extra = {}) => h('button', { type: 'button', class: 'tb fd-btn', title, 'aria-label': title, onclick, ...extra }, label);
  const backBtn = btn('‹', 'Back (⌘[)', () => goHistory(-1));
  const fwdBtn = btn('›', 'Forward (⌘])', () => goHistory(1));
  const upBtn = btn('⤒', 'Enclosing folder (⌘↑)', () => goUp());
  const drawerBtn = btn('☰', 'Show sidebar', () => setDrawer(!root.classList.contains('drawer-open')), { class: 'tb fd-btn fd-drawer-btn' });
  const titleEl = h('div', { class: 'fd-title', 'aria-live': 'polite' });
  const viewBtns = { icon: btn('▦', 'as Icons (⌘1)', () => setView('icon')), list: btn('☰', 'as List (⌘2)', () => setView('list')), column: btn('▥', 'as Columns (⌘3)', () => setView('column')) };
  const viewSeg = h('div', { class: 'fd-seg', role: 'group', 'aria-label': 'View' }, viewBtns.icon, viewBtns.list, viewBtns.column);
  const hiddenBtn = btn('◌', 'Show hidden files (⌘⇧.)', () => toggleHidden(), { 'aria-pressed': String(showHidden) });
  const previewBtn = btn('◨', 'Show preview (⌘⇧P)', () => togglePreview());
  const search = h('input', { class: 'fd-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search this folder', spellcheck: 'false', autocomplete: 'off' });
  const pathInput = h('input', { class: 'path-input', 'aria-label': 'Go to folder', spellcheck: 'false', autocomplete: 'off', placeholder: 'Go to folder: ~/Documents, /etc, @shared…' });
  const gotoBar = h('form', { class: 'fd-goto', hidden: true },
    pathInput, h('button', { type: 'submit', class: 'tb' }, 'Go'), h('button', { type: 'button', class: 'tb', onclick: () => showGoto(false) }, 'Cancel'));
  const upload = h('input', { type: 'file', multiple: true, 'aria-hidden': 'true', tabindex: '-1', style: { display: 'none' } });
  const toolbar = h('div', { class: 'fd-toolbar' },
    drawerBtn, h('div', { class: 'fd-nav' }, backBtn, fwdBtn), titleEl, h('div', { class: 'fd-spacer' }),
    viewSeg, upBtn,
    btn('＋', 'New folder (⌘⇧N)', () => newFolder()),
    btn('⇪', 'Upload files here', () => upload.click()),
    onTerminalHere ? btn('⌨', 'Terminal here', () => onTerminalHere(cur.path)) : null,
    hiddenBtn, previewBtn, search, upload);
  const side = h('nav', { class: 'fd-side', 'aria-label': 'Sidebar' });
  const content = h('div', { class: 'fd-content file-list', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Files' });
  const pathbar = h('div', { class: 'fd-pathbar' });
  const status = h('div', { class: 'fd-status' });
  const preview = h('aside', { class: 'fd-preview file-preview', 'aria-label': 'Preview' });
  const sheetClose = h('button', { type: 'button', class: 'fd-sheet-x', 'aria-label': 'Close preview', onclick: () => setSheet(false) }, '✕');
  const previewWrap = h('div', { class: 'fd-preview-wrap' }, sheetClose, preview);
  const splitL = h('div', { class: 'fd-split', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize sidebar', tabindex: '0' });
  const splitR = h('div', { class: 'fd-split fd-split-r', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize preview', tabindex: '0' });
  const scrim = h('div', { class: 'fd-scrim', onclick: () => setDrawer(false) });
  const main = h('div', { class: 'fd-main' }, toolbar, gotoBar, content, h('div', { class: 'fd-foot' }, pathbar, status));
  const root = h('div', { class: 'finder' }, side, splitL, main, splitR, previewWrap, scrim);

  const w = openWindow({
    title: `${rig.name} — files`, key: `files:${nodeId}`, icon: '📁', width: 1080, height: 620, className: 'files-win',
    onClose: () => { closed = true; clearTimeout(sheetTimer); runPreviewCleanup(); },
  });
  w.body.append(root);
  w.onCleanup(() => runPreviewCleanup());
  applyLayout();

  // ---------------------------------------------------------------- actions shared with the context menu
  const fileActions = {
    open: (e) => { if (e.type === 'dir') go({ nodeId: rig.id, path: e.path }); else { setSel({ picked: [e.path], anchor: e.path, focus: e.path }); setSheet(true); } },
    openWith: (e, tool) => openTool(e, tool),
    zip: (e) => zipItems(actionTargets(sel.picked, e.path)),
    unzip: (e) => unzipItem(e),
    download: (e) => download(e),
    rename: (e) => startRename(e.path),
    trash: (e) => trashItems(actionTargets(sel.picked, e.path), { ask: true }),
    copyTo: (e, m) => copyBetween(rig.id, rig.name, e.path, m.id, m.name, `~/Downloads/${e.name}`),
    terminalHere: onTerminalHere ? (p) => onTerminalHere(p) : undefined,
  };
  tagCtx(content, 'folder', nodeId, {
    get path() { return cur.path; },
    actions: {
      newFolder, upload: () => upload.click(), refresh: () => reload(), terminalHere: fileActions.terminalHere,
      toggleHidden: () => toggleHidden(), showHidden: () => showHidden,
    },
  });

  // ---------------------------------------------------------------- loading and navigation
  const listUrl = (id, p) => `${node(id)}/files?path=${encodeURIComponent(p)}${showHidden ? '&hidden=1' : ''}`;

  /** Load a place → true when it is shown. `push`: a new history entry (back/forward pass false). */
  async function go(loc, { push = true, select: pick = '', history: nextHist = null, keepSel = false } = {}) {
    const id = loc.nodeId || rig.id;
    const my = ++seq;
    let r;
    try { r = await api(listUrl(id, loc.path)); } catch (e) { if (my === seq) toast(`${nameOf(id)}: ${e.message}`, 'error'); return false; }
    if (my !== seq || closed) return false;
    if (id !== rig.id) switchRig(id);
    const moved = !samePath(r.path, cur.path);
    cur = r;
    colCache.set(`${rig.id}|${r.path}`, r.entries);
    if (nextHist) hist = histReplace(nextHist, { nodeId: rig.id, path: r.path });
    else if (push) hist = histPush(hist, { nodeId: rig.id, path: r.path });
    else hist = histReplace(hist, { nodeId: rig.id, path: r.path });
    if (moved && query) { query = ''; search.value = ''; }
    reshape();
    const pickPath = pick && cur.entries.find((x) => samePath(x.path, pick))?.path;
    if (pickPath) sel = { picked: [pickPath], anchor: pickPath, focus: pickPath };
    else if (!keepSel || moved) sel = { picked: [], anchor: null, focus: null };
    else sel = { ...sel, picked: sel.picked.filter((p) => shown.some((x) => x.path === p)) };
    renaming = null;
    render();
    if (pickPath) { scrollToSel(); setSheet(true); }
    return true;
  }
  const reload = (opts = {}) => go({ nodeId: rig.id, path: cur.path }, { push: false, keepSel: true, ...opts });
  function goHistory(d) {
    const r = histGo(hist, d);
    if (r.loc) go(r.loc, { history: r.history });
  }
  /** ⌘↑: the enclosing folder, with the folder we came from selected. */
  function goUp() {
    const up = cur.parent || parentOf(cur.path, cur.sep);
    if (up) go({ nodeId: rig.id, path: up }, { select: cur.path });
  }
  function switchRig(id) {
    const prev = rig.id;
    rig = { id, name: nameOf(id) };
    colCache.clear();
    onNodeChange?.(id, rig.name, prev);
  }
  const nameOf = (id) => (rigs() || []).find((n) => n.id === id)?.name || (id === rig.id ? rig.name : id);

  /** ui_open / Show in Files: go to a folder (on another machine when nodeId says so) and select `select` in it. */
  async function navigate(p, { select: pick = '', showHidden: hid, nodeId: id } = {}) {
    if (hid && !showHidden) { showHidden = true; colCache.clear(); }
    return go({ nodeId: id || rig.id, path: p }, { select: pick });
  }

  // ---------------------------------------------------------------- rendering
  function reshape() {
    shown = sortEntries(filterEntries(cur.entries, query), prefs.sort);
  }

  function render() {
    renderChrome();
    renderSidebar();
    renderView();
    renderPathbar();
    updatePreview();
  }

  function renderChrome() {
    const name = baseName(cur.path) || cur.path;
    titleEl.textContent = name;
    titleEl.title = cur.path;
    w.setTitle(`${rig.name} — ${name}`);
    backBtn.disabled = !canBack(hist);
    fwdBtn.disabled = !canForward(hist);
    upBtn.disabled = !(cur.parent || parentOf(cur.path, cur.sep));
    for (const [k, b] of Object.entries(viewBtns)) { b.classList.toggle('on', prefs.view === k); b.setAttribute('aria-pressed', String(prefs.view === k)); }
    hiddenBtn.classList.toggle('on', showHidden);
    hiddenBtn.setAttribute('aria-pressed', String(showHidden));
    previewBtn.classList.toggle('on', prefs.previewOpen);
    previewBtn.setAttribute('aria-pressed', String(prefs.previewOpen));
    pathInput.value = cur.path;
    root.dataset.view = prefs.view;
  }

  let sideSig = '';
  function renderSidebar(force = true) {
    const nodes = rigs() || [];
    const model = sidebarModel(nodes.length ? nodes : [{ id: rig.id, name: rig.name, online: true, rigs: true }], { current: rig.id });
    const fav = activeFavourite(model.favourites, cur.path);
    const sig = JSON.stringify([model.locations.map((l) => [l.id, l.name, l.badge, l.current]), fav, rig.id]);
    if (!force && sig === sideSig) return;
    sideSig = sig;
    const item = (attrs, icon, label, extra) => h('button', { type: 'button', class: 'fd-side-item', ...attrs }, h('span', { class: 'fd-si-icon', 'aria-hidden': 'true' }, icon), h('span', { class: 'fd-si-label' }, label), extra);
    side.replaceChildren(...kids(
      model.favourites.length ? h('div', { class: 'fd-side-sec' }, h('div', { class: 'fd-side-h' }, 'Favourites'),
        ...model.favourites.map((f) => item({ class: 'fd-side-item' + (f.id === fav ? ' on' : ''), 'data-fav': f.id, title: f.full || f.path, onclick: () => { setDrawer(false); go({ nodeId: rig.id, path: f.path }); } }, f.icon, f.label))) : null,
      h('div', { class: 'fd-side-sec' }, h('div', { class: 'fd-side-h' }, 'Locations'),
        ...model.locations.map((l) => {
          const b = item({
            class: 'fd-side-item rig' + (l.current ? ' on' : '') + (l.browsable ? '' : ' off'), 'data-node': l.id,
            title: l.browsable ? `${l.name} — browse its home folder` : `${l.name} is ${l.badge === 'offline' ? 'offline' : 'not running RIGS'}`,
            'aria-disabled': l.browsable ? null : 'true', 'aria-current': l.current ? 'true' : null,
            onclick: () => { if (!l.browsable) return; setDrawer(false); go({ nodeId: l.id, path: '~' }); },
          }, l.icon, l.name, h('span', { class: `fd-badge ${l.badge === 'online' ? 'up' : 'down'}`, title: l.badge, 'aria-label': l.badge }, l.badge === 'online' ? '' : l.badge));
          return tagCtx(b, 'node', l.id, { node: (rigs() || []).find((n) => n.id === l.id) });
        }))));
  }

  function renderView() {
    const focusIn = root.contains(document.activeElement) && document.activeElement !== search && document.activeElement !== pathInput;
    content.classList.toggle('empty', !shown.length);
    if (prefs.view === 'column') renderColumns();
    else if (prefs.view === 'icon') content.replaceChildren(...kids(h('div', { class: 'fd-grid' }, ...shown.map((e) => itemEl(e, 'tile'))), emptyNote()));
    else content.replaceChildren(...kids(listHead(), h('div', { class: 'fd-rows' }, ...shown.map((e) => itemEl(e, 'row'))), emptyNote()));
    status.textContent = statusText({ total: cur.entries.length, shown: shown.length, selected: sel.picked.length, filtered: !!query });
    if (focusIn && !root.contains(document.activeElement)) content.focus({ preventScroll: true });
  }
  const emptyNote = () => (shown.length ? null : h('div', { class: 'muted pad fd-empty' }, query ? `No items match “${query}”` : 'Empty folder'));

  function listHead() {
    return h('div', { class: 'fd-head', role: 'row' }, ...Object.entries(SORT_LABELS).map(([k, label]) => {
      const on = prefs.sort.key === k;
      return h('button', {
        type: 'button', class: `fd-hcell c-${k}` + (on ? ' on' : ''), 'aria-sort': on ? (prefs.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
        onclick: () => { prefs = savePrefs(storage(), { ...prefs, sort: nextSort(prefs.sort, k) }); reshape(); renderView(); },
      }, label, on ? h('span', { class: 'fd-sort', 'aria-hidden': 'true' }, prefs.sort.dir === 'asc' ? '▲' : '▼') : null);
    }));
  }

  /** One file or folder: a list row or an icon tile (both .file-row, so selection, menus and drags are the same). */
  function itemEl(e, kind, { inColumn = false, colIndex = -1, onPath = false } = {}) {
    const picked = !inColumn || colIndex === -1 ? sel.picked.includes(e.path) : false;
    const nameEl = h('span', { class: 'fn' }, e.name);
    const el = kind === 'tile'
      ? h('div', { class: 'file-row fd-tile' }, h('span', { class: 'fi' }, iconOf(e)), nameEl)
      : kind === 'col'
        ? h('div', { class: 'file-row fd-crow' }, h('span', { class: 'fi' }, iconOf(e)), nameEl, e.type === 'dir' ? h('span', { class: 'fd-chev', 'aria-hidden': 'true' }, '›') : null)
        : h('div', { class: 'file-row fd-row' },
          h('span', { class: 'c-name' }, h('span', { class: 'fi' }, iconOf(e)), nameEl),
          h('span', { class: 'fm c-mtime' }, e.mtime ? fmtDate(e.mtime) : '--'),
          h('span', { class: 'fs c-size' }, e.type === 'dir' ? '--' : fmtBytes(e.size)),
          h('span', { class: 'c-kind' }, kindOf(e)));
    el.classList.toggle('sel', picked);
    el.classList.toggle('on-path', onPath);
    el.classList.toggle('hidden-file', !!e.hidden);
    Object.assign(el, { title: e.path });
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(picked));
    el.dataset.path = e.path;
    el.draggable = true;
    el.addEventListener('click', (ev) => onItemClick(ev, e, { inColumn, colIndex }));
    el.addEventListener('dblclick', () => { if (!isPhone()) openEntry(e); }); // phones: the tap handler opens it
    el.addEventListener('dragstart', (ev) => ev.dataTransfer.setData(FILE_TYPE, JSON.stringify({ nodeId: rig.id, nodeName: rig.name, path: e.path, name: e.name })));
    if (renaming === e.path) nameEl.replaceChildren(renameInput(e));
    return tagCtx(el, 'file', e.path, {
      entry: e, actions: fileActions, zip: isZip(e.name),
      get machines() { return machines().filter((m) => m.id !== rig.id); },
      get tools() { return e.type === 'dir' ? [] : toolsFor(e.name).map((id) => TOOLS[id]); },
      get count() { return actionTargets(sel.picked, e.path).length; },
    });
  }

  function onItemClick(ev, e, { inColumn, colIndex }) {
    if (renaming) return;
    // Column view: a click in a column above the current folder goes there first (a folder opens as the next column).
    if (inColumn && colIndex >= 0) {
      if (e.type === 'dir') go({ nodeId: rig.id, path: e.path });
      else go({ nodeId: rig.id, path: parentOf(e.path, cur.sep) }, { select: e.path });
      return;
    }
    // Phones: a tap opens a folder; a tap on a file previews it in the sheet, a double tap (or a tap on it while
    // previewed) opens it. The sheet waits out the double-tap window, so the list doesn't move under the second tap.
    if (isPhone() && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey) {
      if (e.type === 'dir') { go({ nodeId: rig.id, path: e.path }); return; }
      const again = sel.picked.length === 1 && sel.picked[0] === e.path;
      if (again && (sheet || sheetTimer)) { clearTimeout(sheetTimer); sheetTimer = 0; openEntry(e); return; }
      setSel({ picked: [e.path], anchor: e.path, focus: e.path });
      clearTimeout(sheetTimer);
      sheetTimer = setTimeout(() => { sheetTimer = 0; if (!closed) { setSheet(true); scrollToSel(); } }, 320);
      return;
    }
    const next = clickSelect(sel, shown.map((x) => x.path), e.path, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey });
    setSel({ ...next, focus: e.path });
    if (prefs.view === 'column' && e.type === 'dir' && next.picked.length === 1 && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey) go({ nodeId: rig.id, path: e.path });
  }

  function renderColumns() {
    const roots = (cur.roots || []).map((r) => r.path);
    const paths = columnPaths(cur.path, { roots, sep: cur.sep });
    const cols = h('div', { class: 'fd-cols' });
    paths.forEach((p, i) => {
      const last = i === paths.length - 1;
      const entries = last ? shown : colCache.get(`${rig.id}|${p}`);
      const col = h('div', { class: 'fd-col' + (last ? ' cur' : ''), 'data-path': p });
      if (!entries) { col.append(h('div', { class: 'muted pad' }, '…')); fetchColumn(p); }
      else {
        const list = last ? entries : sortEntries(filterEntries(entries, ''), prefs.sort);
        const next = paths[i + 1];
        col.append(...list.map((e) => itemEl(e, 'col', { inColumn: !last, colIndex: last ? -1 : i, onPath: !!next && samePath(e.path, next) })));
        if (!list.length) col.append(h('div', { class: 'muted pad' }, last && query ? 'No matches' : 'Empty'));
      }
      cols.append(col);
    });
    content.replaceChildren(cols);
    requestAnimationFrame(() => {
      cols.scrollLeft = cols.scrollWidth;
      for (const c of cols.querySelectorAll('.fd-col')) c.querySelector('.on-path, .sel')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    });
  }
  const pending = new Set();
  async function fetchColumn(p) {
    const k = `${rig.id}|${p}`;
    if (pending.has(k)) return;
    pending.add(k);
    try { const r = await api(listUrl(rig.id, p)); colCache.set(k, r.entries); } catch { colCache.set(k, []); }
    pending.delete(k);
    if (!closed && prefs.view === 'column') renderView();
  }

  function renderPathbar() {
    const cs = crumbs(cur.path, { sep: cur.sep, rootName: rig.name });
    pathbar.replaceChildren(...kids(cs.flatMap((c, i) => [
      i ? h('span', { class: 'fd-crumb-sep', 'aria-hidden': 'true' }, '›') : null,
      h('button', { type: 'button', class: 'fd-crumb' + (i === cs.length - 1 ? ' cur' : ''), title: c.path, onclick: () => go({ nodeId: rig.id, path: c.path }) },
        h('span', { 'aria-hidden': 'true' }, i ? '📁' : '💻'), ' ', c.name),
    ])));
    requestAnimationFrame(() => { pathbar.scrollLeft = pathbar.scrollWidth; });
  }

  // ---------------------------------------------------------------- selection and preview
  function setSel(next) {
    sel = { picked: next.picked || [], anchor: next.anchor ?? null, focus: next.focus ?? next.anchor ?? null };
    for (const el of content.querySelectorAll('.file-row')) {
      const on = sel.picked.includes(el.dataset.path) && (prefs.view !== 'column' || el.closest('.fd-col.cur'));
      el.classList.toggle('sel', !!on);
      el.setAttribute('aria-selected', String(!!on));
    }
    status.textContent = statusText({ total: cur.entries.length, shown: shown.length, selected: sel.picked.length, filtered: !!query });
    updatePreview();
  }
  function scrollToSel() {
    requestAnimationFrame(() => content.querySelector('.file-row.sel')?.scrollIntoView?.({ block: 'nearest' }));
  }
  const selectedEntries = () => sel.picked.map((p) => cur.entries.find((x) => x.path === p)).filter(Boolean);

  function runPreviewCleanup() { try { previewCleanup?.(); } catch (e) { console.error(e); } previewCleanup = null; }
  function updatePreview(force = false) {
    const items = selectedEntries();
    const key = `${rig.id}|${items.map((x) => `${x.path}:${x.mtime}:${x.size}`).join(',')}`;
    if (!force && key === previewKey) return;
    previewKey = key;
    runPreviewCleanup();
    preview.replaceChildren();
    const entry = items.length === 1 ? items[0] : null;
    const ctx = {
      entry, entries: items, nodeId: rig.id, nodeName: rig.name, sep: cur.sep, folder: cur.path,
      rawUrl: (p) => `${node(rig.id)}/files/raw?path=${encodeURIComponent(p)}`,
      actions: { ...fileActions, open: (e) => openEntry(e), machines: () => machines().filter((m) => m.id !== rig.id) },
    };
    const r = (previewRenderer || defaultPreview)(preview, ctx);
    previewCleanup = typeof r === 'function' ? r : null;
    if (!items.length) setSheet(false);
  }

  /** The window's preview API (t3's renderer, or anything else, draws through setPreviewRenderer). */
  const setPreview = (entry) => {
    if (!entry) setSel({ picked: [], anchor: null });
    else setSel({ picked: [entry.path || entry], anchor: entry.path || entry });
  };

  function defaultPreview(el, { entry, entries }) {
    if (!entries.length) { el.append(h('div', { class: 'muted pad fd-pv-empty' }, h('div', { class: 'fd-pv-big', 'aria-hidden': 'true' }, '📁'), h('div', {}, baseName(cur.path)), h('div', { class: 'muted' }, statusText({ total: cur.entries.length })))); return; }
    if (!entry) return showMulti(el, entries);
    if (entry.type === 'dir') return showDirActions(el, entry);
    return showFilePreview(el, entry);
  }

  function actionsFor(e) {
    const others = machines().filter((m) => m.id !== rig.id);
    const send = h('select', { class: 'mini', 'aria-label': 'Copy to machine' }, h('option', { value: '' }, 'Copy to machine…'), ...others.map((m) => h('option', { value: m.id }, m.name)));
    send.addEventListener('change', () => {
      const m = others.find((x) => x.id === send.value);
      if (m) copyBetween(rig.id, rig.name, e.path, m.id, m.name, `~/Downloads/${e.name}`);
      send.value = '';
    });
    const tools = e.type === 'dir' ? [] : toolsFor(e.name);
    return h('div', { class: 'actions' },
      ...tools.map((id, i) => h('button', { class: 'btn' + (i ? '' : ' primary'), onclick: () => openTool(e, id) }, `${TOOLS[id].icon} ${i ? TOOLS[id].label : 'Open'}`)),
      e.type !== 'dir' && h('button', { class: 'btn', onclick: () => download(e) }, '⇩ Download'),
      h('button', { class: 'btn', onclick: () => zipItems([e.path]) }, '🗜 Zip'),
      isZip(e.name) && h('button', { class: 'btn', onclick: () => unzipItem(e) }, '📦 Extract'),
      h('button', { class: 'btn', onclick: () => startRename(e.path) }, '✎ Rename'),
      h('button', { class: 'btn danger', onclick: () => trashItems([e.path], { ask: true }) }, '🗑 Trash'),
      e.type !== 'dir' && others.length ? send : null);
  }
  const info = (e) => h('dl', { class: 'fd-info' },
    h('dt', {}, 'Kind'), h('dd', {}, kindOf(e)),
    e.type === 'dir' ? null : [h('dt', {}, 'Size'), h('dd', {}, fmtBytes(e.size))],
    h('dt', {}, 'Modified'), h('dd', {}, e.mtime ? new Date(e.mtime).toLocaleString() : '--'),
    h('dt', {}, 'Where'), h('dd', {}, `${rig.name}: ${parentOf(e.path, cur.sep) || e.path}`));

  function showDirActions(el, e) {
    el.append(h('div', { class: 'pad' },
      h('div', { class: 'fd-pv-big', 'aria-hidden': 'true' }, '📁'), h('div', { class: 'pv-title' }, e.name), info(e), actionsFor(e),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => go({ nodeId: rig.id, path: e.path }) }, 'Open folder'),
        onTerminalHere ? h('button', { class: 'btn', onclick: () => onTerminalHere(e.path) }, '⌨ Terminal here') : null)));
  }

  function showFilePreview(el, e) {
    el.append(h('div', { class: 'pad' }, h('div', { class: 'pv-title' }, iconOf(e), ' ', e.name), info(e), actionsFor(e)));
    const raw = `${node(rig.id)}/files/raw?path=${encodeURIComponent(e.path)}`;
    let alive = true;
    if (IMG.test(e.name)) el.append(h('img', { class: 'pv-img', src: raw, alt: e.name }));
    else if ((TEXT.test(e.name) || !/\.\w+$/.test(e.name)) && e.size < 2 * 1024 * 1024) {
      api(`${node(rig.id)}/files/read?path=${encodeURIComponent(e.path)}`)
        .then((r) => { if (alive) el.append(nativeCtx(h('pre', { class: 'pv-text' }, r.text.slice(0, 200000)))); }) // file text: the browser's menu (copy, search)
        .catch((err) => { if (alive) el.append(h('div', { class: 'muted pad' }, err.message)); });
    } else if (/\.(mp4|webm|mov)$/i.test(e.name)) el.append(h('video', { class: 'pv-img', src: raw, controls: true }));
    else if (/\.pdf$/i.test(e.name)) el.append(h('iframe', { class: 'pv-frame', src: raw, title: e.name }));
    return () => { alive = false; for (const m of el.querySelectorAll('video,audio')) { m.pause(); m.removeAttribute('src'); m.load?.(); } };
  }

  function showMulti(el, items) {
    const bytes = items.reduce((n, x) => n + (x.type === 'dir' ? 0 : x.size || 0), 0);
    const paths = items.map((x) => x.path);
    el.append(h('div', { class: 'pad' },
      h('div', { class: 'fd-pv-big', 'aria-hidden': 'true' }, '🗂'),
      h('div', { class: 'pv-title' }, `${items.length} items selected`),
      h('div', { class: 'muted' }, `${fmtBytes(bytes)} in files · ⌘-click to add or remove, Shift-click for a range`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => zipItems(paths) }, `🗜 Compress ${items.length} items to zip`),
        h('button', { class: 'btn danger', onclick: () => trashItems(paths, { ask: true }) }, `🗑 Move ${items.length} items to trash`))));
  }

  // ---------------------------------------------------------------- layout: panes, resizing, phone drawer/sheet
  function applyLayout() {
    root.style.setProperty('--fd-side-w', `${prefs.sidebarW}px`);
    root.style.setProperty('--fd-prev-w', `${prefs.previewW}px`);
    root.classList.toggle('no-preview', !prefs.previewOpen);
    root.dataset.view = prefs.view;
  }
  function setView(v) {
    if (v === prefs.view) return;
    prefs = savePrefs(storage(), { ...prefs, view: v });
    applyLayout();
    renderChrome();
    renderView();
    scrollToSel();
  }
  function togglePreview() {
    prefs = savePrefs(storage(), { ...prefs, previewOpen: !prefs.previewOpen });
    applyLayout();
    renderChrome();
    if (isPhone()) setSheet(prefs.previewOpen && sel.picked.length > 0);
  }
  function toggleHidden() {
    showHidden = !showHidden;
    colCache.clear();
    reload();
  }
  function setDrawer(open) { root.classList.toggle('drawer-open', !!open && isPhone()); drawerBtn.setAttribute('aria-expanded', String(!!open)); }
  function setSheet(open) { sheet = !!open && sel.picked.length > 0; root.classList.toggle('sheet-open', sheet); }

  /** Drag a separator to resize the sidebar or the preview; the width is remembered (and ←/→ on a focused one). */
  function resizer(el, which) {
    const field = which === 'side' ? 'sidebarW' : 'previewW';
    const set = (px, save) => {
      const next = { ...prefs, [field]: px };
      if (save) prefs = savePrefs(storage(), next);
      root.style.setProperty(which === 'side' ? '--fd-side-w' : '--fd-prev-w', `${normalizePrefs(next)[field]}px`);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      const x0 = e.clientX;
      const w0 = prefs[field];
      const dx = (ev) => (which === 'side' ? ev.clientX - x0 : x0 - ev.clientX);
      const move = (ev) => set(w0 + dx(ev), false);
      const up = (ev) => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); set(w0 + dx(ev), true); root.classList.remove('resizing'); };
      root.classList.add('resizing');
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      set(prefs[field] + (which === 'side' ? d : -d), true);
    });
  }
  resizer(splitL, 'side');
  resizer(splitR, 'preview');

  // ---------------------------------------------------------------- keyboard
  let typed = '';
  let typedAt = 0;
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = !!t.closest?.('input, textarea, select, [contenteditable="true"]');
    if (e.key === 'Escape') {
      if (t === search && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ''; onSearch(); content.focus(); return; }
      if (t === pathInput) { e.preventDefault(); e.stopPropagation(); showGoto(false); return; }
      if (root.classList.contains('drawer-open')) { e.preventDefault(); e.stopPropagation(); setDrawer(false); return; }
      if (sheet && isPhone()) { e.preventDefault(); e.stopPropagation(); setSheet(false); return; }
      return; // the window's Esc (close) stays as it was
    }
    if (t === search && e.key === 'ArrowDown') { e.preventDefault(); content.focus(); if (!sel.picked.length && shown[0]) setSel({ picked: [shown[0].path], anchor: shown[0].path }); return; }
    const inFiles = content.contains(t); // Enter, arrows and letters belong to the files; on a button they press it
    const action = shortcutFor(e, { typing });
    if (!action || ((action === 'rename' || action === 'arrow') && !inFiles)) {
      // Type-to-select: letters jump to the first name that starts with them.
      if (inFiles && !typing && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ') {
        typed = Date.now() - typedAt > 900 ? e.key : typed + e.key;
        typedAt = Date.now();
        const p = typeSelect(shown, typed);
        if (p) { setSel({ picked: [p], anchor: p, focus: p }); scrollToSel(); }
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    run(action, e);
  });

  function run(action, e = {}) {
    const one = selectedEntries().length === 1 ? selectedEntries()[0] : null;
    switch (action) {
      case 'back': return goHistory(-1);
      case 'forward': return goHistory(1);
      case 'up': return goUp();
      case 'open': return selectedEntries().forEach((x, i) => (x.type === 'dir' ? i === 0 && go({ nodeId: rig.id, path: x.path }) : openEntry(x)));
      case 'rename': return one && startRename(one.path);
      case 'trash': return sel.picked.length && trashItems([...sel.picked]);
      case 'newFolder': return newFolder();
      case 'selectAll': return setSel(selectAll(shown.map((x) => x.path)));
      case 'togglePreview': return togglePreview();
      case 'toggleHidden': return toggleHidden();
      case 'find': search.focus(); search.select(); return undefined;
      case 'goTo': return showGoto(true);
      case 'view:icon': return setView('icon');
      case 'view:list': return setView('list');
      case 'view:column': return setView('column');
      case 'arrow': return arrow(e);
      default: return undefined;
    }
  }

  function arrow(e) {
    // Column view: ← goes to the enclosing folder (this one selected), → opens the selected folder.
    if (prefs.view === 'column' && !e.shiftKey) {
      if (e.key === 'ArrowLeft') return goUp();
      if (e.key === 'ArrowRight') { const x = selectedEntries()[0]; if (x?.type === 'dir') go({ nodeId: rig.id, path: x.path }); return undefined; }
    }
    const next = arrowSelect(sel, shown.map((x) => x.path), e.key, { cols: prefs.view === 'icon' ? gridCols() : 1, shift: e.shiftKey });
    setSel(next);
    requestAnimationFrame(() => content.querySelector(`.file-row[data-path="${cssEsc(next.focus)}"]`)?.scrollIntoView?.({ block: 'nearest' }));
    return undefined;
  }
  /** Icon view: how many tiles fit on one row (for ↑/↓). */
  function gridCols() {
    const tiles = [...content.querySelectorAll('.fd-tile')];
    if (tiles.length < 2) return 1;
    const top = tiles[0].offsetTop;
    const n = tiles.findIndex((t) => t.offsetTop !== top);
    return n < 0 ? tiles.length : n;
  }
  const cssEsc = (s) => (globalThis.CSS?.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));

  // ---------------------------------------------------------------- search, go to folder
  function onSearch() {
    query = search.value.trim();
    reshape();
    sel = { ...sel, picked: sel.picked.filter((p) => shown.some((x) => x.path === p)) };
    renderView();
    updatePreview();
  }
  search.addEventListener('input', onSearch);
  function showGoto(on) {
    gotoBar.hidden = !on;
    if (on) { pathInput.value = cur.path; pathInput.focus(); pathInput.select(); } else content.focus();
  }
  gotoBar.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await go({ nodeId: rig.id, path: pathInput.value.trim() || '~' })) showGoto(false);
  });

  // ---------------------------------------------------------------- open, rename, new folder, trash, zip
  function openEntry(e) {
    if (e.type === 'dir') return go({ nodeId: rig.id, path: e.path });
    return toolFor(e.name) ? openTool(e) : download(e); // a file opens in the built-in tool for its type, else downloads
  }

  function openTool(e, tool) {
    const where = cur.path;
    return openFileTool({ nodeId: rig.id, nodeName: rig.name, path: e.path, name: e.name, tool, entries: cur.entries, onSaved: () => { if (samePath(where, cur.path)) reload(); } });
  }

  /** Finder's in-place rename: the name turns into a field; Enter saves, Esc cancels. */
  function startRename(p) {
    if (!cur.entries.some((x) => x.path === p)) return;
    renaming = p;
    if (!sel.picked.includes(p)) sel = { picked: [p], anchor: p, focus: p };
    renderView();
  }
  function renameInput(e) {
    const input = h('input', { class: 'fd-rename', value: e.name, 'aria-label': `Rename ${e.name}`, spellcheck: 'false' });
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = input.value;
      if (!save || name === e.name) { renderView(); content.focus(); return; }
      const why = badName(name);
      if (why) { toast(why, 'error'); renderView(); content.focus(); return; }
      if (cur.entries.some((x) => x.name === name)) { toast(`The name “${name}” is already taken. Please choose a different name.`, 'error'); renderView(); return; }
      const to = joinPath(parentOf(e.path, cur.sep) || cur.path, name, cur.sep);
      try { await api(`${node(rig.id)}/files/rename`, { method: 'POST', body: { from: e.path, to } }); await reload({ select: to }); }
      catch (err) { toast(err.message, 'error'); renderView(); }
      content.focus();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // the field's own keys: never the browser's or the window's shortcuts
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    input.addEventListener('dblclick', (ev) => ev.stopPropagation());
    requestAnimationFrame(() => { input.focus(); const dot = e.type === 'dir' ? -1 : e.name.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : e.name.length); });
    return input;
  }

  /** ⌘⇧N: an "untitled folder" here, selected and in rename. */
  async function newFolder() {
    const name = uniqueName('untitled folder', cur.entries.map((x) => x.name));
    const p = joinPath(cur.path, name, cur.sep);
    try {
      await api(`${node(rig.id)}/files/mkdir`, { method: 'POST', body: { path: p } });
      if (query) { query = ''; search.value = ''; }
      if (await reload({ select: p })) startRename(cur.entries.find((x) => x.name === name)?.path || p);
    } catch (e) { toast(e.message, 'error'); }
  }

  /** Move to ~/.rigs/trash on that machine (never unlinks). ⌘⌫ goes straight there, like Finder; menus ask first. */
  async function trashItems(paths, { ask = false } = {}) {
    if (!paths.length) return;
    const label = paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`;
    if (ask && !confirm(`Move ${label} on ${rig.name} to ~/.rigs/trash?`)) return;
    const failed = [];
    for (const p of paths) {
      try { await api(`${node(rig.id)}/files/trash`, { method: 'POST', body: { path: p } }); } catch (err) { failed.push(`${baseName(p)}: ${err.message}`); }
    }
    if (failed.length) toast(`Trash failed — ${failed.join('; ')}`, 'error', 9000);
    if (failed.length < paths.length) toast(`Moved ${paths.length - failed.length === 1 && paths.length === 1 ? label : `${paths.length - failed.length} items`} to the trash (~/.rigs/trash on ${rig.name})`, 'ok');
    // The row after the last trashed one keeps the keyboard where it was.
    const order = shown.map((x) => x.path);
    const after = order.slice(Math.max(...paths.map((p) => order.indexOf(p))) + 1).find((p) => !paths.includes(p)) || order.filter((p) => !paths.includes(p)).pop() || '';
    await reload({ select: after });
  }

  /** Zip the given paths into one archive next to them (a " (2)" suffix when the name is taken). */
  async function zipItems(paths) {
    if (!paths.length) return;
    toast(`Compressing ${paths.length === 1 ? baseName(paths[0]) : paths.length + ' items'}…`);
    try {
      const r = await api(`${node(rig.id)}/files/zip`, { method: 'POST', body: { paths } });
      toast(`Created ${baseName(r.path)} (${r.files} file${r.files === 1 ? '' : 's'}, ${fmtBytes(r.size)})`, 'ok');
      await reload(samePath(parentOf(r.path), cur.path) ? { select: r.path } : {});
    } catch (err) { toast(`Zip failed: ${err.message}`, 'error'); }
  }

  /** Extract an archive into a new folder beside it (named after it, suffixed when taken). */
  async function unzipItem(e) {
    toast(`Extracting ${e.name}…`);
    try {
      const r = await api(`${node(rig.id)}/files/unzip`, { method: 'POST', body: { path: e.path } });
      toast(`Extracted ${r.files} file${r.files === 1 ? '' : 's'} into ${baseName(r.path)}${r.renamed.length ? ` (${r.renamed.length} renamed to avoid overwriting)` : ''}`, 'ok', 7000);
      await reload(samePath(parentOf(r.path), cur.path) ? { select: r.path } : {});
    } catch (err) { toast(`Unzip failed: ${err.message}`, 'error', 9000); }
  }

  function download(e) {
    const a = h('a', { href: `${node(rig.id)}/files/raw?path=${encodeURIComponent(e.path)}&download=1`, download: e.name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------------------------------------------------------------- upload and drops
  upload.addEventListener('change', async () => {
    for (const f of upload.files) {
      try {
        await api(`${node(rig.id)}/files/write?path=${encodeURIComponent(joinPath(cur.path, f.name, cur.sep))}`, { method: 'PUT', body: f });
        toast(`Uploaded ${f.name} → ${rig.name}`, 'ok');
      } catch (e) { toast(`Upload failed: ${e.message}`, 'error'); }
    }
    upload.value = '';
    reload();
  });
  // Files from the desktop upload to the open folder; a row from another file window is copied here.
  main.addEventListener('dragover', (e) => { e.preventDefault(); content.classList.add('drop'); });
  main.addEventListener('dragleave', (e) => { if (!main.contains(e.relatedTarget)) content.classList.remove('drop'); });
  main.addEventListener('drop', async (e) => {
    e.preventDefault();
    content.classList.remove('drop');
    const remote = e.dataTransfer.getData(FILE_TYPE);
    if (remote) {
      const src = JSON.parse(remote);
      if (src.nodeId === rig.id && samePath(parentOf(src.path), cur.path)) return; // dropped where it already is
      await copyBetween(src.nodeId, src.nodeName, src.path, rig.id, rig.name, joinPath(cur.path, src.name, cur.sep));
      return reload();
    }
    for (const f of e.dataTransfer.files) {
      try { await api(`${node(rig.id)}/files/write?path=${encodeURIComponent(joinPath(cur.path, f.name, cur.sep))}`, { method: 'PUT', body: f }); }
      catch (err) { toast(`Upload failed: ${err.message}`, 'error'); }
    }
    return reload();
  });

  // The sidebar follows the mesh: a machine coming online or going away shows up within a few seconds.
  w.interval(() => { if (!closed) renderSidebar(false); }, 3000);

  navigate(path, { select });
  w.navigate = navigate;
  w.setPreview = setPreview;
  w.preview = preview;
  w.refreshPreview = () => updatePreview(true);
  Object.defineProperties(w, {
    closed: { get: () => closed }, path: { get: () => cur.path }, nodeId: { get: () => rig.id }, nodeName: { get: () => rig.name },
    view: { get: () => prefs.view }, selection: { get: () => [...sel.picked] },
  });
  return w;
}

/** replaceChildren would print a null as "null": drop the parts that are not there. */
const kids = (...parts) => parts.flat().filter((x) => x != null && x !== false);
const pad = (n) => String(n).padStart(2, '0');
/** Finder's Date Modified: "Today at 14:05", "Yesterday at 09:12", else the date and time. */
function fmtDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `Today at ${t}`;
  if (diff === 1) return `Yesterday at ${t}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} at ${t}`;
}

/** Stream a file from one machine to another through this gateway. */
export async function copyBetween(fromId, fromName, path, toId, toName, dest) {
  toast(`Copying ${path.split(/[\\/]/).pop()} ${fromName} → ${toName}…`);
  try {
    const src = await api(`${node(fromId)}/files/raw?path=${encodeURIComponent(path)}`, { raw: true });
    if (!src.ok) throw new Error(`read failed (${src.status})`);
    const blob = await src.blob();
    const r = await api(`${node(toId)}/files/write?path=${encodeURIComponent(dest)}`, { method: 'PUT', body: blob });
    toast(`Copied to ${toName}:${r.path} (${fmtBytes(r.size)})`, 'ok', 7000);
  } catch (e) { toast(`Copy failed: ${e.message}`, 'error'); }
}
