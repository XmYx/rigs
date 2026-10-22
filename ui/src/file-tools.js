import { api, fmtBytes, h, node, toast } from './api.js';
import { openWindow } from './wm.js';
import { nativeCtx } from './ctx-tag.js';
import { isPhone } from './mobile.js';
import { openMediaPlayer } from './media-player.js';
import { openContentWindow } from './content-window.js';
import { openModelViewer } from './model-viewer-lazy.js';
import {
  DELIMITERS, TOOLS, checkJSON, editorTitle, fitScale, imageSiblings, isSaveKey, jsonChildren, jsonKind, jsonSummary,
  nextSort, parseCSV, sniffDelimiter, sortRows, stepIndex, toolFor, zoomStep,
} from './file-tools-model.js';

// Built-in file tools: text editor, image / PDF / CSV / JSON viewers, rendered HTML (content-window.js, sandboxed) and the 3D
// viewer for .glb/.gltf/.obj (model-viewer.js, a lazy chunk); audio and video go to media-player.js. Each is a wm.js window (floats, docks, closes
// like any other; full screen on phones). Opened from the file browser (files.js: double-click by type, "Open with",
// preview buttons) and by anything else that holds a machine + path:
//   openFileTool({ nodeId, nodeName, path, name?, tool?, entries?, onSaved? })
// `tool` defaults to the file type's (toolFor); `entries` = the folder listing, for the image viewer's next/previous.
// Files are read and written through the machine's file API (/api/nodes/<id>/files/read | text | raw), so a tool
// works on any machine in the mesh. Pure parts: file-tools-model.js.

const open = new Map(); // `${nodeId}|${tool}|${path}` → window: opening the same file again raises it
const CSV_ROWS = [500, 1000, 5000, 20000];

const baseName = (p) => String(p).split(/[\\/]/).pop();
const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '') || '/';
const rawUrl = (nodeId, p, dl = false) => `${node(nodeId)}/files/raw?path=${encodeURIComponent(p)}${dl ? '&download=1' : ''}`;

function download(nodeId, p) {
  const a = h('a', { href: rawUrl(nodeId, p, true), download: baseName(p) });
  document.body.append(a);
  a.click();
  a.remove();
}

/** Open `path` on machine `nodeId` in a built-in tool. Returns the wm.js window (or null when no tool fits). */
export function openFileTool({ nodeId, nodeName = '', path, name, tool, entries, onSaved } = {}) {
  name = name || baseName(path);
  tool = tool || toolFor(name);
  if (!TOOLS[tool]) { toast(`No built-in tool opens ${name}`, 'warn'); return null; }
  if (tool === 'media') return openMediaPlayer({ nodeId, nodeName, path, name, entries }); // one player window, it raises itself
  if (tool === 'model') return openModelViewer({ nodeId, nodeName, path, name }); // one viewer window per file, it raises itself (a promise: lazy chunk)
  const key = `${nodeId}|${tool}|${path}`;
  const prev = open.get(key);
  if (prev && !prev.closed) { prev.raise(); return prev; }
  const ctx = { nodeId, nodeName, path, name, entries, onSaved };
  const w = { text: textEditor, image: imageViewer, pdf: pdfViewer, csv: csvViewer, json: jsonViewer, html: htmlViewer }[tool](ctx);
  open.set(key, w);
  w.onCleanup(() => { w.closed = true; if (open.get(key) === w) open.delete(key); });
  return w;
}

function makeWindow({ tool, name, nodeName, width = 860, height = 600, tools = [] }) {
  const t = TOOLS[tool];
  return openWindow({ title: `${name}${nodeName ? ' — ' + nodeName : ''}`, icon: t.icon, width, height, className: `ft-win ft-win-${tool}`, tools });
}

const bar = (...kids) => h('div', { class: 'toolbar ft-bar' }, ...kids);
const status = () => h('span', { class: 'ft-status muted', role: 'status', 'aria-live': 'polite' });
const pressed = (btn, on) => { btn.setAttribute('aria-pressed', String(!!on)); btn.classList.toggle('on', !!on); };

