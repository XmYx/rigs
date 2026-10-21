// Pure logic behind the file browser's preview pane and Quick Look (finder-preview.js draws it): which viewer a file
// gets, the audio/video transport maths, a small syntax tokenizer and a Markdown parser. No DOM here, so tests run it.

const ext = (name) => (/\.([^./\\]+)$/.exec(String(name || ''))?.[1] || '').toLowerCase();

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv']);
const AUDIO = new Set(['mp3', 'm4a', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac']);
const MARKDOWN = new Set(['md', 'markdown']);
const TEXT = new Set(['txt', 'rst', 'log', 'json', 'jsonl', 'ndjson', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'conf', 'csv', 'tsv', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'sql', 'env', 'lock', 'properties', 'tex', 'vue', 'svelte', 'lua',
  'pl', 'php', 'r', 'gradle', 'service', 'gitignore', 'dockerignore', 'dockerfile']);

/** Largest file the pane reads as text, and how much of it is drawn (the rest says "truncated"). */
export const TEXT_LIMIT = 2 * 1024 * 1024;
export const TEXT_SHOWN = 200000;

/**
 * Which viewer an entry gets: folder · image · video · audio · pdf · markdown · text · info (big icon plus details).
 * A file with no extension (Makefile, LICENSE) is text unless it is too large to read.
 */
export function viewerFor(entry) {
  if (!entry) return 'none';
  if (entry.type === 'dir') return 'folder';
  const name = entry.name || entry.path || '';
  const e = ext(name);
  if (IMAGE.has(e)) return 'image';
  if (VIDEO.has(e)) return 'video';
  if (AUDIO.has(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  const textual = TEXT.has(e) || MARKDOWN.has(e) || !e;
  if (textual && (entry.size ?? 0) > TEXT_LIMIT) return 'info';
  if (MARKDOWN.has(e)) return 'markdown';
  if (textual) return 'text';
  return 'info';
}

/** Does Quick Look have something to show for it (folders and unknown binaries only get the info card)? */
export const isMedia = (entry) => ['video', 'audio'].includes(viewerFor(entry));

/** The language a code viewer highlights as. */
export function langOf(name) {
  const e = ext(name);
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'php', 'scss', 'less', 'css', 'gradle'].includes(e)) return 'c';
  if (['py', 'rb', 'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'pl', 'r', 'env', 'ps1', 'gitignore', 'dockerfile', 'service', 'properties'].includes(e)) return 'hash';
  if (['json', 'jsonl', 'ndjson'].includes(e)) return 'json';
  if (['html', 'htm', 'xml', 'svg', 'vue', 'svelte'].includes(e)) return 'markup';
  if (['sql', 'lua'].includes(e)) return 'dash';
  return 'plain';
}

// ------------------------------------------------------------------ transport (audio and video)

/** 83 → "1:23", 3723 → "1:02:03"; unknown or infinite → "--:--". */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** A scrub position (0..1 of the bar) → seconds into a clip of `duration`; 0 while the duration is unknown. */
export const seekTime = (fraction, duration) => (Number.isFinite(duration) && duration > 0 ? clamp01(fraction) * duration : 0);

/** Playhead as a 0..1 fraction of the bar. */
export const progressOf = (time, duration) => (Number.isFinite(duration) && duration > 0 ? clamp01(time / duration) : 0);

/** ← / → on the transport: seconds to skip, bounded to the clip. */
export const skipTime = (time, delta, duration) => Math.min(Number.isFinite(duration) ? duration : Infinity, Math.max(0, time + delta));

// ------------------------------------------------------------------ Quick Look

/**
 * What Quick Look steps through: the selection when several are picked, otherwise every file in the folder (Finder
 * steps through the folder from a single selection). → { list, index } or null when `entry` is not a file.
 */
export function quickLookSet(selected, shown, entry) {
  if (!entry || entry.type === 'dir') return null;
  const list = selected.length > 1 ? selected.filter((x) => x.type !== 'dir') : shown.filter((x) => x.type !== 'dir');
  const index = list.findIndex((x) => x.path === entry.path);
  return index < 0 ? null : { list, index };
}

/** Arrow keys inside Quick Look: ← ↑ previous, → ↓ next, wrapping round. */
export function quickLookStep(index, count, key) {
  if (!count) return 0;
  const d = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : key === 'ArrowRight' || key === 'ArrowDown' ? 1 : 0;
  return (((index + d) % count) + count) % count;
}

// ------------------------------------------------------------------ syntax tokenizer

const KEYWORDS = new Set(('abstract as async await break case catch class const continue def default defer del do elif else enum export extends ' +
  'false final finally fn for from func function go if impl import in interface is lambda let match new nil none None null package pass pub raise return ' +
  'self static struct super switch this throw true True False try type typeof use var void while with yield select insert update delete create table where ' +
  'join on set values into limit order group by and or not echo fi then done esac local readonly').split(' '));

const RULES = {
  c: [['com', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y], ['str', /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?/y]],
  hash: [['com', /#[^\n]*/y], ['str', /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y]],
  json: [['str', /"(?:\\.|[^"\\\n])*"?/y]],
  markup: [['com', /<!--[\s\S]*?(?:-->|$)/y], ['str', /"[^"\n]*"?|'[^'\n]*'?/y], ['kw', /<\/?[A-Za-z][\w:-]*|\/?>/y]],
  dash: [['com', /--[^\n]*/y], ['str', /'(?:''|[^'])*'?|"[^"\n]*"?/y]],
  plain: [],
};
const NUM = /(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/iy;
const WORD = /[A-Za-z_$][\w$]*/y;

/** Split source into [{ t: 'kw'|'str'|'com'|'num'|'', s }] runs for the given language (langOf). Never throws; joins back to `code`. */
export function highlight(code, lang = 'plain') {
  const text = String(code ?? '');
  const rules = RULES[lang] || RULES.plain;
  const out = [];
  const push = (t, s) => { if (!s) return; const last = out[out.length - 1]; if (last && last.t === t) last.s += s; else out.push({ t, s }); };
  if (lang === 'plain' || text.length > 400000) { push('', text); return out; }
  let i = 0;
  while (i < text.length) {
    let hit = null;
    for (const [t, re] of rules) { re.lastIndex = i; const m = re.exec(text); if (m) { hit = [t, m[0]]; break; } }
    if (!hit) {
      NUM.lastIndex = i; WORD.lastIndex = i;
      const prev = text[i - 1] || '';
      const n = !/[\w$]/.test(prev) && NUM.exec(text);
      const w = WORD.exec(text);
      if (n) hit = ['num', n[0]];
      else if (w) hit = [KEYWORDS.has(w[0]) && lang !== 'json' && lang !== 'markup' ? 'kw' : '', w[0]];
      else hit = ['', text[i]];
    }
    push(hit[0], hit[1]);
    i += hit[1].length;
  }
  return out;
}

// ------------------------------------------------------------------ Markdown

/** Only links that cannot run script: http(s), mailto, and relative ones. */
export const safeHref = (u) => (/^\s*(?:https?:|mailto:|#|\.{0,2}\/|[\w.-]+(?:\/|$))/i.test(u) && !/^\s*javascript:/i.test(u) ? String(u).trim() : '');

/** Inline Markdown → [{ t: 'text'|'code'|'strong'|'em'|'del'|'link'|'image', s, href? }]. */
export function parseInline(src) {
  const out = [];
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;
  let last = 0;
  let m;
  const text = String(src ?? '');
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', s: text.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ t: 'code', s: m[2].trim() });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: 'strong', s: m[3] ?? m[4] });
    else if (m[5] !== undefined) out.push({ t: 'del', s: m[5] });
    else if (m[6] !== undefined || m[7] !== undefined) out.push({ t: 'em', s: m[6] ?? m[7] });
    else if (m[9] !== undefined) out.push({ t: 'image', s: m[8] || 'image', href: safeHref(m[9]) });
    else out.push({ t: 'link', s: m[10], href: safeHref(m[11]) });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', s: text.slice(last) });
  return out;
}

/**
 * Block-level Markdown → [{ type: 'h', level, text } | { type: 'p', text } | { type: 'code', lang, text } | { type: 'quote', text }
 * | { type: 'ul'|'ol', items: [text] } | { type: 'hr' } | { type: 'table', head: [], rows: [[]] }]. Text is inline Markdown.
 */
export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const startsBlock = (l) => /^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+[.)]\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^```\s*([\w+-]*)/.exec(l))) {
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      blocks.push({ type: 'code', lang: m[1], text: body.join('\n') });
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { blocks.push({ type: 'h', level: m[1].length, text: m[2] }); i++; }
    else if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { blocks.push({ type: 'hr' }); i++; }
    else if (/^>\s?/.test(l)) {
      const q = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ''));
      blocks.push({ type: 'quote', text: q.join('\n') });
    } else if (/^\s*[-*+]\s/.test(l) || /^\s*\d+[.)]\s/.test(l)) {
      const ordered = /^\s*\d+[.)]\s/.test(l);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      for (; i < lines.length && re.test(lines[i]); i++) items.push(lines[i].replace(re, ''));
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
    } else if (l.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      blocks.push({ type: 'table', head, rows });
    } else {
      const p = [l];
      for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i]); i++) p.push(lines[i]);
      blocks.push({ type: 'p', text: p.join('\n') });
    }
  }
  return blocks;
}
