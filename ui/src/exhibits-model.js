// The pure side of the Exhibit window (ui/src/exhibits.js): folding live pushes into a document, the picker's list,
// URLs and wording. No DOM and no imports, so test/exhibits-ui.test.js runs it in Node.
//
// Document shape (src/exhibits.js): { docId, scope: 'request'|'project', title, entries: [{ id, seq, kind, title,
// caption, visual, image: { src, file?, alt, source } | null, at }], final, finalAt, created, updated, dropped }.
// WebSocket pushes: { type: 'exhibit', docId, entry, final } · { type: 'exhibit-image', docId, entry } ·
// { type: 'exhibit-final', docId, at } · { type: 'exhibit-live', docId, kind, text, at } (a present-tense "now" line for a
// running stage, sent before any entry exists and never stored). 'exhibit-entry' is accepted as another name for 'exhibit'.

export const KIND_LABEL = { intake: 'Request', plan: 'Plan', step: 'Step', code: 'Code', result: 'Result', milestone: 'Milestone', summary: 'Summary' };

/** Which push is this? 'entry' | 'image' | 'final' | 'live' | null. */
export function pushKind(m) {
  if (!m || !m.docId) return null;
  if (m.type === 'exhibit-live') return m.text ? 'live' : null;
  if (m.type === 'exhibit' || m.type === 'exhibit-entry') return m.entry ? 'entry' : null;
  if (m.type === 'exhibit-image') return m.entry ? 'image' : null;
  if (m.type === 'exhibit-final') return 'final';
  return null;
}

export const emptyDoc = (docId) => ({
  docId, scope: String(docId).startsWith('pr-') ? 'project' : 'request', title: '', entries: [], final: false, finalAt: null, created: null, updated: null, dropped: 0,
});

/**
 * Fold one push into a document (returns { doc, entry, isNew } — doc is the same object, changed in place). An entry
 * is placed by seq and deduplicated by id, so the same entry arriving by push and by a fetch is shown once; an image
 * push replaces the picture of the entry it names. Pure apart from mutating `doc`.
 */
export function applyPush(doc, m) {
  const kind = pushKind(m);
  if (!kind) return { doc, entry: null, isNew: false };
  if (kind === 'live') return { doc, entry: null, isNew: false };
  if (kind === 'final') {
    doc.final = true;
    doc.finalAt = m.at || doc.finalAt || Date.now();
    return { doc, entry: null, isNew: false };
  }
  const e = m.entry;
  const i = doc.entries.findIndex((x) => x.id === e.id);
  if (kind === 'image') {
    if (i >= 0) doc.entries[i] = { ...doc.entries[i], image: e.image || doc.entries[i].image };
    return { doc, entry: i >= 0 ? doc.entries[i] : null, isNew: false };
  }
  let isNew = false;
  if (i >= 0) doc.entries[i] = { ...doc.entries[i], ...e };
  else { doc.entries.push(e); doc.entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)); isNew = true; }
  if (m.final) { doc.final = true; doc.finalAt = doc.finalAt || m.at || e.at || null; }
  doc.updated = Math.max(doc.updated || 0, e.at || 0) || doc.updated;
  return { doc, entry: doc.entries.find((x) => x.id === e.id), isNew };
}

/** Is this push the first one of a document this page has not seen? (the window opens for it) */
export const startsDocument = (seen, m) => ['entry', 'live'].includes(pushKind(m)) && !seen.has(m.docId);

/**
 * The ticker of a document: its last few "now" lines, newest last, repeats of the same text folded into one. Returns
 * a new array (the previous one is not changed). A final push clears it elsewhere (see clearTicker). Pure.
 */
export function pushLive(lines = [], m, max = 4) {
  if (pushKind(m) !== 'live') return lines;
  if (lines.at(-1)?.text === m.text) return lines;
  return [...lines, { text: String(m.text), kind: m.kind || '', at: m.at || Date.now() }].slice(-max);
}

/** Title of the shown document: the server's, else the request's own words from its first entry. */
export function titleOf(doc) {
  if (doc.title) return doc.title;
  const first = doc.entries.find((e) => e.kind === 'intake') || doc.entries[0];
  return first ? first.title : docHeading(doc);
}

