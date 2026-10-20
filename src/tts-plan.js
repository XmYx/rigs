// Pure parts of speech output: which engines to try and in what order, running that chain with silent
// fallback, and trimming the silence a voice puts around every clip, which delays first audio. JARVIS has one
// voice family, the bundled one: the resident piper voice, then the machine's own engine. No I/O here, so it is unit-tested.

/** persona.tts.engine: 'auto' (resident piper, then the machine's own) | 'piper' | 'local'. */
export const ENGINE_CHOICES = ['auto', 'piper', 'local'];
const DEFAULT_ORDER = ['piper', 'local'];

/** A voice request that names no particular voice: '' and the retired 'neural' / 'neural:x' ids a saved UI preference may still carry. */
export const wantsDefaultVoice = (voice) => !voice || voice === 'neural' || String(voice).startsWith('neural:');

/**
 * Ordered engines to try for one utterance. `voice` is the caller's request (default voice, or a named local voice,
 * which only the machine's own engine can speak). `up` says which engines are reachable right now; an unreachable
 * one is left out, so a stopped engine never costs a timeout.
 */
export function engineOrder({ voice = '', choice = 'auto', up = {} } = {}) {
  if (!wantsDefaultVoice(voice)) return ['local'];
  const pick = ENGINE_CHOICES.includes(choice) ? choice : 'auto';
  const order = pick === 'auto' ? DEFAULT_ORDER : [pick, ...DEFAULT_ORDER.filter((e) => e !== pick)];
  return order.filter((e) => (e === 'local' ? up.local !== false : up[e] === true));
}

/**
 * Try each engine in order; the first that does not throw wins (a null result means "nothing to say" and also wins).
 * Failures are reported through onFail(engine, error) so they reach the log, never the user. Throws only when every
 * engine failed (or there were none).
 */
export async function runChain(order, runners, onFail) {
  let last = null;
  for (const name of order) {
    const run = runners[name];
    if (!run) continue;
    try { return await run(); } catch (e) { last = e; onFail?.(name, e); }
  }
  throw last || new Error('no text-to-speech engine available');
}

// ---------------------------------------------------------------- WAV silence trimming
function wavInfo(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let o = 12;
  let fmt = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('latin1', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(o + 8), channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) return null;
      return { ...fmt, start: o + 8, end: Math.min(buf.length, o + 8 + size) };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

function buildWav(info, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(info.channels, 22); h.writeUInt32LE(info.rate, 24);
  h.writeUInt32LE(info.rate * info.channels * 2, 28); h.writeUInt16LE(info.channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Cut leading/trailing silence from a 16-bit PCM WAV, keeping `leadMs` before the first sound and `tailMs` after the
 * last. The viseme timeline ({cues: [[start, end, viseme], ...], duration}, base64 JSON, as the voice app sends it) is
 * shifted by the trimmed lead so the face stays in step. Anything unparseable comes back unchanged.
 */
export function trimSilence(audio, visemes = '', { leadMs = 30, tailMs = 150, threshold = 300 } = {}) {
  const info = wavInfo(audio);
  if (!info) return { audio, visemes, trimmedMs: 0 };
  const frame = info.channels * 2;
  const n = Math.floor((info.end - info.start) / frame);
  const loud = (i) => { for (let c = 0; c < info.channels; c++) if (Math.abs(audio.readInt16LE(info.start + i * frame + c * 2)) > threshold) return true; return false; };
  let first = 0;
  while (first < n && !loud(first)) first++;
  if (first === n) return { audio, visemes, trimmedMs: 0 }; // all silence: leave it alone
  let last = n - 1;
  while (last > first && !loud(last)) last--;
  const ms = (x) => Math.round((x * info.rate) / 1000);
  const from = Math.max(0, first - ms(leadMs));
  const to = Math.min(n, last + 1 + ms(tailMs));
  if (from === 0 && to === n) return { audio, visemes, trimmedMs: 0 };
  const out = buildWav(info, audio.subarray(info.start + from * frame, info.start + to * frame));
  const shift = from / info.rate;
  let v = visemes;
  if (visemes) {
    try {
      const t = JSON.parse(Buffer.from(visemes, 'base64').toString());
      const cues = (t.cues || []).map(([s, e, k]) => [Math.max(0, +(s - shift).toFixed(3)), +(e - shift).toFixed(3), k]).filter((c) => c[1] > 0);
      v = Buffer.from(JSON.stringify({ ...t, cues, duration: +((to - from) / info.rate).toFixed(3) })).toString('base64');
    } catch { /* leave the timeline as it was */ }
  }
  return { audio: out, visemes: v, trimmedMs: Math.round(((n - (to - from)) / info.rate) * 1000) };
}
