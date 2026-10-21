// System Preferences window — the pure part (tested in test/prefs-model.test.js). The window (prefs-window.js) lays out
// the categories of settings-model.js; this module decides what it shows and turns what a control holds into the
// value the schema expects: which categories and items a phone gets, search results grouped by category, rows grouped
// into their rounded boxes, the scope chip of a row, the options of a select (static values or a dynamic CHOICES
// source), the request an action makes, and the text of a row's saved / error indicator.
import { CATEGORIES, formatSecret, searchItems, validateValue } from './settings-model.js';

/** An item the window offers here (phones leave out `phone: false` items: docking, smart scaling, menu bar …). */
export const offered = (it, { phone = false } = {}) => !(phone && it.phone === false);

/** Categories with the items offered here, in System Preferences order (a category left empty is dropped). */
export function visibleCategories({ phone = false } = {}) {
  return CATEGORIES.map((c) => ({ ...c, items: c.items.filter((it) => offered(it, { phone })) })).filter((c) => c.items.length);
}

/** Search across every category: [{ category, items }] in category order, the best matches of each first. */
export function searchGroups(query, { phone = false } = {}) {
  const by = new Map();
  for (const { item, category } of searchItems(query)) {
    if (!offered(item, { phone })) continue;
    if (!by.has(category.id)) by.set(category.id, { category, items: [] });
    by.get(category.id).items.push(item);
  }
  return CATEGORIES.filter((c) => by.has(c.id)).map((c) => by.get(c.id));
}

/** Rows grouped into their boxes, in first-seen order: [{ group, items }] (items without a group share one box). */
export function groupRows(items) {
  const out = [];
  for (const it of items) {
    const g = it.group || '';
    let box = out.find((b) => b.group === g);
    if (!box) { box = { group: g, items: [] }; out.push(box); }
    box.items.push(it);
  }
  return out;
}

/** Does the category hold anything the server keeps (so the machine picker applies to it)? */
export const hasServerItems = (items) => items.some((it) => it.config);
/** Does it hold something that is this machine's own (not mesh-global)? */
export const hasMachineItems = (items) => items.some((it) => it.config && it.scope === 'machine');

/** The chip a row shows when its value is shared beyond this page (machine rows: the pane header names the machine; browser rows: none). */
export function scopeChip(it) {
  if (it.control === 'action' && !it.config) return it.scope === 'global' ? { text: 'Every machine', title: 'Acts on every machine of the mesh.' } : null;
  switch (it.scope) {
    case 'global': return { text: 'Mesh-wide', title: 'One value for the whole mesh: every machine follows it.' };
    case 'synced': return { text: 'All screens', title: 'Kept by the daemon and followed live by every JARVIS on the mesh.' };
    default: return null;
  }
}

const asOption = (v) => (v && typeof v === 'object' ? { value: v.value, label: String(v.label ?? v.value) } : { value: v, label: v === '' ? 'Default' : String(v) });

/**
 * The options of a select (or the suggestions of a text field with `choices`): [{ value, label }].
 * ctx: { value(id) → current value of another item, machines: [{ name, self }], catalog: [{ id, label, models, efforts }],
 * voices: [{ id, label }], themes: { id: { name } } }. The current value is always kept as an option, so showing the
 * window never changes a setting; an empty option is offered where the item's default is empty.
 */
export function choiceOptions(it, ctx = {}, current) {
  let opts;
  if (it.values) opts = it.values.map(asOption);
  else {
    const src = String(it.choices || '');
    const [kind, arg = ''] = src.split(':');
    const providerOf = () => (arg && ctx.value && ctx.value(arg) !== undefined ? ctx.value(arg) : arg);
    const prov = (id) => (ctx.catalog || []).find((p) => p.id === id);
    switch (kind) {
      case 'machines': opts = (ctx.machines || []).map((m) => ({ value: m.name, label: `${m.name}${m.self ? ' (this machine)' : ''}` })); break;
      case 'providers': opts = (ctx.catalog || []).map((p) => ({ value: p.id, label: p.label || p.id })); break;
      case 'models': opts = (prov(providerOf())?.models || []).map((m) => ({ value: m, label: m })); break;
      case 'efforts': opts = (prov(providerOf())?.efforts || []).map((e) => ({ value: e, label: e })); break;
      case 'ollamaModels': opts = (prov('ollama')?.models || prov('claude-ollama')?.models || []).map((m) => ({ value: m, label: m })); break;
      case 'voices': opts = [{ value: '', label: 'Automatic' }, ...(ctx.voices || []).map((v) => ({ value: v.id, label: v.label || v.id }))]; break;
      case 'themes': opts = Object.entries(ctx.themes || {}).map(([id, t]) => ({ value: id, label: t.name || id })); break;
      default: opts = [];
    }
    if ((it.default === '' || current === '') && !opts.some((o) => o.value === '')) opts.unshift({ value: '', label: kind === 'machines' ? '— (this machine)' : 'Default' });
  }
  if (current !== undefined && current !== null && !opts.some((o) => o.value === current)) opts.push({ value: current, label: `${current === '' ? 'Default' : current} (current)` });
  return opts;
}

/**
 * What a control holds → the value the schema expects ({ ok, value } or { ok: false, error }). Selects get back the
 * typed value of the option chosen (0.6, not "0.6"); lists come from one-per-line text or the checked boxes.
 */
export function coerceInput(it, raw) {
  switch (it.control) {
    case 'select': {
      if (it.values) { const hit = it.values.map(asOption).find((o) => String(o.value) === String(raw)); return hit ? validateValue(it, hit.value) : validateValue(it, raw); }
      return validateValue(it, String(raw ?? ''));
    }
    case 'list': return validateValue(it, Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]/));
    case 'number':
    case 'slider': return validateValue(it, typeof raw === 'number' ? raw : String(raw ?? '').trim());
    default: return validateValue(it, raw);
  }
}

/** A value as the window shows it in a read-only row. */
export function displayValue(it, v) {
  if (it.secret) return formatSecret(v);
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? (v.every((x) => typeof x !== 'object') ? v.join(', ') : `${v.length} entries`) : 'none';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'object') return `${Object.keys(v).length} entries`;
  return `${v}${it.unit && it.unit !== '%' ? ' ' + it.unit : it.unit || ''}`;
}

/** The request an `api` action makes: { method, url } on the machine's API base (/api/nodes/<id>), or an absolute path. */
export function actionRequest(it, base) {
  const [method, path] = String(it.action?.api || '').trim().split(/\s+/);
  if (!method || !path) return null;
  return { method: method.toUpperCase(), url: path.startsWith('/') ? path : `${base}/${path}` };
}

/** The indicator text after a change: what was saved, and when it takes effect. */
export function savedText(it, { machine } = {}) {
  const where = it.scope === 'global' ? ' for the whole mesh' : it.scope === 'machine' && machine ? ` on ${machine}` : '';
  if (it.restart) return `Saved${where} · applies after a restart`;
  if (it.reload) return `Saved${where} · applies after a reload`;
  return `Saved${where}`;
}

/** The message of a refused POST /api/local/settings for one item: its own error if listed, else the first one. */
export function errorFor(id, res) {
  const own = (res?.errors || []).find((e) => e.id === id);
  return own?.error || res?.error || 'The change was not saved';
}