/** Summary row of a loaded document, as the list API gives them. */
export const summaryOf = (d, node = '') => ({ docId: d.docId, scope: d.scope, title: d.title || '', entries: d.entries.length, final: !!d.final, finalAt: d.finalAt || null, created: d.created || null, updated: d.updated || null, node });

/**
 * The picker's rows: the fetched list (mesh, newest first) with the documents this page knows live laid over it, by
 * docId, newest first, at most `limit`. Pure.
 */
export function pickerRows(listed = [], live = [], limit = 30) {
  const by = new Map();
  for (const d of listed) by.set(d.docId, d);
  for (const d of live) by.set(d.docId, { ...(by.get(d.docId) || {}), ...d, node: d.node || by.get(d.docId)?.node || '' });
  return [...by.values()].sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0)).slice(0, limit);
}

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1).trimEnd() + '…' : String(s));

/** Heading of a document: its title, else what it is. */
export const docHeading = (d) => d.title || (d.scope === 'project' ? `Project ${String(d.docId).slice(3)}` : `Request ${d.docId}`);

/** A picker option's label: "Request · add dark mode · 5 · live". */
export function rowLabel(d) {
  const kind = d.scope === 'project' ? 'Project' : 'Request';
  const n = d.entries ?? 0;
  return `${kind} · ${clip(d.title || d.docId, 44)} · ${n} · ${d.final ? 'final' : 'live'}`;
}

/** Entry count wording for the header. */
export const countText = (n) => `${n} exhibit${n === 1 ? '' : 's'}`;

/** Where the documents of `node` live on the API ('' → the gateway's own machine). */
export const docBase = (node) => `/api/nodes/${encodeURIComponent(node || 'self')}/exhibits`;

/** URL of the document, its export (format html|md, download adds Content-Disposition) or one of its stored images. */
export const docUrl = (node, docId) => `${docBase(node)}/${encodeURIComponent(docId)}`;
export const exportUrl = (node, docId, format = 'html', download = false) => `${docUrl(node, docId)}/export?format=${format === 'md' ? 'md' : 'html'}${download ? '&download=1' : ''}`;

/**
 * The src to show for an entry's picture. SVGs are data URIs and stay; a stored ComfyUI picture is named by `file`
 * and fetched through the node that holds it (its stored src is relative to that machine).
 */
export function imageSrc(entry, node, docId) {
  const img = entry?.image;
  if (!img?.src) return '';
  if (img.file && img.source === 'comfyui') return `${docUrl(node, docId)}/images/${encodeURIComponent(img.file)}`;
  return img.src;
}

/** Plain-text name of a card, for assistive tech (the live region announces new ones). */
export const entryText = (e) => `${KIND_LABEL[e.kind] || e.kind}: ${e.title}${e.caption ? '. ' + e.caption : ''}`;

/** The picked document after the list changed: keep it if still there, else the newest. Pure. */
export function keepSelection(rows, docId) {
  return rows.some((r) => r.docId === docId) ? docId : (rows[0]?.docId || null);
}

/**
 * Should a new document take over the window? Only when nothing is shown, the shown one is finished, or the person is
 * following the live work — never when they picked an older document to read.
 */
export function shouldFollow({ current, currentFinal, follow }) {
  return !current || currentFinal || follow;
}

/**
 * Fold a fetched document into the one this page holds (same docId): entries it lacks are added, the server's title,
 * final state and timestamps win. Nothing already shown is dropped. Returns the added entries. Pure apart from `doc`.
 */
export function mergeDoc(doc, fetched) {
  const added = [];
  for (const e of fetched?.entries || []) {
    const r = applyPush(doc, { type: 'exhibit', docId: doc.docId, entry: e });
    if (r.isNew) added.push(e);
  }
  if (!fetched) return added;
  if (fetched.title) doc.title = fetched.title;
  if (fetched.final) { doc.final = true; doc.finalAt = fetched.finalAt || doc.finalAt; }
  for (const k of ['created', 'updated', 'dropped']) if (fetched[k] != null) doc[k] = Math.max(Number(doc[k]) || 0, Number(fetched[k]) || 0) || fetched[k];
  return added;
}
