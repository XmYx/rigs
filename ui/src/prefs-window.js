import { api, h, node } from './api.js';
import { openWindow } from './wm.js';
import { isPhone } from './mobile.js';
import { categoryById, formatSecret, itemById, valuesById } from './settings-model.js';
import {
  actionRequest, choiceOptions, coerceInput, displayValue, errorFor, groupRows, hasMachineItems, hasServerItems, savedText, scopeChip,
  searchGroups, visibleCategories,
} from './prefs-model.js';

// JARVIS › System Preferences… — a macOS System Settings–style window (a wm.js window: floats, drags, docks, full
// screen on phones) over the schema of settings-model.js: a searchable sidebar of categories and a pane of grouped
// rounded rows, each with the control its item names. Server items are read and written through GET/POST
// <machine>/settings (the machine picker chooses which RIGS node; mesh-wide items are the same everywhere); UI prefs
// go through prefs-bridge.js — the same live code as the left panel, the menus and the app dock — so every place stays
// in step. Every change applies at once and its row says "Saved" or shows the real error. Narrow windows (phones,
// 390 px) show the category list, which drills into one category with a Back button. Pure parts: prefs-model.js.
//
// deps: { prefs: createPrefBridge(…), machines() → [{ id, name, self }], selfId(), voices() → [{ id, label }], themes,
//   openSurface(name, machine) — the existing UI behind an `open` action (UI_SURFACES) }

const NARROW = 620; // px of window width below which the sidebar and the pane take turns
const POLL_MS = 1500; // re-read UI prefs changed elsewhere (left panel, menus, dock) while the window is open
let current = null; // the open window: { show(categoryId), w }
let seq = 0; // ids of labels and help texts

/** Open System Preferences (or bring it forward), on `category` when given. */
export function openPreferences(deps, { category } = {}) {
  if (current) { current.w.raise(); if (category) current.show(category); return current; }
  current = build(deps, category);
  return current;
}

/** Is the window open? (the JARVIS menu's checkmark, checks) */
export const preferencesOpen = () => !!current;

