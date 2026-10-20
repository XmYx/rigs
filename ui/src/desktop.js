// Desktop mode: when the cloud is hidden, the shared folder (src/shared.js) shows as desktop icons on the plain
// background — files and folders with names and type glyphs (thumbnails for images), a sync badge, and a shortcut row
// for apps/, files/ and reports/. Double-click opens a file in its built-in tool (file-tools.js), an apps/<id> folder
// as its App Cloud app, any other folder in the RIGS file browser. Click / Ctrl / Shift / rubber band select; arrows,
// Enter, F2, Delete (to ~/.rigs/trash after a confirm). Drop OS files or folders to upload them (with progress), drag
// icons to rearrange (cells saved per machine + folder in localStorage), onto a folder to move them, into a file browser
// window to copy them there — and file-browser rows onto the desktop. Phones get a tap-to-open grid, long-press menu.
//
// It exists only while the cloud is hidden: setActive(false) removes the element and undoes every listener, timer and
// request through one disposer; nothing here uses requestAnimationFrame loops. Pure logic: desktop-model.js.
import { api, fmtBytes, h, node, toast } from './api.js';
import { tagCtx } from './ctx-tag.js';
import { createDisposer } from './cleanup.js';
import { isPhone } from './mobile.js';
import { openFileTool } from './file-tools.js';
import { copyBetween } from './files.js';
import { TOOLS, actionTargets, clickSelect, isZip, toolFor, toolsFor } from './file-tools-model.js';
import {
  CELL, appForFolder, arrowMove, crumbs, dropTarget, iconFor, joinPath, layoutIcons, listingSig, normRect, placeDrop,
  positionsKey, pruneSaved, renameSaved, rubberSelect, syncBadge, uploadTargets,
} from './desktop-model.js';

const POLL_MS = 3000;
const STATUS_MS = 10000;
const DESK_TYPE = 'application/x-rigs-desk';
const FILE_TYPE = 'application/x-rigs-file'; // what file browser rows carry (files.js)
const SHORTCUTS = [{ rel: '', label: 'Shared', icon: '🗂' }, { rel: 'apps', label: 'apps', icon: '▦' }, { rel: 'files', label: 'files', icon: '📄' }, { rel: 'reports', label: 'reports', icon: '📊' }];
// Fixed UI the icons keep clear of (when visible): panels, the top bar, chat, orb, the dock, the menu bar.
const OBSTACLES = 'body > .panel, body > .floating, #app-dock, #menubar, #bar, #panels-btn, #mb-tray-phone';

/**
 * deps: { store: { get, set }, self() → { id, name }, apps() → mesh apps, openApp(app), showInFiles(path, select?),
 * machines() → other online machines, confirm?(text) }. → { setActive(on), active, refresh(), stats() }
 */
