// Pure logic of the built-in file tools (ui/src/file-tools.js): which tool opens which file, the CSV parser,
// JSON validation with an error position, image stepping/zoom and the file browser's multi-selection. No DOM, so it
// is unit-tested in Node (test/file-tools.test.js).
import { mediaKind } from './media-player-model.js';

export const TOOLS = Object.freeze({
  text: { id: 'text', label: 'Text editor', icon: '📝' },
  image: { id: 'image', label: 'Image viewer', icon: '🖼' },
  pdf: { id: 'pdf', label: 'PDF viewer', icon: '📕' },
  csv: { id: 'csv', label: 'CSV viewer', icon: '▦' },
  json: { id: 'json', label: 'JSON viewer', icon: '{}' },
  media: { id: 'media', label: 'Media player', icon: '▶' },
});

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const PDF = /\.pdf$/i;
const CSV = /\.(csv|tsv)$/i;
const JSONX = /\.(json|geojson|webmanifest|har)$/i;
const ZIP = /\.zip$/i;
const TEXT = /\.(txt|md|markdown|rst|json|jsonl|ndjson|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|sh|bash|zsh|fish|ps1|bat|cmd|yml|yaml|toml|ini|cfg|conf|log|csv|tsv|html|htm|css|scss|less|xml|svg|sql|env|gitignore|dockerignore|dockerfile|lock|properties|tex|vue|svelte|lua|pl|php|r|gradle|service)$/i;
// Names with no extension (or a dotfile) that are text all the same.
const TEXT_NAMES = /^(readme|license|licence|makefile|dockerfile|changelog|authors|notice|procfile|gemfile|rakefile|\.[\w.-]+rc|\.env(\..+)?|\.gitignore|\.gitattributes|\.editorconfig)$/i;

const base = (name) => String(name || '').split(/[\\/]/).pop();

export const isZip = (name) => ZIP.test(base(name));
export const isText = (name) => { const n = base(name); return TEXT.test(n) || TEXT_NAMES.test(n) || !/.\.[^.]+$/.test(n); };

/** The tool a double-click opens for `name`, or null (download). */
export function toolFor(name) {
  const n = base(name);
  if (IMAGE.test(n)) return 'image';
  if (PDF.test(n)) return 'pdf';
  if (CSV.test(n)) return 'csv';
  if (JSONX.test(n)) return 'json';
  if (mediaKind(n)) return 'media'; // audio and video: the media player (media-player.js)
  if (isText(n)) return 'text';
  return null;
}

/** The tools "Open with" offers for `name`, the default first; the text editor for anything that is text. */
export function toolsFor(name) {
  const n = base(name);
  const first = toolFor(n);
  const out = first ? [first] : [];
  if (first && first !== 'text' && isText(n)) out.push('text');
  return out;
}

// ------------------------------------------------------------------ CSV

/**
 * RFC 4180 CSV: quoted fields may hold the delimiter, doubled quotes ("") and newlines; CRLF or LF rows; a BOM is
 * dropped; a final newline does not make an empty row. Stops after `maxRows` rows → { rows, truncated }.
 */
export function parseCSV(text, { delimiter = ',', maxRows = Infinity } = {}) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const d = delimiter || ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = s.length;
  const endRow = () => { row.push(field); rows.push(row); row = []; field = ''; };
  while (i < n) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (s.startsWith(d, i)) { row.push(field); field = ''; i += d.length; continue; }
    if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      if (rows.length >= maxRows) return { rows, truncated: i < n };
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length || quoted) endRow();
  return { rows, truncated: false };
}

export const DELIMITERS = Object.freeze([
  { id: ',', label: 'Comma ,' }, { id: ';', label: 'Semicolon ;' }, { id: '\t', label: 'Tab ⇥' }, { id: '|', label: 'Pipe |' },
]);

