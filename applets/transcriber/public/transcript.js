// Pure helpers for the Transcriber page: time formatting, export formats and recorder format choice.
// No DOM here, so test/transcriber.test.js can import it.

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 75 → "1:15", 3725 → "1:02:05" */
export function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Subtitle timestamp: 3.5 → "00:00:03,500" (SRT) or "00:00:03.500" (WebVTT, sep '.') */
export function stamp(sec, sep = ',') {
  const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}${sep}${pad(ms % 1000, 3)}`;
}

const usable = (segments) => (Array.isArray(segments) ? segments.filter((s) => s && String(s.text || '').trim()) : []);

export function toTxt(job) {
  const segs = usable(job.segments);
  return segs.length ? segs.map((s) => s.text.trim()).join('\n') : String(job.text || '');
}

export function toSrt(job) {
  return usable(job.segments).map((s, i) => `${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text.trim()}\n`).join('\n');
}

export function toVtt(job) {
  return `WEBVTT\n\n${usable(job.segments).map((s) => `${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${s.text.trim()}\n`).join('\n')}`;
}

export const EXPORTS = {
  txt: { make: toTxt, mime: 'text/plain;charset=utf-8', label: 'Text (.txt)' },
  srt: { make: toSrt, mime: 'application/x-subrip;charset=utf-8', label: 'Subtitles (.srt)' },
  vtt: { make: toVtt, mime: 'text/vtt;charset=utf-8', label: 'WebVTT (.vtt)' },
  json: { make: (job) => JSON.stringify({ name: job.name, language: job.language, duration: job.duration, text: job.text, segments: job.segments }, null, 2), mime: 'application/json', label: 'JSON (.json)' },
};

/** "minta.wav" + "srt" → "minta.srt" */
export function exportName(name, fmt) {
  const base = String(name || 'transcript').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim() || 'transcript';
  return `${base}.${fmt}`;
}

/** The first recording container this browser can produce (Chromium/Firefox: webm/ogg opus, Safari: mp4). */
export function pickMime(isSupported) {
  const wanted = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return wanted.find((m) => { try { return isSupported(m); } catch { return false; } }) || '';
}

export function extFor(mime) {
  const m = String(mime || '').toLowerCase();
  return m.includes('webm') ? 'webm' : m.includes('ogg') ? 'ogg' : m.includes('mp4') ? 'm4a' : 'webm';
}

/** "mikrofon-20261019-182200.webm" */
export function recordingName(date, mime) {
  const p = (n) => pad(n);
  return `mikrofon-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.${extFor(mime)}`;
}

/** One line for the status pill. */
export function engineLine(st) {
  if (!st) return { cls: 'warn', text: 'Connecting…' };
  if (!st.engine?.ok) return { cls: 'bad', text: st.engine?.error || 'Speech engine missing' };
  const where = st.device ? (st.device === 'cuda' ? 'GPU' : 'CPU') : '';
  if (st.state === 'loading') return { cls: 'warn', text: `Loading ${st.model}…` };
  if (st.state === 'ready') return { cls: 'ok', text: `${st.model}${where ? ` · ${where}` : ''}${st.busy ? ' · working' : ' · ready'}` };
  return { cls: 'ok', text: `${st.model} · loads on first use` };
}
