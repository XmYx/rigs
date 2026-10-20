import { ago, api, fmtBytes, h, node, toast } from './api.js';
import { openWindow } from './wm.js';
import { nativeCtx, tagCtx } from './ctx-tag.js';
import { openFileTool } from './file-tools.js';
import { TOOLS, actionTargets, clickSelect, isZip, toolFor, toolsFor } from './file-tools-model.js';

const ICON = { dir: '📁', file: '📄', link: '🔗' };
const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
const TEXT = /\.(txt|md|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|sh|zsh|ps1|yml|yaml|toml|ini|cfg|conf|log|csv|html|css|xml|sql|env|gitignore|dockerfile)$/i;

/**
 * File browser for any machine, with upload, download, rename, trash, copy-to-another-machine, zip/unzip and the
 * built-in file tools (file-tools.js: double-click opens a file in the tool for its type, "Open with" picks one).
 * Ctrl/⌘-click and Shift-click select several rows (zip takes the whole selection).
 */
export function openFiles({ nodeId, nodeName, path = '~', select = '', showHidden: hidden = false, machines = () => [], onTerminalHere } = {}) {
  let cur = { path, entries: [], parent: null, sep: '/' };
  let showHidden = !!hidden;
  let picked = []; // selected rows' paths (Ctrl/⌘ / Shift-click add); the preview shows the last one clicked
  let anchor = null;
  let closed = false;

  const pathInput = h('input', { class: 'path-input', 'aria-label': 'Folder path', value: path, spellcheck: 'false' });
  const list = h('div', { class: 'file-list' });
  const preview = h('div', { class: 'file-preview' }, h('div', { class: 'muted pad' }, 'Select a file to preview it.'));
  const rootsSel = h('select', { class: 'mini', title: 'Roots' });
  const upload = h('input', { type: 'file', multiple: true, 'aria-hidden': 'true', tabindex: '-1', style: { display: 'none' } });

  const w = openWindow({
    title: `${nodeName} — files`, key: `files:${nodeId}`, icon: '📁', width: 980, height: 560, className: 'files-win',
    tools: [rootsSel], onClose: () => { closed = true; },
  });
  const hiddenBox = h('input', { type: 'checkbox', checked: showHidden, onchange: (e) => { showHidden = e.target.checked; load(cur.path); } });
  const toolbar = h('div', { class: 'toolbar' },
    h('button', { class: 'tb', title: 'Up', onclick: () => cur.parent && load(cur.parent) }, '↑'),
    h('button', { class: 'tb', title: 'Home', onclick: () => load('~') }, '⌂'),
    h('button', { class: 'tb', title: 'Refresh', onclick: () => load(cur.path) }, '↻'),
    pathInput,
    h('button', { class: 'tb', title: 'New folder', onclick: newFolder }, '＋📁'),
    h('button', { class: 'tb', title: 'Upload files here', onclick: () => upload.click() }, '⇪ Upload'),
    h('button', { class: 'tb', title: 'Terminal here', onclick: () => onTerminalHere?.(cur.path) }, '⌨'),
    h('label', { class: 'tb check' }, hiddenBox, ' hidden'),
    upload);
  w.body.append(toolbar, h('div', { class: 'files-split' }, list, preview));

  // Right-click / long-press (contextmenu.js): a row is a file or folder, the empty list is the current folder.
  const fileActions = {
    open: (e) => { if (e.type === 'dir') load(e.path); else { picked = [e.path]; anchor = e.path; render(); showPreview(e); } },
    openWith: (e, tool) => openTool(e, tool),
    zip: (e) => zipItems(actionTargets(picked, e.path)),
    unzip: (e) => unzipItem(e),
    download: (e) => download(e),
    rename: (e) => renameItem(e),
    trash: (e) => trashItem(e),
    copyTo: (e, m) => copyBetween(nodeId, nodeName, e.path, m.id, m.name, `~/Downloads/${e.name}`),
    terminalHere: onTerminalHere ? (p) => onTerminalHere(p) : undefined,
  };
  tagCtx(list, 'folder', nodeId, {
    get path() { return cur.path; },
    actions: {
      newFolder, upload: () => upload.click(), refresh: () => load(cur.path), terminalHere: fileActions.terminalHere,
      toggleHidden: () => { showHidden = !showHidden; load(cur.path); }, showHidden: () => showHidden,
    },
  });

  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(pathInput.value); });
  rootsSel.addEventListener('change', () => load(rootsSel.value));
  upload.addEventListener('change', async () => {
    for (const f of upload.files) {
      const dest = cur.path.replace(/[\\/]$/, '') + cur.sep + f.name;
      try {
        await api(`${node(nodeId)}/files/write?path=${encodeURIComponent(dest)}`, { method: 'PUT', body: f });
        toast(`Uploaded ${f.name} → ${nodeName}`, 'ok');
      } catch (e) { toast(`Upload failed: ${e.message}`, 'error'); }
    }
    upload.value = '';
    load(cur.path);
  });
  // Drag & drop from the desktop into the window uploads to the current folder.
  w.body.addEventListener('dragover', (e) => { e.preventDefault(); list.classList.add('drop'); });
  w.body.addEventListener('dragleave', () => list.classList.remove('drop'));
  w.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drop');
    const remote = e.dataTransfer.getData('application/x-rigs-file');
    if (remote) { const src = JSON.parse(remote); return copyBetween(src.nodeId, src.nodeName, src.path, nodeId, nodeName, cur.path + cur.sep + src.name); }
    for (const f of e.dataTransfer.files) {
      try { await api(`${node(nodeId)}/files/write?path=${encodeURIComponent(cur.path + cur.sep + f.name)}`, { method: 'PUT', body: f }); }
      catch (err) { toast(`Upload failed: ${err.message}`, 'error'); }
    }
    load(cur.path);
  });

  async function load(p) {
    try {
      const r = await api(`${node(nodeId)}/files?path=${encodeURIComponent(p)}${showHidden ? '&hidden=1' : ''}`);
      cur = r;
      pathInput.value = r.path;
      rootsSel.replaceChildren(...r.roots.map((x) => h('option', { value: x.path }, x.name)));
      rootsSel.value = '';
      render();
      return true;
    } catch (e) { toast(`${nodeName}: ${e.message}`, 'error'); return false; }
  }

  /** Go to a folder (ui_open): load it, then select and preview `sel` (a file or folder in it) when given. */
  async function navigate(p, { select: sel = '', showHidden: hid } = {}) {
    if (hid && !showHidden) { showHidden = true; hiddenBox.checked = true; }
    if (!(await load(p))) return false;
    const e = sel && cur.entries.find((x) => x.path === sel);
    if (!e) { picked = []; anchor = null; render(); return true; }
    picked = [e.path];
    anchor = e.path;
    render();
    list.querySelector('.file-row.sel')?.scrollIntoView?.({ block: 'nearest' });
    if (e.type === 'dir') showDirActions(e); else showPreview(e);
    return true;
  }

  function render() {
    list.replaceChildren(...cur.entries.map((e) => {
      const row = h('div', { class: 'file-row' + (picked.includes(e.path) ? ' sel' : ''), draggable: 'true', title: e.path },
        h('span', { class: 'fi' }, ICON[e.type] || '📄'),
        h('span', { class: 'fn' }, e.name),
        h('span', { class: 'fs' }, e.type === 'dir' ? '' : fmtBytes(e.size)),
        h('span', { class: 'fm' }, ago(e.mtime)));
      row.addEventListener('click', (ev) => {
        ({ picked, anchor } = clickSelect({ picked, anchor }, cur.entries.map((x) => x.path), e.path, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey }));
        render();
        if (picked.length > 1) showMulti();
        else if (!picked.includes(e.path)) preview.replaceChildren(h('div', { class: 'muted pad' }, 'Select a file to preview it.'));
        else if (e.type !== 'dir') showPreview(e);
        else showDirActions(e);
      });
      // Double-click: a folder opens, a file opens in the built-in tool for its type (else downloads).
      row.addEventListener('dblclick', () => (e.type === 'dir' ? load(e.path) : toolFor(e.name) ? openTool(e) : download(e)));
      row.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('application/x-rigs-file', JSON.stringify({ nodeId, nodeName, path: e.path, name: e.name })));
      return tagCtx(row, 'file', e.path, {
        entry: e, actions: fileActions, zip: isZip(e.name),
        get machines() { return machines().filter((m) => m.id !== nodeId); },
        get tools() { return e.type === 'dir' ? [] : toolsFor(e.name).map((id) => TOOLS[id]); },
        get count() { return actionTargets(picked, e.path).length; },
      });
    }));
    if (!cur.entries.length) list.append(h('div', { class: 'muted pad' }, 'Empty folder'));
  }

  function actions(e) {
    const others = machines().filter((m) => m.id !== nodeId);
    const send = h('select', { class: 'mini' }, h('option', { value: '' }, 'Copy to machine…'), ...others.map((m) => h('option', { value: m.id }, m.name)));
    send.addEventListener('change', () => {
      const m = others.find((x) => x.id === send.value);
      if (m) copyBetween(nodeId, nodeName, e.path, m.id, m.name, `~/Downloads/${e.name}`);
      send.value = '';
    });
    const tools = e.type === 'dir' ? [] : toolsFor(e.name);
    return h('div', { class: 'actions' },
      ...tools.map((id, i) => h('button', { class: 'btn' + (i ? '' : ' primary'), onclick: () => openTool(e, id) }, `${TOOLS[id].icon} ${i ? TOOLS[id].label : 'Open'}`)),
      e.type !== 'dir' && h('button', { class: 'btn', onclick: () => download(e) }, '⇩ Download'),
      h('button', { class: 'btn', onclick: () => zipItems([e.path]) }, '🗜 Zip'),
      isZip(e.name) && h('button', { class: 'btn', onclick: () => unzipItem(e) }, '📦 Extract'),
      h('button', { class: 'btn', onclick: () => renameItem(e) }, '✎ Rename'),
      h('button', { class: 'btn danger', onclick: () => trashItem(e) }, '🗑 Trash'),
      e.type !== 'dir' && others.length ? send : null);
  }

  function showDirActions(e) {
    preview.replaceChildren(h('div', { class: 'pad' }, h('div', { class: 'pv-title' }, '📁 ' + e.name), h('div', { class: 'muted' }, e.path), actions(e),
      h('button', { class: 'btn', onclick: () => load(e.path) }, 'Open folder'), h('button', { class: 'btn', onclick: () => onTerminalHere?.(e.path) }, '⌨ Terminal here')));
  }

  async function showPreview(e) {
    const head = h('div', { class: 'pad' }, h('div', { class: 'pv-title' }, e.name), h('div', { class: 'muted' }, `${fmtBytes(e.size)} · ${new Date(e.mtime).toLocaleString()}`), actions(e));
    preview.replaceChildren(head);
    const raw = `${node(nodeId)}/files/raw?path=${encodeURIComponent(e.path)}`;
    if (IMG.test(e.name)) preview.append(h('img', { class: 'pv-img', src: raw }));
    else if ((TEXT.test(e.name) || !/\.\w+$/.test(e.name)) && e.size < 2 * 1024 * 1024) {
      try {
        const r = await api(`${node(nodeId)}/files/read?path=${encodeURIComponent(e.path)}`);
        preview.append(nativeCtx(h('pre', { class: 'pv-text' }, r.text.slice(0, 200000)))); // file text: the browser's menu (copy, search)
      } catch (err) { preview.append(h('div', { class: 'muted pad' }, err.message)); }
    } else if (/\.(mp4|webm|mov)$/i.test(e.name)) preview.append(h('video', { class: 'pv-img', src: raw, controls: true }));
    else if (/\.pdf$/i.test(e.name)) preview.append(h('iframe', { class: 'pv-frame', src: raw }));
  }

  function openTool(e, tool) {
    return openFileTool({ nodeId, nodeName, path: e.path, name: e.name, tool, entries: cur.entries, onSaved: () => { if (dirOf(e.path) === cur.path) load(cur.path); } });
  }

  function showMulti() {
    const items = cur.entries.filter((x) => picked.includes(x.path));
    const bytes = items.reduce((n, x) => n + (x.type === 'dir' ? 0 : x.size || 0), 0);
    preview.replaceChildren(h('div', { class: 'pad' },
      h('div', { class: 'pv-title' }, `${items.length} items selected`),
      h('div', { class: 'muted' }, `${fmtBytes(bytes)} in files · Ctrl/⌘-click to add or remove, Shift-click for a range`),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => zipItems(picked) }, `🗜 Compress ${items.length} items to zip`))));
  }

  /** Zip the given paths into one archive next to them (a " (2)" suffix when the name is taken). */
  async function zipItems(paths) {
    if (!paths.length) return;
    toast(`Compressing ${paths.length === 1 ? paths[0].split(/[\\/]/).pop() : paths.length + ' items'}…`);
    try {
      const r = await api(`${node(nodeId)}/files/zip`, { method: 'POST', body: { paths } });
      toast(`Created ${r.path.split(/[\\/]/).pop()} (${r.files} file${r.files === 1 ? '' : 's'}, ${fmtBytes(r.size)})`, 'ok');
      if (dirOf(r.path) === cur.path) await navigate(cur.path, { select: r.path }); else load(cur.path);
    } catch (err) { toast(`Zip failed: ${err.message}`, 'error'); }
  }

  /** Extract an archive into a new folder beside it (named after it, suffixed when taken). */
  async function unzipItem(e) {
    toast(`Extracting ${e.name}…`);
    try {
      const r = await api(`${node(nodeId)}/files/unzip`, { method: 'POST', body: { path: e.path } });
      toast(`Extracted ${r.files} file${r.files === 1 ? '' : 's'} into ${r.path.split(/[\\/]/).pop()}${r.renamed.length ? ` (${r.renamed.length} renamed to avoid overwriting)` : ''}`, 'ok', 7000);
      if (dirOf(r.path) === cur.path) await navigate(cur.path, { select: r.path }); else load(cur.path);
    } catch (err) { toast(`Unzip failed: ${err.message}`, 'error', 9000); }
  }

  function download(e) {
    const a = h('a', { href: `${node(nodeId)}/files/raw?path=${encodeURIComponent(e.path)}&download=1`, download: e.name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function newFolder() {
    const name = prompt('New folder name');
    if (!name) return;
    try { await api(`${node(nodeId)}/files/mkdir`, { method: 'POST', body: { path: cur.path + cur.sep + name } }); load(cur.path); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function renameItem(e) {
    const name = prompt('Rename to', e.name);
    if (!name || name === e.name) return;
    try { await api(`${node(nodeId)}/files/rename`, { method: 'POST', body: { from: e.path, to: cur.path + cur.sep + name } }); load(cur.path); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function trashItem(e) {
    if (!confirm(`Move "${e.name}" on ${nodeName} to ~/.rigs/trash?`)) return;
    try { await api(`${node(nodeId)}/files/trash`, { method: 'POST', body: { path: e.path } }); toast(`Moved ${e.name} to trash`, 'ok'); load(cur.path); }
    catch (err) { toast(err.message, 'error'); }
  }

  navigate(path, { select });
  w.navigate = navigate;
  w.nodeId = nodeId;
  Object.defineProperties(w, { closed: { get: () => closed }, path: { get: () => cur.path } });
  return w;
}

const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '') || '/';

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
