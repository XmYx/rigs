// Sentence chunking for streamed speech: pull the next speakable chunk off the text that has arrived so far.
// A sentence is released once the whitespace after its punctuation has arrived (so "3.5" mid-stream does not split early, and
// nothing before a match is dropped); a line break also ends a chunk. The first chunk of a reply may also end at a comma once it has run
// past `firstMax` characters, so a long opening sentence starts speaking sooner.
const SENTENCE = /([^.!?\n]+[.!?]+["')\]]?\s|[^\n]+\n)/;

/** → { chunk, rest } with chunk = '' when nothing is complete yet. */
export function nextChunk(queue, { first = false, firstMax = 80 } = {}) {
  const m = queue.match(SENTENCE);
  const end = m ? m.index + m[0].length : Infinity;
  if (first) {
    const cut = commaCut(queue, firstMax);
    if (cut && cut < end) return { chunk: queue.slice(0, cut), rest: queue.slice(cut) };
  }
  return m ? { chunk: queue.slice(0, end), rest: queue.slice(end) } : { chunk: '', rest: queue };
}

// index just after the first ", " / "; " / ": " that lies beyond `min` characters and has its whitespace, or 0
function commaCut(queue, min) {
  const re = /[,;:]\s/g;
  let m;
  while ((m = re.exec(queue))) if (m.index >= min) return m.index + 2;
  return 0;
}

// A reply is a short spoken line, optionally followed by a "---" line and a written description that is shown but
// never read out. Fenced blocks (```visual cards, code) are never read out either: speech stops at the first fence.
export const SEPARATOR = /(^|\n)[ \t]*-{3,}[ \t]*(\n|$)/;
const FENCE = /```|~~~/;
const SPOKEN_MAX = 420; // safety cap when a brain ignores the format: say the opening, show the rest

/**
 * The part of a (possibly still streaming) reply that is said aloud. While streaming (`final` false) a half-typed
 * "---" or fence at the end is held back, so it never reaches the voice before it is recognised.
 */
export function spokenText(text, final = false) {
  let s = String(text ?? '');
  const sep = s.match(SEPARATOR);
  if (sep) s = s.slice(0, sep.index);
  const fence = s.search(FENCE);
  if (fence >= 0) s = s.slice(0, fence);
  if (!final && !sep && fence < 0) s = s.replace(/\n[ \t]*-{1,2}[ \t]*$/, '').replace(/(?:`{1,2}|~{1,2})$/, '');
  if (s.length > SPOKEN_MAX) {
    const cut = s.slice(0, SPOKEN_MAX).search(/[.!?](?=[^.!?]*$)/);
    s = s.slice(0, cut > 80 ? cut + 1 : SPOKEN_MAX);
  }
  return s;
}

/** Split everything that is complete; `rest` is the unfinished tail. Returns { chunks, rest }. */
export function drain(queue, opts = {}) {
  const chunks = [];
  let rest = queue;
  let first = !!opts.first;
  for (;;) {
    const r = nextChunk(rest, { ...opts, first });
    if (!r.chunk) break;
    chunks.push(r.chunk);
    rest = r.rest;
    first = false;
  }
  return { chunks, rest };
}