// ------------------------------------------------------------------ text editor

function textEditor({ nodeId, nodeName, path, name, onSaved }) {
  const w = makeWindow({ tool: 'text', name, nodeName, width: 900, height: 620 });
  const area = nativeCtx(h('textarea', { class: 'ft-text', spellcheck: 'false', 'aria-label': `Text of ${name}`, wrap: 'off', disabled: true }));
  const save = h('button', { class: 'tb', title: 'Save (Ctrl/⌘+S)', disabled: true, onclick: () => doSave() }, '💾 Save');
  const wrap = h('input', { type: 'checkbox', onchange: () => area.setAttribute('wrap', wrap.checked ? 'soft' : 'off') });
  const pos = h('span', { class: 'ft-pos muted' }, '');
  const st = status();
  w.body.append(bar(save, h('label', { class: 'tb check' }, wrap, ' Wrap'), st, h('span', { class: 'ft-grow' }), pos), area);
  if (/\.(md|markdown|txt|rst|log)$/i.test(name)) { wrap.checked = true; area.setAttribute('wrap', 'soft'); }

  let dirty = false;
  let saved = '';
  let readOnly = false;
  let saving = false;
  const setDirty = (d) => {
    dirty = d;
    save.disabled = !d || readOnly || saving;
    w.setTitle(`${editorTitle(name, d)}${nodeName ? ' — ' + nodeName : ''}`);
  };
  const updatePos = () => {
    const before = area.value.slice(0, area.selectionStart);
    pos.textContent = `Ln ${before.split('\n').length}, Col ${before.length - before.lastIndexOf('\n')}`;
  };

  async function load() {
    st.textContent = 'Loading…';
    try {
      const r = await api(`${node(nodeId)}/files/read?path=${encodeURIComponent(path)}`);
      if (w.closed) return;
      const binary = r.text.includes('\u0000');
      area.value = saved = r.text;
      readOnly = !!r.truncated || binary;
      area.disabled = false;
      area.readOnly = readOnly;
      st.textContent = r.truncated ? `Read-only: only the first ${fmtBytes(r.text.length)} of ${fmtBytes(r.size)} is shown` : binary ? 'Read-only: binary file' : '';
      setDirty(false);
      updatePos();
      if (!isPhone()) area.focus({ preventScroll: true });
    } catch (e) { st.textContent = `Could not open: ${e.message}`; }
  }

  async function doSave() {
    if (readOnly || saving || !dirty) return;
    saving = true;
    save.disabled = true;
    st.textContent = 'Saving…';
    const text = area.value;
    try {
      await api(`${node(nodeId)}/files/text`, { method: 'POST', body: { path, text } });
      saved = text;
      saving = false;
      setDirty(area.value !== saved);
      st.textContent = `Saved ${new Date().toLocaleTimeString()}`;
      onSaved?.(path);
    } catch (e) {
      saving = false;
      setDirty(true);
      st.textContent = '';
      toast(`Save failed: ${e.message}`, 'error');
    }
  }

  area.addEventListener('input', () => setDirty(area.value !== saved));
  for (const ev of ['keyup', 'click', 'select']) area.addEventListener(ev, updatePos);
  w.listen(w.el, 'keydown', (e) => { if (isSaveKey(e)) { e.preventDefault(); e.stopPropagation(); doSave(); } });
  w.listen(window, 'beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  w.onCleanup(() => { if (dirty) toast(`${name}: unsaved changes were discarded`, 'warn', 6000); });
  load();
  w.save = doSave;
  Object.defineProperty(w, 'dirty', { get: () => dirty });
  return w;
}

// ------------------------------------------------------------------ image viewer

function imageViewer({ nodeId, nodeName, path, name, entries }) {
  const w = makeWindow({ tool: 'image', name, nodeName, width: 900, height: 640 });
  const img = h('img', { class: 'ft-img', alt: name, draggable: 'false' });
  const stage = h('div', { class: 'ft-stage fit', tabindex: '0', 'aria-label': 'Image' }, img);
  const prev = h('button', { class: 'tb', title: 'Previous image (←)', 'aria-label': 'Previous image', onclick: () => step(-1) }, '‹');
  const next = h('button', { class: 'tb', title: 'Next image (→)', 'aria-label': 'Next image', onclick: () => step(1) }, '›');
  const count = h('span', { class: 'ft-count muted' });
  const zoomLbl = h('span', { class: 'ft-zoom', 'aria-live': 'polite' }, '');
  const fitBtn = h('button', { class: 'tb', title: 'Fit to window (0)', onclick: () => setZoom('fit') }, 'Fit');
  const st = status();
  w.body.append(bar(prev, count, next,
    h('button', { class: 'tb', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onclick: () => setZoom(zoomStep(scale(), -1)) }, '−'),
    zoomLbl,
    h('button', { class: 'tb', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => setZoom(zoomStep(scale(), 1)) }, '+'),
    fitBtn,
    h('button', { class: 'tb', title: 'Actual size (1)', onclick: () => setZoom(1) }, '1:1'),
    h('span', { class: 'ft-grow' }), st,
    h('button', { class: 'tb', title: 'Download', 'aria-label': 'Download', onclick: () => download(nodeId, list[index]?.path || path) }, '⇩')), stage);

  let list = [{ name, path, type: 'file' }];
  let index = 0;
  let zoom = 'fit';
  const scale = () => (zoom === 'fit' ? fitScale(img.naturalWidth, img.naturalHeight, stage.clientWidth - 16, stage.clientHeight - 16) : zoom);
  function apply() {
    if (!img.naturalWidth) return;
    const s = scale();
    img.style.width = Math.round(img.naturalWidth * s) + 'px';
    img.style.height = Math.round(img.naturalHeight * s) + 'px';
    zoomLbl.textContent = `${Math.round(s * 100)}%`;
    pressed(fitBtn, zoom === 'fit');
    stage.classList.toggle('fit', zoom === 'fit');
  }
  function setZoom(z) { zoom = z; apply(); }
  const counter = () => {
    count.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
    prev.disabled = next.disabled = list.length < 2;
  };
  function show() {
    const e = list[index];
    if (!e) return;
    img.removeAttribute('style');
    img.alt = e.name;
    st.textContent = 'Loading…';
    img.src = rawUrl(nodeId, e.path);
    counter();
    w.setTitle(`${e.name}${nodeName ? ' — ' + nodeName : ''}`);
  }
  function step(d) { if (list.length > 1) { index = stepIndex(index, list.length, d); zoom = 'fit'; show(); } }
  img.addEventListener('load', () => { st.textContent = `${img.naturalWidth} × ${img.naturalHeight}`; apply(); });
  img.addEventListener('error', () => { st.textContent = 'Could not load this image'; });
  w.onResize(() => { if (zoom === 'fit') apply(); });
  w.listen(w.el, 'keydown', (e) => {
    if (e.target.closest('input,select,textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowLeft') step(-1);
    else if (k === 'ArrowRight') step(1);
    else if (k === '+' || k === '=') setZoom(zoomStep(scale(), 1));
    else if (k === '-' || k === '_') setZoom(zoomStep(scale(), -1));
    else if (k === '0') setZoom('fit');
    else if (k === '1') setZoom(1);
    else return;
    e.preventDefault();
  });
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls a zoomed image
    e.preventDefault();
    setZoom(zoomStep(scale(), e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  const useList = (all) => { const r = imageSiblings(all, path); if (r.list.length) { list = r.list; index = r.index; } };
  if (entries) useList(entries);
  show();
  if (!entries) {
    api(`${node(nodeId)}/files?path=${encodeURIComponent(dirOf(path))}`)
      .then((r) => { if (!w.closed) { useList(r.entries); counter(); } }).catch(() => {});
  }
  if (!isPhone()) stage.focus({ preventScroll: true });
  w.step = step;
  w.setZoom = setZoom;
  return w;
}

// ------------------------------------------------------------------ PDF viewer

function pdfViewer({ nodeId, nodeName, path, name }) {
  const w = makeWindow({ tool: 'pdf', name, nodeName, width: 900, height: 720 });
  const url = rawUrl(nodeId, path);
  w.body.append(bar(
    h('a', { class: 'tb', href: url, target: '_blank', rel: 'noopener', title: 'Open in a new browser tab' }, '↗ Open in tab'),
    h('button', { class: 'tb', title: 'Download', onclick: () => download(nodeId, path) }, '⇩ Download'),
    h('span', { class: 'ft-grow' })));
  // The browser's own PDF viewer (Chrome, Edge, Firefox, Safari). Where there is none (most phones) the frame would
  // only offer a download, so the window says so and offers the two ways out instead.
  if (navigator.pdfViewerEnabled === false) {
    w.body.append(h('div', { class: 'ft-fallback pad' },
      h('p', {}, 'This browser does not show PDFs inside the page.'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, '↗ Open in a new tab'),
        h('button', { class: 'btn', onclick: () => download(nodeId, path) }, '⇩ Download'))));
  } else w.body.append(h('iframe', { class: 'ft-pdf', src: url, title: `PDF: ${name}` }));
  return w;
}

// ------------------------------------------------------------------ rendered HTML

/** A .html file as a page, in the sandboxed content window (scripts run, but never with the UI's origin: content-window-model.js). */
function htmlViewer({ nodeId, nodeName, path, name }) {
  return openContentWindow({ title: `${name}${nodeName ? ' — ' + nodeName : ''}`, icon: TOOLS.html.icon, url: rawUrl(nodeId, path), key: `html:${nodeId}|${path}`, focus: true, className: 'ft-win-html' });
}

// ------------------------------------------------------------------ CSV viewer

function csvViewer({ nodeId, nodeName, path, name }) {
  const w = makeWindow({ tool: 'csv', name, nodeName, width: 980, height: 620 });
  const delim = h('select', { class: 'mini', 'aria-label': 'Delimiter' }, h('option', { value: 'auto' }, 'Auto'));
  const rowsSel = h('select', { class: 'mini', 'aria-label': 'Rows to show' }, ...CSV_ROWS.map((n) => h('option', { value: String(n) }, `First ${n.toLocaleString()} rows`)));
  const header = h('input', { type: 'checkbox', checked: true });
  const info = h('span', { class: 'ft-status muted', role: 'status' });
  const table = h('table', { class: 'ft-table' });
  const wrapEl = h('div', { class: 'ft-table-wrap', tabindex: '0', 'aria-label': `Table of ${name}` }, table);
  w.body.append(bar(h('label', { class: 'tb check' }, 'Delimiter ', delim), rowsSel, h('label', { class: 'tb check' }, header, ' Header row'), h('span', { class: 'ft-grow' }), info), wrapEl);
  rowsSel.value = '1000';

  let text = '';
  let fileInfo = null;
  let detected = ',';
  let sort = null;
  let parsed = { rows: [], truncated: false };

  function parse() {
    const d = delim.value === 'auto' ? detected : delim.value;
    parsed = parseCSV(text, { delimiter: d, maxRows: Number(rowsSel.value) + (header.checked ? 1 : 0) });
    sort = null;
    render();
  }
  function render() {
    const rows = parsed.rows;
    const head = header.checked ? rows[0] || [] : [];
    let body = header.checked ? rows.slice(1) : rows;
    let cols = head.length;
    for (const r of body) if (r.length > cols) cols = r.length;
    if (sort) body = sortRows(body, sort.col, sort.dir);
    const th = (c) => {
      const label = (header.checked && head[c]) || `Column ${c + 1}`;
      const dir = sort?.col === c ? sort.dir : null;
      const b = h('button', { class: 'ft-th', title: 'Sort by this column', onclick: () => { sort = nextSort(sort, c); render(); } },
        label, h('span', { class: 'ft-sort', 'aria-hidden': 'true' }, dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''));
      return h('th', { scope: 'col', 'aria-sort': dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none' }, b);
    };
    const thead = h('thead', {}, h('tr', {}, h('th', { class: 'ft-rn', scope: 'col' }, '#'), ...Array.from({ length: cols }, (_, c) => th(c))));
    const tbody = document.createElement('tbody');
    const frag = document.createDocumentFragment();
    body.forEach((r, i) => {
      const tr = document.createElement('tr');
      const rn = document.createElement('td');
      rn.className = 'ft-rn';
      rn.textContent = String(i + 1);
      tr.append(rn);
      for (let c = 0; c < cols; c++) { const td = document.createElement('td'); td.textContent = r[c] ?? ''; tr.append(td); }
      frag.append(tr);
    });
    tbody.append(frag);
    table.replaceChildren(thead, tbody);
    const cut = parsed.truncated || fileInfo?.truncated;
    info.textContent = `${body.length.toLocaleString()} rows × ${cols} columns${cut ? ' · first rows only' : ''}${fileInfo?.truncated ? ` of a ${fmtBytes(fileInfo.size)} file` : ''}`;
  }

  delim.addEventListener('change', parse);
  rowsSel.addEventListener('change', parse);
  header.addEventListener('change', parse);
  info.textContent = 'Loading…';
  api(`${node(nodeId)}/files/read?path=${encodeURIComponent(path)}`).then((r) => {
    if (w.closed) return;
    text = r.text;
    fileInfo = r;
    detected = sniffDelimiter(text, name);
    const label = DELIMITERS.find((x) => x.id === detected)?.label || detected;
    delim.replaceChildren(h('option', { value: 'auto' }, `Auto (${label})`), ...DELIMITERS.map((x) => h('option', { value: x.id }, x.label)));
    parse();
  }).catch((e) => { info.textContent = `Could not open: ${e.message}`; });
  w.setDelimiter = (d) => { delim.value = d; parse(); };
  return w;
}

// ------------------------------------------------------------------ JSON viewer

function jsonViewer({ nodeId, nodeName, path, name }) {
  const w = makeWindow({ tool: 'json', name, nodeName, width: 860, height: 640 });
  const views = ['tree', 'pretty', 'raw'];
  const labels = { tree: 'Tree', pretty: 'Pretty', raw: 'Raw' };
  const btns = Object.fromEntries(views.map((v) => [v, h('button', { class: 'tb seg', 'aria-pressed': 'false', onclick: () => setView(v) }, labels[v])]));
  const expandAll = h('button', { class: 'tb', title: 'Expand (up to 5 levels deep)', onclick: () => toggleAll(true) }, '⊞ Expand');
  const collapseAll = h('button', { class: 'tb', title: 'Collapse everything', onclick: () => toggleAll(false) }, '⊟ Collapse');
  const info = h('span', { class: 'ft-status muted', role: 'status' });
  const errBox = h('div', { class: 'ft-json-err', role: 'alert', hidden: true });
  const out = h('div', { class: 'ft-json', tabindex: '0', 'aria-label': `Contents of ${name}` });
  w.body.append(bar(h('span', { class: 'seg-group', role: 'group', 'aria-label': 'View' }, ...views.map((v) => btns[v])), expandAll, collapseAll, h('span', { class: 'ft-grow' }), info), errBox, out);

  let text = '';
  let res = null;

  function setView(v) {
    if (!res) return;
    if (!res.ok) v = 'raw';
    for (const x of views) pressed(btns[x], x === v);
    expandAll.hidden = collapseAll.hidden = v !== 'tree';
    if (v === 'tree') out.replaceChildren(treeNode(null, res.value, 0, true));
    else if (v === 'pretty') out.replaceChildren(nativeCtx(h('pre', { class: 'ft-pre' }, JSON.stringify(res.value, null, 2))));
    else out.replaceChildren(nativeCtx(h('pre', { class: 'ft-pre' }, text)));
  }

  function treeNode(key, v, depth, openIt = depth < 1) {
    const kind = jsonKind(v);
    const k = key === null ? null : h('span', { class: 'jt-key' }, typeof key === 'number' ? String(key) : JSON.stringify(key), ': ');
    if (kind !== 'object' && kind !== 'array') {
      return h('div', { class: 'jt-row' }, h('span', { class: 'jt-pad' }), k, h('span', { class: `jt-v jt-${kind}` }, JSON.stringify(v)));
    }
    const kids = h('div', { class: 'jt-kids', hidden: true });
    const tog = h('button', { class: 'jt-tog', 'aria-expanded': 'false', 'aria-label': `Expand ${key ?? 'root'}` }, '▸');
    const row = h('div', { class: 'jt-row' }, tog, k, h('span', { class: 'jt-sum muted' }, jsonSummary(v)));
    const el = h('div', { class: 'jt-node' }, row, kids);
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      let limit = 500;
      const fill = () => {
        const { items, more } = jsonChildren(v, limit);
        kids.replaceChildren(...items.map(([ck, cv]) => treeNode(ck, cv, depth + 1)));
        if (more) kids.append(h('button', { class: 'tb jt-more', onclick: () => { limit += 500; fill(); } }, `… ${more.toLocaleString()} more`));
      };
      fill();
    };
    el._set = (on) => {
      if (on) build();
      kids.hidden = !on;
      tog.textContent = on ? '▾' : '▸';
      tog.setAttribute('aria-expanded', String(on));
      tog.setAttribute('aria-label', `${on ? 'Collapse' : 'Expand'} ${key ?? 'root'}`);
    };
    tog.addEventListener('click', () => el._set(kids.hidden));
    row.addEventListener('dblclick', () => el._set(kids.hidden));
    if (openIt) el._set(true);
    return el;
  }

  function toggleAll(on) {
    // Expanding opens up to 5 levels so a huge file stays responsive; collapsing closes all but the root.
    const walk = (el, depth) => {
      if (!el?._set) return;
      if (on && depth > 5) return;
      el._set(on || depth === 0);
      for (const c of el.querySelector(':scope > .jt-kids')?.children || []) walk(c, depth + 1);
    };
    walk(out.firstElementChild, 0);
  }

  info.textContent = 'Loading…';
  api(`${node(nodeId)}/files/read?path=${encodeURIComponent(path)}`).then((r) => {
    if (w.closed) return;
    text = r.text;
    res = checkJSON(text);
    info.textContent = `${fmtBytes(r.size)}${r.truncated ? ' · only the start of the file was read' : ''}`;
    if (!res.ok) {
      // The failing line with a caret under the spot; very long lines (minified JSON) are cut around it.
      const long = res.lineText.length > 400;
      const from = long ? Math.max(0, res.col - 200) : 0;
      const shown = long ? res.lineText.slice(from, res.col + 200) : res.lineText;
      errBox.replaceChildren(
        h('div', {}, h('b', {}, 'Invalid JSON: '), `${res.message} — line ${res.line}, column ${res.col}`, r.truncated ? ' (the file is larger than what was read)' : ''),
        nativeCtx(h('pre', { class: 'ft-pre ft-caret' }, `${shown}\n${' '.repeat(Math.max(0, res.col - 1 - from))}^`)));
      errBox.hidden = false;
      btns.tree.disabled = btns.pretty.disabled = true;
    }
    setView(res.ok ? 'tree' : 'raw');
  }).catch((e) => { info.textContent = `Could not open: ${e.message}`; });
  return w;
}