export function createDesktopMode(deps) {
  let m = null; // the mounted desktop, or null
  const confirmFn = deps.confirm || ((t) => window.confirm(t));

  function mount() {
    const bin = createDisposer();
    const ac = new AbortController();
    bin.add(() => ac.abort());
    const self = () => deps.self?.() || { id: 'self', name: 'this machine' };
    const st = { status: null, root: '', sep: '/', folderRel: '', entries: [], sig: '', layout: {}, picked: [], anchor: null, blockedSig: '', area: null, blocked: [], phone: isPhone() };

    const crumbBox = h('span', { class: 'dt-crumbs' });
    const badge = h('button', { class: 'dt-badge idle', title: 'Shared folder sync — click to sync now', 'aria-label': 'Shared folder sync — sync now', onclick: () => syncNow() }, 'Shared folder sync');
    const upload = h('input', { type: 'file', multiple: true, 'aria-hidden': 'true', tabindex: '-1', style: { display: 'none' } });
    const shortcuts = h('span', { class: 'dt-shortcuts', role: 'toolbar', 'aria-label': 'Shared folder places' },
      ...SHORTCUTS.map((s) => h('button', { class: 'dt-short', 'data-rel': s.rel, title: s.rel ? `Show ${s.rel}/ of the shared folder on the desktop` : 'Show the top of the shared folder', onclick: () => go(s.rel) }, h('span', { 'aria-hidden': 'true' }, s.icon), ' ', s.label)));
    const head = h('div', { class: 'dt-head' }, shortcuts, crumbBox, badge,
      h('button', { class: 'dt-tb', title: 'Upload files to this folder', 'aria-label': 'Upload files', onclick: () => upload.click() }, '⇪'),
      h('button', { class: 'dt-tb', title: 'Show this folder in the file browser', 'aria-label': 'Show in Files', onclick: () => deps.showInFiles?.(folderAbs()) }, '↗'),
      upload);
    const area = h('div', { class: 'dt-area', role: 'listbox', 'aria-label': 'Shared folder', 'aria-multiselectable': 'true' });
    const band = h('div', { class: 'dt-band', hidden: true });
    const tray = h('div', { class: 'dt-uploads', role: 'status', 'aria-live': 'polite' });
    const hint = h('div', { class: 'dt-hint', hidden: true }, 'Drop files here to put them in the shared folder');
    const root = h('section', { id: 'desktop', class: 'desktop' + (st.phone ? ' phone' : ''), tabindex: '0', 'aria-label': 'Desktop — the shared folder synced across your machines' }, head, area, band, hint, tray);
    tagCtx(root, 'desktop', null); // the JARVIS background menu stays reachable under the folder's
    document.body.append(root);
    bin.add(() => root.remove());

    // ------------------------------------------------------------ data
    const folderAbs = () => (st.folderRel ? joinPath(st.root, st.folderRel.split('/').join(st.sep), st.sep) : st.root);
    const pathOf = (name) => joinPath(folderAbs(), name, st.sep);
    // Keyed on 'self', not the node id: the desktop always shows this daemon's folder (localStorage is per daemon
    // origin already), and the id only arrives with the first mesh snapshot, often after the first render.
    const savedKey = () => positionsKey('self', st.folderRel);
    const loadSaved = () => deps.store.get(savedKey(), {}) || {};
    const saveSaved = (s) => deps.store.set(savedKey(), s);

    async function loadStatus() {
      try {
        st.status = await api(`${node('self')}/shared`, { signal: ac.signal });
        st.root = st.status.path;
      } catch { if (ac.signal.aborted) return; st.status = null; }
      const b = syncBadge(st.status);
      badge.textContent = b.text;
      badge.className = `dt-badge ${b.tone}`;
      badge.title = `${b.title}\n\nClick to sync now`;
      badge.setAttribute('aria-label', `${b.text} — sync now`); // the name starts with what is shown (axe label-content-name-mismatch)
    }

    async function loadList({ force = false } = {}) {
      if (!st.root) return;
      let r;
      try { r = await api(`${node('self')}/files?path=${encodeURIComponent(folderAbs())}`, { signal: ac.signal }); }
      catch (e) {
        if (ac.signal.aborted) return;
        if (st.folderRel) { st.folderRel = ''; return loadList({ force: true }); } // the folder went away: back to the top
        area.replaceChildren(h('div', { class: 'dt-msg' }, `Shared folder: ${e.message}`));
        return;
      }
      st.sep = r.sep || '/';
      const entries = r.entries.filter((e) => !/\.rigs-upload-|^\.~lock\.|~$/.test(e.name));
      const sig = listingSig(entries);
      if (!force && sig === st.sig) return;
      st.sig = sig;
      st.entries = entries;
      const names = entries.map((e) => e.name);
      st.picked = st.picked.filter((n) => names.includes(n));
      render();
    }

    async function refresh() { await loadStatus(); await loadList({ force: true }); }

    function go(rel) {
      st.folderRel = rel;
      st.picked = [];
      st.anchor = null;
      st.sig = '';
      loadList({ force: true });
    }

    // ------------------------------------------------------------ layout + render
    /** The free area and the visible panels it has to keep clear of. */
    function measure() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const hr = head.getBoundingClientRect();
      const blocked = [];
      for (const el of document.querySelectorAll(OBSTACLES)) {
        if (el === root || root.contains(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
        blocked.push({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 });
      }
      const top = Math.max(hr.bottom + 8, 40);
      return { area: { x: 12, y: top, w: Math.max(CELL.w, vw - 24), h: Math.max(CELL.h, vh - top - 12) }, blocked };
    }

    function sortedNames() {
      const order = { apps: 0, files: 1, reports: 2 };
      return [...st.entries].sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1)
        || (st.folderRel ? 0 : (order[a.name] ?? 9) - (order[b.name] ?? 9))
        || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })).map((e) => e.name);
    }

    /** Phones: the grid sits between the buttons at the top and the chat / dock at the bottom, wherever they are. */
    function phoneBounds() {
      const vh = window.innerHeight;
      let top = 0;
      let bottom = vh;
      for (const el of document.querySelectorAll(OBSTACLES)) {
        if (el === root || root.contains(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.top < vh * 0.3 && r.bottom < vh * 0.4) top = Math.max(top, r.bottom);
        else if (r.top > vh * 0.5) bottom = Math.min(bottom, r.top);
      }
      root.style.setProperty('--dt-top', `${Math.round(top + 8)}px`);
      root.style.setProperty('--dt-area-top', `${Math.round(head.getBoundingClientRect().bottom + 8)}px`);
      root.style.setProperty('--dt-bottom', `${Math.round(vh - bottom + 8)}px`);
    }

    function relayout() {
      if (st.phone) { phoneBounds(); st.layout = {}; return; }
      const { area: a, blocked } = measure();
      st.area = a;
      st.blocked = blocked;
      st.blockedSig = JSON.stringify(blocked.map((b) => [Math.round(b.x / 8), Math.round(b.y / 8), Math.round(b.w / 8), Math.round(b.h / 8)]));
      const names = sortedNames();
      const saved = pruneSaved(loadSaved(), names);
      st.layout = layoutIcons(names, { area: a, saved, blocked });
    }

    const icons = new Map(); // name → element

    function render() {
      for (const b of shortcuts.children) b.classList.toggle('on', b.dataset.rel === st.folderRel);
      crumbBox.replaceChildren(...(st.folderRel ? crumbs(st.folderRel).slice(1).map((c) => h('span', { class: 'dt-crumb' }, '› ', c.label)) : []));
      relayout();
      icons.clear();
      const apps = deps.apps?.() || [];
      const kids = sortedNames().map((name) => {
        const e = st.entries.find((x) => x.name === name);
        const app = appForFolder(e, st.folderRel, apps, self());
        const look = iconFor(e, { app });
        const glyph = look.thumb
          ? h('img', { class: 'dt-thumb', alt: '', draggable: 'false', loading: 'lazy', src: `${node('self')}/files/raw?path=${encodeURIComponent(e.path)}&v=${Math.floor(e.mtime || 0)}` })
          : h('span', { class: 'dt-glyph', 'aria-hidden': 'true' }, look.glyph);
        const el = h('div', {
          class: 'dt-icon' + (st.picked.includes(name) ? ' sel' : '') + (app ? ' app' : ''), role: 'option', tabindex: '-1',
          'aria-selected': String(st.picked.includes(name)), 'data-name': name, draggable: st.phone ? 'false' : 'true',
          title: `${name}\n${look.kind}${e.type === 'dir' ? '' : ' · ' + fmtBytes(e.size)}${app ? ` · App Cloud: ${app.name}` : ''}`,
        }, glyph, h('span', { class: 'dt-name' }, name));
        const p = st.layout[name];
        if (p) Object.assign(el.style, { left: p.x + 'px', top: p.y + 'px' });
        el._entry = e;
        el._app = app;
        tagCtx(el, 'file', e.path, {
          entry: e, actions: fileActions, zip: isZip(e.name), openLabel: e.type === 'dir' ? (app ? 'Open app' : 'Open in Files') : 'Open',
          get machines() { return (deps.machines?.() || []).filter((x) => x.id !== self().id); },
          get tools() { return e.type === 'dir' ? [] : toolsFor(e.name).map((id) => TOOLS[id]); },
          get count() { return actionTargets(pickedPaths(), e.path).length; },
        });
        icons.set(name, el);
        return el;
      });
      area.replaceChildren(...kids);
      if (!kids.length) area.append(h('div', { class: 'dt-msg' }, st.folderRel ? `${st.folderRel}/ is empty — drop files here` : 'The shared folder is empty — drop files here'));
      tagCtx(area, 'folder', folderAbs(), {
        path: folderAbs(),
        actions: { newFolder, newTextFile, upload: () => upload.click(), refresh, showInFiles: () => deps.showInFiles?.(folderAbs()), syncNow },
      });
    }

    function paintSelection() {
      for (const [n, el] of icons) { const on = st.picked.includes(n); el.classList.toggle('sel', on); el.setAttribute('aria-selected', String(on)); }
    }
    const pickedPaths = () => st.picked.map(pathOf);
    const iconRects = () => [...icons].map(([name, el]) => { const r = el.getBoundingClientRect(); return { name, dir: el._entry.type === 'dir', x: r.left, y: r.top, w: r.width, h: r.height }; });

    // ------------------------------------------------------------ actions
    function openEntry(e, tool) {
      if (e.type === 'dir') {
        const app = appForFolder(e, st.folderRel, deps.apps?.() || [], self());
        if (app && !tool) return deps.openApp?.(app);
        return deps.showInFiles?.(e.path);
      }
      const t = tool || toolFor(e.name);
      if (t) return openFileTool({ nodeId: self().id, nodeName: self().name, path: e.path, name: e.name, tool: t, entries: st.entries, onSaved: () => loadList() });
      return download(e);
    }

    function download(e) {
      const a = h('a', { href: `${node('self')}/files/raw?path=${encodeURIComponent(e.path)}&download=1`, download: e.name });
      document.body.append(a);
      a.click();
      a.remove();
    }

    async function call(fn, okText) {
      try { const r = await fn(); if (okText) toast(okText, 'ok'); await loadList({ force: true }); return r; }
      catch (err) { toast(err.message, 'error'); return null; }
    }

    async function newFolder() {
      const name = prompt('New folder name', 'New folder');
      if (!name) return;
      await call(() => api(`${node('self')}/files/mkdir`, { method: 'POST', body: { path: pathOf(name) } }));
    }

    async function newTextFile() {
      const name = prompt('New text file name', 'Untitled.txt');
      if (!name) return;
      if (st.entries.some((e) => e.name === name)) { toast(`${name} already exists`, 'warn'); return; }
      const r = await call(() => api(`${node('self')}/files/text`, { method: 'POST', body: { path: pathOf(name), text: '' } }));
      if (r) openEntry({ type: 'file', name, path: r.path, size: 0, mtime: Date.now() }, 'text');
    }

    async function renameItem(e) {
      const name = prompt('Rename to', e.name);
      if (!name || name === e.name) return;
      const r = await call(() => api(`${node('self')}/files/rename`, { method: 'POST', body: { from: e.path, to: pathOf(name) } }));
      if (r) { saveSaved(renameSaved(loadSaved(), e.name, name)); st.picked = [name]; render(); }
    }

    async function trashItems(names) {
      if (!names.length) return;
      const what = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
      if (!confirmFn(`Move ${what} to ~/.rigs/trash? (The other machines move their copies to their trash too.)`)) return;
      for (const n of names) {
        try { await api(`${node('self')}/files/trash`, { method: 'POST', body: { path: pathOf(n) } }); }
        catch (err) { toast(`${n}: ${err.message}`, 'error'); }
      }
      toast(`Moved ${what} to the trash`, 'ok');
      st.picked = [];
      loadList({ force: true });
    }

    async function zipItems(paths) {
      const r = await call(() => api(`${node('self')}/files/zip`, { method: 'POST', body: { paths } }));
      if (r) toast(`Created ${r.path.split(/[\\/]/).pop()} (${fmtBytes(r.size)})`, 'ok');
    }

    async function unzipItem(e) {
      const r = await call(() => api(`${node('self')}/files/unzip`, { method: 'POST', body: { path: e.path } }));
      if (r) toast(`Extracted ${r.files} file${r.files === 1 ? '' : 's'} into ${r.path.split(/[\\/]/).pop()}`, 'ok');
    }

    /** Move desktop items into a folder of this folder. */
    async function moveInto(names, folder) {
      const dest = pathOf(folder);
      let moved = 0;
      for (const n of names) {
        if (n === folder) continue;
        try { await api(`${node('self')}/files/rename`, { method: 'POST', body: { from: pathOf(n), to: joinPath(dest, n, st.sep) } }); moved++; }
        catch (err) { toast(`${n}: ${err.message}`, 'error'); }
      }
      if (moved) toast(`Moved ${moved === 1 ? names.find((n) => n !== folder) : moved + ' items'} into ${folder}`, 'ok');
      st.picked = [];
      loadList({ force: true });
    }

    async function syncNow() {
      badge.textContent = 'Syncing…';
      badge.setAttribute('aria-label', 'Syncing…');
      badge.className = 'dt-badge idle';
      try { await api(`${node('self')}/shared/sync`, { method: 'POST', body: {}, signal: ac.signal }); } catch (e) { if (!ac.signal.aborted) toast(`Sync: ${e.message}`, 'error'); }
      await refresh();
    }

    const fileActions = {
      open: (e) => openEntry(e),
      openWith: (e, tool) => openEntry(e, tool),
      zip: (e) => zipItems(actionTargets(pickedPaths(), e.path)),
      unzip: (e) => unzipItem(e),
      download: (e) => download(e),
      rename: (e) => renameItem(e),
      trash: (e) => trashItems(st.picked.includes(e.name) ? [...st.picked] : [e.name]),
      copyTo: (e, mm) => copyBetween(self().id, self().name, e.path, mm.id, mm.name, `~/Downloads/${e.name}`),
      showInFiles: (e) => deps.showInFiles?.(folderAbs(), e.path),
    };

    // ------------------------------------------------------------ uploads (OS drops, the ⇪ button)
    function putFile(rel, file, onProgress) {
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('PUT', `${node('self')}/shared/file?path=${encodeURIComponent(rel)}`);
        x.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
        x.onload = () => { if (x.status >= 200 && x.status < 300) resolve(); else { let msg = `HTTP ${x.status}`; try { msg = JSON.parse(x.responseText).error || msg; } catch { /* plain */ } reject(new Error(msg)); } };
        x.onerror = () => reject(new Error('network error'));
        x.send(file);
      });
    }

    async function uploadAll(items, { at = null, folderRel = st.folderRel } = {}) {
      const list = uploadTargets(items, folderRel);
      if (!list.length) return;
      const total = list.reduce((s, x) => s + (x.file.size || 0), 0) || 1;
      let done = 0;
      const bar = h('i', {});
      const label = h('span', { class: 'dt-up-name' }, `Uploading ${list.length === 1 ? list[0].file.name : list.length + ' files'}…`);
      const row = h('div', { class: 'dt-up' }, label, h('span', { class: 'dt-up-bar' }, bar));
      tray.append(row);
      let failed = 0;
      for (const it of list) {
        try { await putFile(it.rel, it.file, (f) => { bar.style.width = `${Math.round(((done + f * it.file.size) / total) * 100)}%`; }); }
        catch (err) { failed++; toast(`${it.rel}: ${err.message}`, 'error'); }
        done += it.file.size || 0;
        bar.style.width = `${Math.round((done / total) * 100)}%`;
      }
      const ok = list.length - failed;
      label.textContent = failed ? `${ok} of ${list.length} uploaded` : `${list.length === 1 ? list[0].file.name : list.length + ' files'} uploaded`;
      row.classList.add(failed ? 'bad' : 'ok');
      setTimeout(() => row.remove(), 2500);
      // The first new top-level item lands where it was dropped.
      if (at && folderRel === st.folderRel && !st.phone) {
        const top = [...new Set(list.map((x) => x.rel.slice(folderRel ? folderRel.length + 1 : 0).split('/')[0]))];
        await loadList({ force: true });
        const fresh = top.filter((n) => st.layout[n]);
        if (fresh.length) { saveSaved({ ...loadSaved(), ...placeDrop(fresh, fresh[0], at, st.layout, { area: st.area, blocked: st.blocked }) }); render(); }
      } else await loadList({ force: true });
    }

    /** Files (and whole folders) from an OS drop, with their relative paths. Must start inside the drop event. */
    function dropped(dt) {
      const ents = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
      const plain = [...(dt.files || [])].map((f) => ({ path: f.name, file: f }));
      if (!ents.length) return Promise.resolve(plain);
      const out = [];
      const walk = async (ent, prefix) => {
        if (ent.isFile) { const f = await new Promise((res, rej) => ent.file(res, rej)); out.push({ path: prefix + f.name, file: f }); return; }
        if (!ent.isDirectory) return;
        const reader = ent.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const c of batch) await walk(c, `${prefix}${ent.name}/`);
        }
      };
      return (async () => { for (const e of ents) await walk(e, ''); return out.length ? out : plain; })();
    }

    // ------------------------------------------------------------ pointer: select, open, rubber band
    const iconOf = (t) => t?.closest?.('.dt-icon');
    bin.listen(area, 'click', (ev) => {
      const el = iconOf(ev.target);
      if (!el) return;
      const name = el.dataset.name;
      if (st.phone) { st.picked = [name]; paintSelection(); openEntry(el._entry); return; } // tap opens
      ({ picked: st.picked, anchor: st.anchor } = clickSelect({ picked: st.picked, anchor: st.anchor }, sortedNames(), name, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey }));
      paintSelection();
    });
    bin.listen(area, 'dblclick', (ev) => { const el = iconOf(ev.target); if (el && !st.phone) openEntry(el._entry); });

    let rubber = null;
    bin.listen(root, 'pointerdown', (ev) => {
      if (ev.target.closest('.dt-head, .dt-uploads')) return;
      root.focus({ preventScroll: true });
      if (iconOf(ev.target) || ev.button !== 0 || ev.pointerType !== 'mouse' || st.phone) return;
      rubber = { x: ev.clientX, y: ev.clientY, base: ev.ctrlKey || ev.metaKey || ev.shiftKey ? [...st.picked] : [], moved: false };
      try { root.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
    });
    bin.listen(root, 'pointermove', (ev) => {
      if (!rubber) return;
      const r = normRect(rubber.x, rubber.y, ev.clientX, ev.clientY);
      if (!rubber.moved && r.w + r.h < 6) return;
      rubber.moved = true;
      Object.assign(band.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      band.hidden = false;
      st.picked = [...new Set([...rubber.base, ...rubberSelect(r, iconRects())])];
      paintSelection();
    });
    const endRubber = () => {
      if (!rubber) return;
      if (!rubber.moved && !rubber.base.length) { st.picked = []; st.anchor = null; paintSelection(); } // a plain click on the background
      band.hidden = true;
      rubber = null;
    };
    bin.listen(root, 'pointerup', endRubber);
    bin.listen(root, 'pointercancel', endRubber);

    // ------------------------------------------------------------ keyboard (only while the desktop has focus)
    bin.listen(root, 'keydown', (ev) => {
      if (ev.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const k = ev.key;
      if (k.startsWith('Arrow')) {
        const grid = st.phone ? Object.fromEntries(sortedNames().map((n, i) => [n, { col: i % 4, row: Math.floor(i / 4) }])) : st.layout;
        const next = arrowMove(st.anchor && st.picked.includes(st.anchor) ? st.anchor : st.picked.at(-1), k, grid);
        if (next) { st.picked = [next]; st.anchor = next; paintSelection(); icons.get(next)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
        ev.preventDefault();
      } else if (k === 'Enter' && st.picked.length) {
        for (const n of st.picked.slice(0, 5)) { const e = st.entries.find((x) => x.name === n); if (e) openEntry(e); }
        ev.preventDefault();
      } else if ((k === 'Delete' || (k === 'Backspace' && (ev.metaKey || ev.ctrlKey))) && st.picked.length) {
        trashItems([...st.picked]);
        ev.preventDefault();
      } else if (k === 'F2' && st.picked.length === 1) {
        const e = st.entries.find((x) => x.name === st.picked[0]);
        if (e) renameItem(e);
        ev.preventDefault();
      } else if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'a') {
        st.picked = sortedNames();
        paintSelection();
        ev.preventDefault();
      } else if (k === 'Escape' && st.picked.length) {
        st.picked = [];
        paintSelection();
      }
    });

    // ------------------------------------------------------------ drag and drop
    let drag = null; // an icon drag that started here
    bin.listen(area, 'dragstart', (ev) => {
      const el = iconOf(ev.target);
      if (!el || st.phone) { ev.preventDefault(); return; }
      const name = el.dataset.name;
      if (!st.picked.includes(name)) { st.picked = [name]; st.anchor = name; paintSelection(); }
      const r = el.getBoundingClientRect();
      drag = { names: [...st.picked], anchor: name, dx: ev.clientX - r.left, dy: ev.clientY - r.top, folderRel: st.folderRel };
      ev.dataTransfer.setData(DESK_TYPE, JSON.stringify(drag));
      ev.dataTransfer.setData(FILE_TYPE, JSON.stringify({ nodeId: self().id, nodeName: self().name, path: el._entry.path, name })); // a file browser window copies it
      ev.dataTransfer.setData('text/plain', el._entry.path);
      ev.dataTransfer.effectAllowed = 'copyMove';
      root.classList.add('dragging');
    });
    bin.listen(area, 'dragend', () => { drag = null; root.classList.remove('dragging'); clearTarget(); });

    let targetEl = null;
    const clearTarget = () => { targetEl?.classList.remove('drop-into'); targetEl = null; };
    const accepts = (dt) => [...(dt?.types || [])].some((t) => t === 'Files' || t === DESK_TYPE || t === FILE_TYPE);
    bin.listen(root, 'dragover', (ev) => {
      if (!accepts(ev.dataTransfer) || ev.target.closest('.dt-head')) return;
      ev.preventDefault();
      const into = dropTarget({ x: ev.clientX, y: ev.clientY }, iconRects(), drag?.names || []);
      const el = into ? icons.get(into) : null;
      if (el !== targetEl) { clearTarget(); targetEl = el; el?.classList.add('drop-into'); }
      ev.dataTransfer.dropEffect = drag ? 'move' : 'copy';
      if (!drag) hint.hidden = false;
    });
    bin.listen(root, 'dragleave', (ev) => { if (!root.contains(ev.relatedTarget)) { clearTarget(); hint.hidden = true; } });
    bin.listen(root, 'drop', async (ev) => {
      if (!accepts(ev.dataTransfer)) return;
      ev.preventDefault();
      hint.hidden = true;
      const dt = ev.dataTransfer;
      const point = { x: ev.clientX, y: ev.clientY };
      const into = dropTarget(point, iconRects(), drag?.names || []);
      clearTarget();
      const desk = dt.getData(DESK_TYPE);
      if (desk) {
        const d = JSON.parse(desk);
        drag = null;
        root.classList.remove('dragging');
        if (d.folderRel !== st.folderRel) return;
        if (into) return moveInto(d.names, into);
        // Rearrange: the grabbed icon goes to the cell its top-left lands in (measured from the cell's centre).
        const at = { x: point.x - d.dx + CELL.w / 2, y: point.y - d.dy + CELL.h / 2 };
        saveSaved({ ...loadSaved(), ...placeDrop(d.names, d.anchor, at, st.layout, { area: st.area, blocked: st.blocked }) });
        render();
        return;
      }
      const intoRel = into ? [st.folderRel, into].filter(Boolean).join('/') : st.folderRel;
      const fromBrowser = dt.getData(FILE_TYPE);
      if (fromBrowser) {
        const src = JSON.parse(fromBrowser);
        const destDir = into ? pathOf(into) : folderAbs();
        await copyBetween(src.nodeId, src.nodeName, src.path, self().id, self().name, joinPath(destDir, src.name, st.sep));
        await loadList({ force: true });
        if (!into && st.layout[src.name] && !st.phone) { saveSaved({ ...loadSaved(), ...placeDrop([src.name], src.name, point, st.layout, { area: st.area, blocked: st.blocked }) }); render(); }
        return;
      }
      const items = await dropped(dt);
      await uploadAll(items, { at: into ? null : point, folderRel: intoRel });
    });

    bin.listen(upload, 'change', async () => {
      const files = [...upload.files].map((f) => ({ path: f.name, file: f }));
      upload.value = '';
      await uploadAll(files);
    });

    // ------------------------------------------------------------ refresh: poll while visible, relayout on resize
    let resizeT = null;
    bin.listen(window, 'resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { st.phone = isPhone(); root.classList.toggle('phone', st.phone); render(); }, 150);
    });
    bin.add(() => clearTimeout(resizeT));
    bin.interval(() => {
      if (document.hidden) return;
      loadList();
      // A panel moved, opened or closed: icons placed automatically make room (saved ones stay where they are).
      if (!st.phone && st.root) { const before = st.blockedSig; relayout(); if (st.blockedSig !== before) render(); }
    }, POLL_MS);
    bin.interval(() => { if (!document.hidden) loadStatus(); }, STATUS_MS);
    bin.listen(document, 'visibilitychange', () => { if (!document.hidden) refresh(); });

    refresh();
    return { root, bin, refresh, state: st };
  }

  return {
    setActive(on) {
      if (on && !m) m = mount();
      else if (!on && m) { m.bin.dispose(); m = null; }
    },
    get active() { return !!m; },
    refresh: () => m?.refresh(),
    /** For checks: is it mounted, and how many listeners/timers it holds. */
    stats: () => ({ mounted: !!m, disposables: m ? m.bin.size : 0, inDom: !!document.getElementById('desktop') }),
  };
}
