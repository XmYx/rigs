// Hearing without Web Speech: Firefox has no SpeechRecognition and Chromium on Linux has the API but no
// working backend, so the microphone is recorded here and transcribed by the mesh's own Whisper
// (POST /api/local/stt → the jarvis-voice app). Raw PCM through a ScriptProcessor (works in every
// browser, no codec differences), an energy voice-activity detector with an adaptive noise floor, a
// 300 ms pre-roll so the first syllable ("Jarvis") isn't clipped, and 16 kHz mono WAV uploads.

const PRE_ROLL = 0.3; // s kept from before speech starts
const MIN_SPEECH = 0.35; // s; shorter blips are dropped
const MAX_UTTERANCE = 15; // s

/** 16 kHz mono 16-bit WAV from Float32 chunks at `rate`. Pure. */
export function encodeWav(chunks, rate, outRate = 16000) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / outRate;
  const n = Math.floor(total / ratio);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let ci = 0;
  let base = 0; // index of chunks[ci][0] in the whole stream
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    while (ci < chunks.length - 1 && pos >= base + chunks[ci].length) { base += chunks[ci].length; ci++; }
    const c = chunks[ci];
    const s = Math.max(-1, Math.min(1, c[Math.min(c.length - 1, Math.floor(pos - base))]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * createHearing({ onText, onLevel, onActivity, onError, isSpeaking }).start({ continuous })
 *  - continuous=false (push to talk): one utterance, then it stops (also after 8 s of nothing).
 *  - continuous=true (hands-free): every utterance is transcribed until stop().
 * onText(text) gets each transcript; onActivity('speech'|'sending'|'idle'|'stopped') drives the UI;
 * isSpeaking() = JARVIS is talking, which raises the threshold so its own voice isn't heard as yours.
 */
export function createHearing({ onText, onLevel, onActivity, onError, isSpeaking = () => false }) {
  let live = null;

  async function send(chunks, rate) {
    onActivity?.('sending');
    try {
      const r = await fetch('/api/local/stt', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encodeWav(chunks, rate) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `speech recognition: HTTP ${r.status}`);
      if (j.text) onText?.(j.text);
    } catch (e) { onError?.(e); }
    finally { onActivity?.(live ? 'idle' : 'stopped'); }
  }

  async function start({ continuous = false } = {}) {
    stop();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination); // a processor only runs while connected to the output
    const rate = ctx.sampleRate;
    const frame = 2048 / rate;
    const pre = [];
    let speech = null; // Float32Array[] while an utterance is being captured
    let loud = 0;
    let quiet = 0;
    let floor = 0.006;
    const startedAt = performance.now();
    const me = { stream, ctx, proc, continuous };
    live = me;

    proc.onaudioprocess = (ev) => {
      if (live !== me) return;
      const x = new Float32Array(ev.inputBuffer.getChannelData(0));
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      onLevel?.(Math.min(1, rms * 8));
      floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.995 + rms * 0.005; // falls fast, rises slowly
      const thr = Math.max(0.012, floor * 3) * (isSpeaking() ? 2.5 : 1);
      if (!speech) {
        pre.push(x);
        while (pre.length * frame > PRE_ROLL) pre.shift();
        loud = rms > thr ? loud + 1 : 0;
        if (loud * frame >= 0.12) { speech = [...pre]; pre.length = 0; quiet = 0; onActivity?.('speech'); }
        else if (!continuous && performance.now() - startedAt > 8000) stop();
        return;
      }
      speech.push(x);
      quiet = rms < thr * 0.7 ? quiet + 1 : 0;
      const len = speech.length * frame;
      if (quiet * frame >= (continuous ? 0.9 : 1.2) || len >= MAX_UTTERANCE) {
        const chunks = speech;
        speech = null;
        loud = 0;
        if (!continuous) stop();
        if (len - quiet * frame >= MIN_SPEECH) send(chunks, rate);
        else onActivity?.(live ? 'idle' : 'stopped');
      }
    };
    onActivity?.('idle');
    return true;
  }

  function stop() {
    const l = live;
    live = null;
    if (!l) return;
    try { l.proc.disconnect(); } catch {}
    l.stream.getTracks().forEach((t) => t.stop());
    l.ctx.close().catch(() => {});
    onLevel?.(0);
    onActivity?.('stopped');
  }

  return { start, stop, get active() { return !!live; }, get continuous() { return !!live?.continuous; } };
}
