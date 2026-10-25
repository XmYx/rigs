// JARVIS's senses, served by App Cloud apps anywhere on the mesh (reached through this daemon's app proxy,
// like JARVIS's Kokoro voice in tts.js):
//  - hearing: speech-to-text by the "jarvis-voice" app (POST /stt, Whisper). Browsers record the
//    microphone and send the audio here, so it works where Web Speech recognition does not (Firefox,
//    Chromium on Linux).
//  - feeling: the emotion JARVIS's face shows for a line it says, decided by the "localjev" app
//    (githubnext/localjev, a Jev-compatible POST /v1/systemone on a local model). One yes/no question per
//    emotion, which small local models answer far more reliably than one multiple choice; the most
//    likely emotion wins, "neutral" when none is likely. A keyword guess stands in when LocalJev is down.
import * as appsReg from './apps.js';
import { config } from './config.js';

export const EMOTIONS = ['neutral', 'happy', 'amused', 'curious', 'concerned', 'sad', 'surprised', 'focused'];

const QUESTIONS = {
  happy: 'Does the speaker sound pleased or delighted (success, good news, praise)?',
  amused: 'Is the line ironic, sarcastic, teasing or a dry joke (saying the opposite of what is meant, e.g. calling a bad idea a bold choice)?',
  curious: 'Is the speaker asking a question or wanting to know something?',
  concerned: 'Is the speaker reporting a problem, failure, error, warning or risk?',
  sad: 'Is the speaker apologising or sorry about a loss or bad outcome?',
  surprised: 'Does the line express astonishment or disbelief, e.g. good heavens, wow, really?!, I did not expect that?',
  focused: 'Does the speaker say they are doing, running, checking or working on something right now (working on it, compiling, one moment)?',
};

const catalogAt = new Map();

/** Base URL of an App Cloud app: direct when it runs here, else through this daemon's proxy; null if down/unknown. */
export async function appBase(ref) {
  const [node, id] = String(ref).includes('/') ? String(ref).split('/', 2) : [null, String(ref)];
  const local = (!node || appsReg.isSelfRef(node)) && appsReg.localApps().apps.find((a) => a.id === id);
  if (local) return local.health?.status === 'down' ? null : local.target;
  const find = () => appsReg.meshCatalogApps().find((a) => a.id === id && (!node || a.node.toLowerCase() === node.toLowerCase()) && a.health?.status !== 'down');
  let hit = find();
  if (!hit && Date.now() - (catalogAt.get(id) || 0) > 60000) {
    catalogAt.set(id, Date.now());
    try { await fetch(`http://127.0.0.1:${config().port}/api/apps`, { signal: AbortSignal.timeout(8000) }); } catch { /* offline */ }
    hit = find();
  }
  return hit ? `http://127.0.0.1:${config().port}/api/nodes/${encodeURIComponent(hit.node)}/apps/${encodeURIComponent(id)}` : null;
}

/** Speech → text. `audio` is the raw recording (webm/ogg/mp4/wav). Returns { text, language, duration }. */
export async function stt(audio, { contentType = 'application/octet-stream', lang } = {}) {
  const base = await appBase(config().persona?.hearingApp || 'jarvis-voice');
  if (!base) {
    // Started on demand (src/tts.js wakeApp): the next recording finds it up.
    const woke = (await import('./tts.js')).wakeApp(config().persona?.hearingApp || 'jarvis-voice');
    throw Object.assign(new Error(woke ? 'speech recognition is starting (the jarvis-voice app was down) — try again in a moment' : 'no speech recognition on the mesh (the jarvis-voice app is down)'), { status: 503 });
  }
  const r = await fetch(`${base}/stt${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`, { method: 'POST', headers: { 'content-type': contentType }, body: audio, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `speech recognition: HTTP ${r.status}`), { status: 502 });
  return j;
}

/** Keyword guess, used when LocalJev is unavailable. Pure. */
export function guessEmotion(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(sorry|apolog|regret|unfortunately|lost)\b/.test(t)) return 'sad';
  if (/\b(fail|failed|error|broken|warning|afraid|crash|down|problem|can't|cannot)\b/.test(t)) return 'concerned';
  if (/\b(good heavens|wow|astonish|unexpected|incredible)\b|\?!/.test(t)) return 'surprised';
  if (/\b(working on|one moment|compiling|checking|running|let me)\b/.test(t)) return 'focused';
  if (/\b(splendid|excellent|great|done|ready|success|perfect|delighted|lovely)\b/.test(t)) return 'happy';
  if (/\?\s*$/.test(t.trim())) return 'curious';
  return 'neutral';
}

/** Pick the winning emotion from LocalJev yes/no probabilities. Pure. */
export function pickEmotion(probs, threshold = 0.5) {
  let best = 'neutral';
  let p = threshold;
  for (const [k, v] of Object.entries(probs || {})) if (EMOTIONS.includes(k) && typeof v === 'number' && v >= p) { best = k; p = v; }
  return best;
}

const cache = new Map(); // line → result (the same line is often asked again for a replay)

/** The emotion for a line JARVIS says: { emotion, confidence, scores, source: 'localjev' | 'guess' }. */
export async function emotion(text) {
  const line = String(text || '').trim().slice(0, 1200);
  if (!line) return { emotion: 'neutral', confidence: 1, scores: {}, source: 'guess' };
  if (cache.has(line)) return cache.get(line);
  let out;
  try {
    const base = await appBase(config().persona?.emotionApp || 'localjev');
    if (!base) throw new Error('localjev down');
    const body = { model: 'jev-latest', state: `JARVIS says: ${line}`, questions: Object.fromEntries(Object.entries(QUESTIONS).map(([k, v]) => [k, { type: 'noul', instructions: v }])) };
    const r = await fetch(`${base}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const scores = Object.fromEntries(Object.entries(j.answers || {}).map(([k, v]) => [k, Number(v?.noul ?? 0)]));
    const e = pickEmotion(scores);
    out = { emotion: e, confidence: e === 'neutral' ? 1 - Math.max(0, ...Object.values(scores)) : scores[e], scores, source: 'localjev' };
  } catch {
    out = { emotion: guessEmotion(line), confidence: 0.4, scores: {}, source: 'guess' };
  }
  cache.set(line, out);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return out;
}