/** Guess the delimiter from the first lines: the candidate that splits them into the same (> 1) number of fields. */
export function sniffDelimiter(text, name = '') {
  if (/\.tsv$/i.test(name)) return '\t';
  const sample = String(text ?? '').slice(0, 20000);
  let best = ',';
  let bestScore = 0;
  for (const { id } of DELIMITERS) {
    const { rows } = parseCSV(sample, { delimiter: id, maxRows: 20 });
    const lines = rows.length > 1 ? rows.slice(0, -1) : rows; // the last sampled row may be cut off
    if (!lines.length) continue;
    const width = lines[0].length;
    if (width < 2) continue;
    const same = lines.filter((r) => r.length === width).length;
    const score = (same / lines.length) * 100 + width;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

const NUM = /^\s*[-+]?(\d+[.,]?\d*|[.,]\d+)([eE][-+]?\d+)?\s*%?\s*$/;
const asNum = (v) => (NUM.test(v) ? Number(String(v).replace(/%/, '').replace(',', '.')) : NaN);

/** Compare two cells: numbers numerically, empty cells last, else natural text order. */
export function compareCells(a = '', b = '') {
  if (a === '' || b === '') return a === b ? 0 : a === '' ? 1 : -1;
  const x = asNum(a);
  const y = asNum(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Rows sorted by column `col` ('asc' | 'desc'), stable, empty cells last both ways; the input is not changed. */
export function sortRows(rows, col, dir = 'asc') {
  const k = dir === 'desc' ? -1 : 1;
  return rows.map((r, i) => [r, i]).sort((p, q) => {
    const a = p[0][col] ?? '';
    const b = q[0][col] ?? '';
    if (a === '' || b === '') return compareCells(a, b) || p[1] - q[1];
    return k * compareCells(a, b) || p[1] - q[1];
  }).map(([r]) => r);
}

/** Next sort state when a column header is clicked: asc → desc → unsorted. */
export function nextSort(sort, col) {
  if (!sort || sort.col !== col) return { col, dir: 'asc' };
  return sort.dir === 'asc' ? { col, dir: 'desc' } : null;
}

// ------------------------------------------------------------------ JSON

/** 1-based line and column of `offset` in `text`. */
export function lineCol(text, offset) {
  const lines = String(text).slice(0, Math.max(0, offset)).split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

/** Where strict JSON parsing fails: { offset, message } or null (browsers word and place errors differently). */
export function locateJsonError(s) {
  let i = 0;
  const n = s.length;
  const fail = (message) => { throw Object.assign(new Error(message), { at: i }); };
  const ws = () => { while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  const str = () => {
    i++;
    while (i < n) {
      const c = s[i];
      if (c === '"') { i++; return; }
      if (c === '\\') {
        const e = s[i + 1];
        if (e !== undefined && '"\\/bfnrt'.includes(e)) { i += 2; continue; }
        if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { i += 6; continue; }
        fail('Bad escape in string');
      }
      if (c < ' ') fail('Control character (e.g. a raw newline) in string');
      i++;
    }
    fail('Unterminated string');
  };
  const value = (depth) => {
    if (depth > 2000) fail('Nested too deeply');
    ws();
    const c = s[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++; ws();
      if (s[i] === close) { i++; return; }
      for (;;) {
        ws();
        if (c === '{') {
          if (s[i] !== '"') fail(i >= n ? 'Unexpected end of input' : s[i] === '}' ? 'Trailing comma before }' : 'Expected a "quoted" property name');
          str(); ws();
          if (s[i] !== ':') fail("Expected ':' after the property name");
          i++;
        } else if (s[i] === ']') fail('Trailing comma before ]');
        value(depth + 1); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === close) { i++; return; }
        fail(i >= n ? 'Unexpected end of input' : `Expected ',' or '${close}'`);
      }
    }
    if (c === '"') return str();
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
      m.lastIndex = i;
      const r = m.exec(s);
      if (!r || r[0] === '-') fail('Bad number');
      i += r[0].length;
      return;
    }
    for (const lit of ['true', 'false', 'null']) if (s.startsWith(lit, i)) { i += lit.length; return; }
    if (i >= n) fail('Unexpected end of input');
    fail(`Unexpected character ${JSON.stringify(c)}`);
  };
  try {
    value(0); ws();
    if (i < n) fail('Unexpected text after the JSON value');
    return null;
  } catch (e) {
    if (e.at === undefined) throw e;
    return { offset: e.at, message: e.message };
  }
}

/**
 * Parse JSON → { ok: true, value } or { ok: false, message, offset, line, col, lineText }: where parsing stopped
 * (1-based line/col) and that line's text, for a caret under the spot.
 */
export function checkJSON(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  try { return { ok: true, value: JSON.parse(s) }; } catch (err) {
    const loc = locateJsonError(s) || { offset: s.length, message: err.message };
    const { line, col } = lineCol(s, loc.offset);
    return { ok: false, message: loc.message, offset: loc.offset, line, col, lineText: s.split('\n')[line - 1] ?? '' };
  }
}

export const jsonKind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** The collapsed label of an object/array: "{3 keys}", "[10 items]"; a scalar as JSON. */
export function jsonSummary(v) {
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (v && typeof v === 'object') { const k = Object.keys(v).length; return `{${k} key${k === 1 ? '' : 's'}}`; }
  return JSON.stringify(v);
}

/** The children to draw for an object/array, at most `limit` → { items: [[key, value]], more }. */
export function jsonChildren(v, limit = 500) {
  const all = Array.isArray(v) ? v.map((x, i) => [i, x]) : v && typeof v === 'object' ? Object.entries(v) : [];
  return { items: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

// ------------------------------------------------------------------ images

/** The images in a folder listing and where `path` is among them → { list: [entry], index }. */
export function imageSiblings(entries, path) {
  const list = (entries || []).filter((e) => e.type !== 'dir' && toolFor(e.name) === 'image');
  return { list, index: Math.max(0, list.findIndex((e) => e.path === path)) };
}

/** Step through n images, wrapping around. */
export const stepIndex = (i, n, d) => (n ? (((i + d) % n) + n) % n : 0);

export const ZOOMS = Object.freeze([0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]);

/** The next zoom step above (dir 1) or below (dir -1) `z`. */
export function zoomStep(z, dir) {
  if (dir > 0) return ZOOMS.find((x) => x > z + 1e-9) ?? ZOOMS[ZOOMS.length - 1];
  return [...ZOOMS].reverse().find((x) => x < z - 1e-9) ?? ZOOMS[0];
}

/** Scale that fits an image into a box without enlarging it. */
export function fitScale(w, h, boxW, boxH) {
  if (!w || !h || !boxW || !boxH) return 1;
  return Math.min(1, boxW / w, boxH / h);
}

// ------------------------------------------------------------------ editor + selection

export const isSaveKey = (e) => !!e && (e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 's';

export const editorTitle = (name, dirty) => `${dirty ? '● ' : ''}${name}`;

/**
 * The file browser's selection after a click: plain = just that row; Ctrl/⌘ = toggle it; Shift = the range from the
 * anchor. `paths` is the folder's row order → { picked: string[], anchor }.
 */
export function clickSelect({ picked = [], anchor = null }, paths, path, { ctrl = false, shift = false } = {}) {
  if (shift && anchor && paths.includes(anchor)) {
    const a = paths.indexOf(anchor);
    const b = paths.indexOf(path);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return { picked: paths.slice(lo, hi + 1), anchor };
  }
  if (ctrl) {
    const has = picked.includes(path);
    return { picked: has ? picked.filter((p) => p !== path) : [...picked, path], anchor: path };
  }
  return { picked: [path], anchor: path };
}

/** What a menu action on `path` applies to: the whole selection when the row is part of it, else that row alone. */
export const actionTargets = (picked, path) => (picked.length > 1 && picked.includes(path) ? [...picked] : [path]);