function build(deps, startCategory) {
  const self = () => (deps.machines?.() || []).find((m) => m.self) || { id: deps.selfId?.() || 'self', name: 'this machine', self: true };
  const st = {
    cat: categoryById(startCategory) ? startCategory : 'general',
    query: '',
    drilled: !!startCategory,
    machineId: self().id,
    values: null, // valuesById(GET settings) of the chosen machine
    loadError: '',
    loading: false,
    catalog: [], // GET models of the chosen machine (providers, models, efforts)
  };
  const rows = []; // the rows on screen: { it, el, sync() }
  const phone = () => isPhone();

  const w = openWindow({ title: 'System Preferences', icon: '⚙', width: 900, height: 620, key: 'prefs', className: 'prefs-win', onClose: () => { current = null; } });
  const search = h('input', { class: 'prefs-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search settings', autocomplete: 'off', spellcheck: 'false' });
  const cats = h('nav', { class: 'prefs-cats', 'aria-label': 'Categories' });
  const side = h('aside', { class: 'prefs-side' }, h('div', { class: 'prefs-search-wrap' }, search), cats);
  const back = h('button', { class: 'prefs-back', type: 'button', 'aria-label': 'Back to all categories' }, '‹ Back');
  const titleEl = h('h2', { class: 'prefs-title', id: `prefs-title-${++seq}` });
  const helpEl = h('p', { class: 'prefs-help muted' });
  const machineSel = h('select', { class: 'mini prefs-machine', 'aria-label': 'Machine whose settings are shown' });
  const machineRow = h('div', { class: 'prefs-machine-row' }, h('label', {}, 'Machine ', machineSel), h('span', { class: 'muted small prefs-machine-note' }),
    h('button', { class: 'prefs-reload', type: 'button', title: 'Read the settings again', 'aria-label': 'Read the settings again' }, '↻'));
  const content = h('div', { class: 'prefs-content' });
  const pane = h('section', { class: 'prefs-pane', 'aria-labelledby': titleEl.id },
    h('header', { class: 'prefs-head' }, back, h('div', { class: 'prefs-head-text' }, titleEl, helpEl)), machineRow, content);
  const root = h('div', { class: 'prefs' }, side, pane);
  w.body.append(root);

  // ------------------------------------------------------------------ data
  const base = () => node(st.machineId);
  const machineName = () => (deps.machines?.() || []).find((m) => m.id === st.machineId)?.name || self().name;

  let loadSeq = 0;
  async function load() {
    const my = ++loadSeq;
    st.loading = true;
    st.loadError = '';
    syncAll();
    try {
      const [res, cat] = await Promise.all([api(`${base()}/settings`), api(`${base()}/models`).catch(() => [])]);
      if (my !== loadSeq || !root.isConnected) return; // a newer load (another machine) or the window closed
      st.values = valuesById(res);
      st.catalog = Array.isArray(cat) ? cat : [];
    } catch (e) {
      st.values = null;
      if (my !== loadSeq || !root.isConnected) return;
      st.loadError = /404|not found/i.test(e.message) ? `${machineName()}'s RIGS has no settings API yet — update it (Updates & Merge).` : e.message;
    }
    st.loading = false;
    render();
  }

  /** The current value of an item: a UI pref from the live UI, a server item from the chosen machine. */
  function valueOf(it) {
    if (it.pref) return deps.prefs.get(it.id);
    const e = st.values?.[it.id];
    if (!e) return undefined;
    return it.secret ? e.secret : e.value;
  }
  const choiceCtx = () => ({
    value: (id) => { const it = itemById(id); return it ? valueOf(it) : undefined; },
    machines: deps.machines?.() || [], catalog: st.catalog, voices: deps.voices?.() || [], themes: deps.themes || {},
  });

  // ------------------------------------------------------------------ saving
  function indicate(row, text, kind) {
    const s = row.state;
    clearTimeout(row.fade);
    s.textContent = text;
    s.className = `pr-state ${kind || ''}`;
    if (kind === 'ok') row.fade = setTimeout(() => s.classList.add('fade'), 2600);
  }

  async function commit(row, raw) {
    const { it } = row;
    const r = coerceInput(it, raw);
    if (!r.ok) { indicate(row, `${it.label} ${r.error}`, 'err'); row.sync(true); return false; }
    if (it.pref) {
      try { await deps.prefs.set(it.id, r.value); indicate(row, savedText(it), 'ok'); }
      catch (e) { indicate(row, e.message, 'err'); }
      syncAll();
      return true;
    }
    indicate(row, 'Saving…', 'busy');
    try {
      const resp = await fetch(`${base()}/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { [it.id]: r.value } }) });
      const text = await resp.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${resp.status}` }; }
      if (data?.categories) st.values = valuesById(data); // the fresh payload (also after a partial apply)
      if (!resp.ok) throw new Error(errorFor(it.id, data));
      indicate(row, savedText(it, { machine: machineName() }), 'ok');
      // This page's JARVIS (main.js) picks up its name, address and thinking phrases at once, as after Mesh › JARVIS › Save.
      if (it.id.startsWith('persona.') && [self().id, deps.selfId?.(), 'self'].includes(st.machineId)) { // 'self': opened before the first snapshot
        const v = (k) => st.values?.[`persona.${k}`]?.value;
        window.dispatchEvent(new CustomEvent('rigs:persona', { detail: { name: v('name'), address: v('address'), thinkingPhrases: v('thinkingPhrases') } }));
      }
    } catch (e) {
      indicate(row, e.message, 'err');
    }
    syncAll();
    return true;
  }

  async function runAction(row) {
    const { it } = row;
    const a = it.action || {};
    if (a.confirm && !window.confirm(a.confirm)) return;
    if (a.open) { try { await deps.openSurface?.(a.open, (deps.machines?.() || []).find((m) => m.id === st.machineId) || self()); } catch (e) { indicate(row, e.message, 'err'); } return; }
    const req = actionRequest(it, base());
    if (!req) return;
    indicate(row, 'Working…', 'busy');
    try { await api(req.url, { method: req.method, body: {} }); indicate(row, 'Done', 'ok'); }
    catch (e) { indicate(row, e.message, 'err'); }
  }

  // ------------------------------------------------------------------ one row
  function makeRow(it) {
    const id = `pr-${++seq}`;
    const labelId = `${id}-l`;
    const helpId = `${id}-h`;
    const chip = scopeChip(it);
    const meta = h('div', { class: 'pr-meta' });
    const state = h('span', { class: 'pr-state', role: 'status', 'aria-live': 'polite' });
    const ctl = h('div', { class: 'pr-ctl' });
    const el = h('div', { class: `prefs-row prow-${it.control}`, 'data-id': it.id },
      h('div', { class: 'pr-text' },
        h('div', { class: 'pr-label', id: labelId }, it.label, chip ? h('span', { class: `pr-chip scope-${it.scope}`, title: chip.title }, chip.text) : null),
        it.help ? h('div', { class: 'pr-help', id: helpId }, it.help) : null,
        meta, state),
      ctl);
    const row = { it, el, state, fade: null, sync: () => {} };
    const aria = { 'aria-labelledby': labelId, ...(it.help ? { 'aria-describedby': helpId } : {}) };
    const serverMissing = () => !it.pref && it.config && !st.values?.[it.id];
    const disabledNow = () => !!(it.readOnly || serverMissing());

    const metaBits = () => {
      const e = st.values?.[it.id];
      const bits = [];
      if (it.cli) bits.push(h('code', { class: 'pr-cli', title: 'The same from a terminal' }, it.cli));
      if (e?.overridden && it.env) bits.push(h('span', { class: 'pr-warn' }, `Overridden by $${it.env} on ${machineName()}`));
      if (it.restart) bits.push(h('span', { class: 'muted' }, 'Applies after a restart'));
      if (it.reload) bits.push(h('span', { class: 'muted' }, 'Applies after a reload'));
      if (serverMissing() && !st.loading) bits.push(h('span', { class: 'muted' }, st.values ? `Not reported by ${machineName()}` : st.loadError ? 'Not available' : 'Loading…'));
      meta.replaceChildren(...bits);
    };

    switch (it.readOnly && it.control !== 'secret-status' && it.control !== 'action' ? 'readonly' : it.control) {
      case 'readonly': {
        const v = h('span', { class: 'pr-value', ...aria });
        ctl.append(v);
        row.sync = () => { v.textContent = displayValue(it, valueOf(it)); };
        break;
      }
      case 'switch': {
        const b = h('button', { class: 'pr-switch', type: 'button', role: 'switch', ...aria }, h('span', { class: 'knob', 'aria-hidden': 'true' }));
        b.addEventListener('click', () => { if (!b.disabled) commit(row, !(b.getAttribute('aria-checked') === 'true')); });
        ctl.append(b);
        row.sync = () => { b.setAttribute('aria-checked', String(!!valueOf(it))); b.disabled = disabledNow(); };
        break;
      }
      case 'select': {
        const s = h('select', { class: 'pr-select', ...aria });
        s.addEventListener('change', () => commit(row, s.value));
        ctl.append(s);
        row.sync = (force) => {
          if (!force && document.activeElement === s) return;
          const v = valueOf(it);
          const opts = choiceOptions(it, choiceCtx(), v);
          s.replaceChildren(...opts.map((o) => h('option', { value: String(o.value) }, o.label)));
          s.value = v === undefined || v === null ? '' : String(v);
          s.disabled = disabledNow();
        };
        break;
      }
      case 'slider': {
        const out = h('output', { class: 'pr-out' });
        const r = h('input', { class: 'pr-range', type: 'range', min: it.min, max: it.max, step: it.step || 1, ...aria });
        r.addEventListener('input', () => { out.textContent = `${r.value}${it.unit || ''}`; if (it.pref) commit(row, r.value); }); // a UI pref moves live (galaxy forces), a server one saves on release
        r.addEventListener('change', () => { if (!it.pref) commit(row, r.value); });
        ctl.append(r, out);
        row.sync = (force) => { if (!force && document.activeElement === r) return; const v = valueOf(it); r.value = v ?? it.default ?? it.min; out.textContent = `${r.value}${it.unit || ''}`; r.disabled = disabledNow(); };
        break;
      }
      case 'number': {
        const n = h('input', { class: 'pr-num', type: 'number', min: it.min, max: it.max, step: it.integer ? 1 : 'any', inputmode: 'numeric', ...aria });
        n.addEventListener('change', () => commit(row, n.value));
        ctl.append(n);
        if (it.unit) ctl.append(h('span', { class: 'pr-unit muted' }, it.unit));
        row.sync = (force) => { if (!force && document.activeElement === n) return; const v = valueOf(it); n.value = v ?? ''; n.disabled = disabledNow(); };
        break;
      }
      case 'text': {
        const listId = it.choices ? `${id}-dl` : null;
        const t = h('input', { class: 'pr-text-in', type: 'text', spellcheck: 'false', autocomplete: 'off', ...(listId ? { list: listId } : {}), ...aria });
        const dl = listId ? h('datalist', { id: listId }) : null;
        t.addEventListener('change', () => commit(row, t.value));
        t.addEventListener('keydown', (e) => { if (e.key === 'Enter') t.blur(); });
        ctl.append(t);
        if (dl) ctl.append(dl);
        row.sync = (force) => {
          if (dl) dl.replaceChildren(...choiceOptions(it, choiceCtx()).filter((o) => o.value !== '').map((o) => h('option', { value: String(o.value) }, o.label)));
          if (!force && document.activeElement === t) return;
          const v = valueOf(it);
          t.value = v ?? '';
          t.placeholder = it.default ? String(it.default) : 'Default';
          t.disabled = disabledNow();
        };
        break;
      }
      case 'list': {
        if (it.values) {
          const box = h('div', { class: 'pr-checks', role: 'group', ...aria });
          const boxes = it.values.map((x) => { const v = typeof x === 'object' ? x.value : x; const c = h('input', { type: 'checkbox', value: v }); return { c, el: h('label', { class: 'pr-check' }, c, ` ${typeof x === 'object' ? x.label : x}`) }; });
          box.append(...boxes.map((b) => b.el));
          box.addEventListener('change', () => commit(row, boxes.filter((b) => b.c.checked).map((b) => b.c.value)));
          ctl.append(box);
          row.sync = () => { const v = valueOf(it) || []; for (const b of boxes) { b.c.checked = v.includes(b.c.value); b.c.disabled = disabledNow(); } };
        } else {
          const ta = h('textarea', { class: 'pr-list', rows: 3, spellcheck: 'false', placeholder: 'One per line', ...aria });
          ta.addEventListener('change', () => commit(row, ta.value));
          ctl.append(ta);
          row.sync = (force) => { if (!force && document.activeElement === ta) return; const v = valueOf(it); ta.value = Array.isArray(v) ? v.join('\n') : ''; ta.disabled = disabledNow(); };
        }
        break;
      }
      case 'secret-status': {
        const status = h('span', { class: 'pr-secret', ...aria });
        ctl.append(status);
        if (!it.readOnly) {
          const field = h('input', { class: 'pr-secret-in', type: 'password', autocomplete: 'new-password', spellcheck: 'false', 'aria-label': `New value for ${it.label}`, placeholder: 'New value' });
          const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
          const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
          const edit = h('span', { class: 'pr-secret-edit', hidden: true }, field, save, cancel);
          const change = h('button', { class: 'btn', type: 'button', 'aria-label': `Change ${it.label}` }, 'Change…');
          const clear = h('button', { class: 'btn danger', type: 'button', 'aria-label': `Clear ${it.label}` }, 'Clear');
          const close = () => { field.value = ''; edit.hidden = true; change.hidden = false; row.sync(); change.focus(); };
          change.addEventListener('click', () => { edit.hidden = false; change.hidden = true; clear.hidden = true; field.focus(); });
          cancel.addEventListener('click', close);
          save.addEventListener('click', async () => { if (!field.value) { field.focus(); return; } await commit(row, field.value); close(); });
          field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
          clear.addEventListener('click', async () => { if (window.confirm(`Clear ${it.label} on ${machineName()}?`)) await commit(row, null); });
          ctl.append(change, clear, edit);
          row.sync = () => { const v = valueOf(it); status.textContent = v ? formatSecret(v) : serverMissing() ? '—' : 'not set'; change.disabled = clear.disabled = serverMissing(); if (edit.hidden) clear.hidden = !v?.set; };
        } else row.sync = () => { const v = valueOf(it); status.textContent = v ? formatSecret(v) : '—'; };
        break;
      }
      case 'action': {
        const b = h('button', { class: 'btn pr-action', type: 'button', ...aria }, it.action?.open ? 'Open…' : it.action?.confirm ? 'Run…' : 'Run');
        b.addEventListener('click', () => runAction(row));
        const summary = it.config ? h('span', { class: 'pr-value muted' }) : null;
        if (summary) ctl.append(summary);
        ctl.append(b);
        row.sync = () => { if (summary) summary.textContent = st.values?.[it.id] ? displayValue(it, valueOf(it)) : ''; };
        break;
      }
      default: ctl.append(h('span', { class: 'muted' }, it.control));
    }
    const inner = row.sync;
    row.sync = (force) => { try { inner(force); } catch { /* a value the control cannot show */ } metaBits(); };
    row.sync(true);
    return row;
  }

  // ------------------------------------------------------------------ layout
  function syncAll() { for (const r of rows) r.sync(); syncMachineRow(); }
  function syncPrefs() { for (const r of rows) if (r.it.pref) r.sync(); }

  function syncMachineRow(items = shownItems()) {
    const show = hasServerItems(items);
    machineRow.hidden = !show;
    if (!show) return;
    const ms = deps.machines?.() || [];
    const list = ms.length ? ms : [self()];
    machineSel.replaceChildren(...list.map((m) => h('option', { value: m.id }, m.self && m.name === 'this machine' ? 'This machine' : `${m.name}${m.self ? ' (this machine)' : ''}`)));
    if (!list.some((m) => m.id === st.machineId)) machineSel.append(h('option', { value: st.machineId }, machineName()));
    machineSel.value = st.machineId;
    const note = machineRow.querySelector('.prefs-machine-note');
    note.textContent = st.loading ? 'Loading…' : st.loadError ? st.loadError : hasMachineItems(items) ? 'Mesh-wide settings are the same on every machine.' : 'Every setting here is mesh-wide.';
    note.classList.toggle('pr-err-text', !!st.loadError);
  }

  let shown = [];
  const shownItems = () => shown;

  function renderCats() {
    const hits = st.query ? new Set(searchGroups(st.query, { phone: phone() }).map((g) => g.category.id)) : null;
    cats.replaceChildren(...visibleCategories({ phone: phone() }).map((c) => {
      const on = !st.query && c.id === st.cat;
      const b = h('button', { class: `prefs-cat${on ? ' on' : ''}${hits && !hits.has(c.id) ? ' dim' : ''}`, type: 'button', 'data-cat': c.id, ...(on ? { 'aria-current': 'page' } : {}), tabindex: on ? '0' : '-1' },
        h('span', { class: 'pc-ico', 'aria-hidden': 'true' }, c.icon), h('span', { class: 'pc-label' }, c.label), h('span', { class: 'pc-arrow', 'aria-hidden': 'true' }, '›'));
      // Enter / Space (or a tap on the narrow list) moves into the category; a mouse click keeps focus on the list.
      b.addEventListener('click', (e) => { search.value = ''; st.query = ''; show(c.id, { drill: true, focus: e.detail === 0 || root.classList.contains('narrow') ? 'pane' : 'cat' }); });
      return b;
    }));
    if (!cats.querySelector('[tabindex="0"]')) cats.querySelector('.prefs-cat')?.setAttribute('tabindex', '0');
  }

  function renderBoxes(items) {
    const out = [];
    for (const { group, items: its } of groupRows(items)) {
      const box = h('div', { class: 'prefs-box', role: 'group', ...(group ? { 'aria-label': group } : {}) });
      for (const it of its) { const r = makeRow(it); rows.push(r); box.append(r.el); }
      if (group) out.push(h('h3', { class: 'prefs-group' }, group));
      out.push(box);
    }
    return out;
  }

  function render() {
    rows.length = 0;
    root.classList.toggle('searching', !!st.query);
    renderCats();
    if (st.query) {
      const groups = searchGroups(st.query, { phone: phone() });
      shown = groups.flatMap((g) => g.items);
      titleEl.textContent = `Search: “${st.query}”`;
      helpEl.textContent = groups.length ? `${shown.length} setting${shown.length === 1 ? '' : 's'} in ${groups.length} categor${groups.length === 1 ? 'y' : 'ies'}` : '';
      content.replaceChildren(...(groups.length ? groups.flatMap((g) => [h('h3', { class: 'prefs-sec' }, h('span', { 'aria-hidden': 'true' }, g.category.icon + ' '), g.category.label), ...renderBoxes(g.items)])
        : [h('p', { class: 'muted prefs-empty' }, `No setting matches “${st.query}”.`)]));
    } else {
      const c = visibleCategories({ phone: phone() }).find((x) => x.id === st.cat) || visibleCategories({ phone: phone() })[0];
      st.cat = c.id;
      shown = c.items;
      titleEl.replaceChildren(h('span', { class: 'prefs-title-ico', 'aria-hidden': 'true' }, c.icon), ` ${c.label}`);
      helpEl.textContent = c.help;
      content.replaceChildren(...renderBoxes(c.items));
    }
    syncMachineRow();
    root.classList.toggle('drilled', st.drilled || !!st.query);
  }

  function show(catId, { drill = true, focus = 'none' } = {}) {
    if (categoryById(catId)) st.cat = catId;
    st.drilled = drill;
    render();
    content.scrollTop = 0;
    if (focus === 'pane') (root.classList.contains('narrow') ? back : content.querySelector('button,select,input,textarea') || cats.querySelector('.on'))?.focus({ preventScroll: true });
    else if (focus === 'cat') cats.querySelector(`[data-cat="${st.cat}"]`)?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ events
  search.addEventListener('input', () => { st.query = search.value.trim(); render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); (st.query ? content.querySelector('button,select,input,textarea') : cats.querySelector('.prefs-cat'))?.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); content.querySelector('button:not([disabled]),select:not([disabled]),input:not([disabled]),textarea:not([disabled])')?.focus(); }
  });
  cats.addEventListener('keydown', (e) => {
    const list = [...cats.querySelectorAll('.prefs-cat')];
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const go = (k) => { e.preventDefault(); const b = list[(k + list.length) % list.length]; list.forEach((x) => x.setAttribute('tabindex', x === b ? '0' : '-1')); b.focus(); if (!root.classList.contains('narrow')) { search.value = ''; st.query = ''; show(b.dataset.cat, { drill: false }); cats.querySelector(`[data-cat="${b.dataset.cat}"]`)?.focus(); } };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
  });
  back.addEventListener('click', () => { st.drilled = false; render(); cats.querySelector(`[data-cat="${st.cat}"]`)?.focus({ preventScroll: true }); });
  machineSel.addEventListener('change', () => { st.machineId = machineSel.value; load(); });
  machineRow.querySelector('.prefs-reload').addEventListener('click', () => load());
  // Esc: clear the search first, then (narrow) go back to the list; only then does the window close (wm.js dialog).
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (st.query) { e.preventDefault(); e.stopPropagation(); search.value = ''; st.query = ''; render(); search.focus(); return; }
    if (root.classList.contains('narrow') && st.drilled) { e.preventDefault(); e.stopPropagation(); back.click(); }
  });
  const fit = () => { const narrow = root.clientWidth > 0 && root.clientWidth < NARROW; if (narrow !== root.classList.contains('narrow')) root.classList.toggle('narrow', narrow); };
  const ro = new ResizeObserver(fit);
  ro.observe(root);
  w.onCleanup(() => ro.disconnect());
  // UI prefs changed somewhere else (left panel, menus, app dock, another tab): follow them.
  w.listen(document, 'change', (e) => { if (!root.contains(e.target)) requestAnimationFrame(syncPrefs); }, true);
  w.listen(window, 'storage', () => syncPrefs());
  w.interval(() => { if (!document.hidden) syncPrefs(); }, POLL_MS);

  render();
  fit();
  load();
  requestAnimationFrame(() => (startCategory && !root.classList.contains('narrow') ? content.querySelector('button,select,input') : search)?.focus({ preventScroll: true }));
  return { w, show: (id) => { search.value = ''; st.query = ''; show(id, { drill: true }); } };
}
