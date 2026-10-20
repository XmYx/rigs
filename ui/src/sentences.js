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
