// Voice in (Web Speech recognition, wake word "Jarvis", barge-in) and voice out, sentence-by-sentence
// while the reply streams (speech-queue.js keeps it in order; think() says a pre-rendered thinking phrase first). Output prefers the server's TTS (/api/local/tts → WAV through one
// AudioContext), because Safari and Chrome silently drop speechSynthesis started outside a user
// gesture — and streamed replies and notifications always arrive later. The AudioContext is unlocked
// on the first click/key; speechSynthesis stays as the fallback. Recognition needs a secure context:
// localhost or https://<machine>.<tailnet>.ts.net (rigs setup --https).

// Hearing: Web Speech where it works (Chrome/Edge on macOS & Windows, Safari); everywhere else — Firefox,
// and Chromium on Linux, whose SpeechRecognition exists but has no backend — the microphone is recorded and
// transcribed by the mesh's own Whisper (hearing.js). localStorage rigs.stt = "server" | "browser" forces one.
import { createHearing } from './hearing.js';
import { drain } from './sentences.js';
import { createSpeechQueue } from './speech-queue.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const AC = window.AudioContext || window.webkitAudioContext;
const WAKE = /\b(jarvis|jarvas|jervis|javis|jarv[iu]s)\b[\s,.!?]*/i;

function preferServerHearing() {
  const forced = localStorage.getItem('rigs.stt');
  if (forced === 'server') return true;
  if (forced === 'browser') return !SR;
  return !SR || (/Linux/.test(navigator.platform || navigator.userAgent) && !/Android/.test(navigator.userAgent));
}

// onAudio({ kind: 'thinking'|'speech', text }) fires as each clip starts playing (timing logs); onSkip(text) when a
// thinking phrase is dropped because the reply was already ready.
export function createVoice({ onTranscript, onInterim, onState, onLevel, onSpeech, onAudio, onSkip, wakeWord = 'jarvis' }) {
  let serverHearing = preferServerHearing();
  const canRecord = !!navigator.mediaDevices?.getUserMedia;
  const supported = window.isSecureContext && (!!SR || canRecord);
  let rec = null;
  let mode = 'off'; // off | ptt | handsfree
  let speaking = false;
  let muted = localStorage.getItem('rigs.muted') === '1';
  let pref = parsePref(localStorage.getItem('rigs.voice') || '');
  let queue = '';
  let spokeFirst = false; // the first chunk of a reply may be cut at a comma (sentences.js)
  let meter = null;

  // ---- output: server voice through Web Audio, browser speechSynthesis as fallback
  let ctx = null;
  let analyser = null;
  let server = { engine: null, voice: '', voices: [] };
  let source = null;
  let levelRaf = 0;
  const phraseAudio = new Map(); // thinking phrase → Promise<rendered audio>, pre-rendered from the bundled voice
  let finishCurrent = null; // resolves the sentence that is playing right now (stop() never fires onended)
  const utterances = new Set(); // Safari garbage-collects utterances (and drops onend) unless referenced

  function parsePref(v) {
    if (v.startsWith('system:')) return { kind: 'system', name: v.slice(7) };
    if (v.startsWith('browser:')) return { kind: 'browser', name: v.slice(8) };
    return { kind: 'system', name: '' }; // legacy unprefixed values → default server voice
  }

  function ensureCtx() {
    if (!AC) return null;
    if (!ctx) {
      try {
        ctx = new AC();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.connect(ctx.destination);
      } catch { ctx = null; return null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  let synthUnlocked = false;
  function unlock() {
    ensureCtx();
    if (!synthUnlocked && window.speechSynthesis) {
      synthUnlocked = true;
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {}
    }
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true, passive: true });

  const ready = fetch('/api/local/tts').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) server = j; }).catch(() => {});

  const useServer = () => pref.kind === 'system' && !!server.engine && !!AC;

  function setSpeaking(on) {
    if (on === speaking) return;
    speaking = on;
    if (on) onState?.('speaking');
    else { onLevel?.(0); onState?.(mode === 'handsfree' ? 'listening' : 'online'); }
  }

  function browserVoice() {
    if (!window.speechSynthesis) return null;
    const voices = speechSynthesis.getVoices();
    if (pref.kind === 'browser' && pref.name) { const v = voices.find((x) => x.name === pref.name); if (v) return v; }
    const prefs = ['Daniel', 'Google UK English Male', 'Microsoft Ryan', 'Microsoft George', 'Arthur', 'Oliver', 'en-GB'];
    for (const p of prefs) { const v = voices.find((x) => x.name.includes(p) || x.lang === p); if (v) return v; }
    return voices.find((x) => x.lang?.startsWith('en')) || voices[0];
  }

  function clean(text) { return text.replace(/[*_`#>]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1'); }

  function speakBrowser(text) {
    if (!window.speechSynthesis) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(clean(text));
      const v = browserVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1.04;
      u.pitch = 0.95;
      utterances.add(u);
      const done = () => { utterances.delete(u); if (finishCurrent === done) finishCurrent = null; resolve(); };
      finishCurrent = done;
      u.onstart = () => setSpeaking(true);
      u.onboundary = () => onLevel?.(0.4 + Math.random() * 0.6);
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  // → { buffer, cues } | 'empty' (nothing to say) | null (no server voice: the browser voice speaks it instead)
  function fetchAudio(text, signal) {
    return (async () => {
      await ready;
      if (!useServer() || signal?.aborted) return null;
      const r = await fetch('/api/local/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: pref.name || undefined }), signal });
      if (r.status === 204) return 'empty';
      if (!r.ok) throw new Error('tts ' + r.status);
      let cues = null; // lipsync timeline when the engine sends one (x-visemes): [[start, end, viseme], …]
      try { const v = r.headers.get('x-visemes'); if (v) cues = JSON.parse(atob(v)).cues || null; } catch { cues = null; }
      const data = await r.arrayBuffer();
      if (signal?.aborted) return null;
      const c = ensureCtx();
      // Safari's webkitAudioContext only has the callback form of decodeAudioData.
      const buffer = await new Promise((res, rej) => { const p = c.decodeAudioData(data, res, rej); if (p?.then) p.then(res, rej); });
      return { buffer, cues };
    })().catch(() => null);
  }

  function meterLoop() {
    cancelAnimationFrame(levelRaf);
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!source) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const b of buf) sum += ((b - 128) / 128) ** 2;
      onLevel?.(Math.min(1, Math.sqrt(sum / buf.length) * 5));
      levelRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function playBuffer({ buffer, cues }) {
    return new Promise((resolve) => {
      const c = ensureCtx();
      const s = c.createBufferSource();
      s.buffer = buffer;
      s.connect(analyser);
      const done = () => { if (source === s) source = null; if (finishCurrent === done) finishCurrent = null; resolve(); };
      s.onended = done;
      finishCurrent = done;
      source = s;
      setSpeaking(true);
      const startAt = c.currentTime + 0.02; // scheduled, so the face and the sound share one clock
      s.start(startAt);
      onSpeech?.({ cues, startAt, ctx: c, analyser, duration: buffer.duration });
      meterLoop();
    });
  }

  // Stop whatever clip is playing right now (the queue decides what plays next).
  function cutAudio() {
    if (source) { try { source.onended = null; source.stop(); } catch {} source = null; }
    onSpeech?.(null);
    cancelAnimationFrame(levelRaf);
    if (window.speechSynthesis) speechSynthesis.cancel();
    utterances.clear();
    const f = finishCurrent;
    finishCurrent = null;
    f?.();
  }

  // One clip at a time, in order (speech-queue.js): the next sentence renders on the server while this one plays.
  const q = createSpeechQueue({
    render: (text, signal) => fetchAudio(text, signal),
    play: (audio, item) => {
      if (audio === 'empty') return undefined;
      onAudio?.({ kind: item.kind, text: item.text });
      return audio ? playBuffer(audio) : speakBrowser(item.text);
    },
    cut: cutAudio,
    onIdle: () => setSpeaking(false),
    onSkip: (item) => onSkip?.(item.text),
  });

  function speakNow(text) {
    if (muted || !text.trim()) return;
    q.push(text);
  }

  /** Thinking phrases: render each once from the bundled voice so think() plays at once. */
  function prewarm(list) {
    ready.then(() => {
      if (!useServer()) return;
      for (const t of list) if (!phraseAudio.has(t)) cachePhrase(t);
    });
  }
  function cachePhrase(text) {
    const p = fetchAudio(text).then((r) => { if (!r || r === 'empty') phraseAudio.delete(text); return r; });
    phraseAudio.set(text, p);
    return p;
  }

  /** Say a thinking phrase now, unless JARVIS is already speaking or muted. → true when queued. */
  function think(text) {
    if (muted || !String(text || '').trim()) return false;
    return q.think(text, phraseAudio.get(text) || cachePhrase(text));
  }

  /** Feed streaming text; complete sentences are spoken as they arrive. */
  // keepTail false at the end drops an unfinished last sentence (the reply ran past the spoken-length cap).
  function feed(delta, final = false, keepTail = true) {
    queue += delta;
    const d = drain(queue, { first: !spokeFirst });
    for (const c of d.chunks) { speakNow(c); spokeFirst = true; }
    queue = d.rest;
    if (final) { if (keepTail) speakNow(queue); queue = ''; spokeFirst = false; }
  }

  function stopSpeaking() {
    queue = '';
    spokeFirst = false;
    q.stop();
    cutAudio();
    speaking = false;
  }

  /** The fast turn handed over (status reset): drop its queued speech and half-fed text; a thinking phrase plays on. */
  function resetSpeech() {
    queue = '';
    spokeFirst = false;
    q.reset();
  }

  async function startMeter() {
    if (meter) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let raf;
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const b of buf) sum += ((b - 128) / 128) ** 2;
        if (!speaking) onLevel?.(Math.min(1, Math.sqrt(sum / buf.length) * 6));
        raf = requestAnimationFrame(tick);
      };
      tick();
      meter = { stop: () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ctx.close(); } };
    } catch {}
  }
  function stopMeter() { meter?.stop(); meter = null; onLevel?.(0); }

  // ---- server hearing (Whisper on the mesh)
  let armedUntil = 0;
  const hearing = createHearing({
    isSpeaking: () => speaking,
    onLevel: (v) => { if (!speaking) onLevel?.(v); },
    onActivity: (a) => {
      if (a === 'speech') onInterim?.('…');
      else if (a === 'sending') onInterim?.('… transcribing');
      else if (a === 'stopped' && mode === 'ptt') { mode = 'off'; onInterim?.(''); if (!speaking) onState?.('online'); }
    },
    onError: (e) => { onInterim?.(''); console.warn('[voice] hearing:', e.message); onState?.('error'); setTimeout(() => onState?.(mode === 'handsfree' ? 'listening' : 'online'), 2500); },
    onText: (raw) => {
      let t = raw.trim();
      const m = t.match(WAKE);
      if (mode === 'ptt') {
        if (m && m.index === 0) t = t.slice(m[0].length);
        onInterim?.('');
        if (t) onTranscript?.(t);
        return;
      }
      if (mode !== 'handsfree') return;
      if (m) {
        if (speaking) stopSpeaking(); // barge-in only on the wake word (echo of our own voice never says it)
        t = t.slice(m.index + m[0].length).trim();
        if (!t) { armedUntil = Date.now() + 8000; onInterim?.(''); onState?.('listening'); return; }
        armedUntil = 0; onInterim?.(''); onTranscript?.(t); return;
      }
      if (Date.now() < armedUntil) { armedUntil = 0; onInterim?.(''); onTranscript?.(t); return; }
      onInterim?.('');
    },
  });

  function startServerHearing(continuous) {
    hearing.start({ continuous }).catch((e) => { mode = 'off'; onState?.('error'); console.warn('[voice] microphone:', e.message); });
  }

  function makeRec(continuous) {
    const r = new SR();
    r.lang = navigator.language || 'en-US';
    r.continuous = continuous;
    r.interimResults = true;
    let armed = !continuous; // push-to-talk is always "armed"; hands-free waits for the wake word
    let armedAt = 0;
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        let text = res[0].transcript.trim();
        const lower = text.toLowerCase();
        // Barge-in: any speech while JARVIS talks cuts it off.
        if (speaking && text.length > 2) stopSpeaking();
        if (!armed) {
          const idx = lower.indexOf(wakeWord);
          if (idx < 0) continue;
          armed = true;
          armedAt = Date.now();
          onState?.('listening');
          text = text.slice(idx + wakeWord.length).replace(/^[\s,.!?]+/, '');
        } else if (continuous && lower.startsWith(wakeWord)) {
          text = text.slice(wakeWord.length).replace(/^[\s,.!?]+/, '');
        }
        if (res.isFinal) {
          if (text) { onTranscript?.(text); if (continuous) armed = false; }
          else if (continuous && Date.now() - armedAt > 8000) armed = false;
        } else interim += text;
      }
      onInterim?.(interim);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed') { mode = 'off'; onState?.('error'); return; }
      if ((e.error === 'network' || e.error === 'service-not-allowed' || e.error === 'language-not-supported') && canRecord && !serverHearing) {
        // this browser's speech service is unreachable (e.g. Chromium on Linux): switch to Whisper on the mesh
        serverHearing = true;
        const m = mode;
        rec = null;
        if (m === 'ptt' || m === 'handsfree') startServerHearing(m === 'handsfree');
      }
    };
    r.onend = () => {
      if (serverHearing) return;
      if (mode === 'handsfree') { try { r.start(); } catch {} } else { mode = 'off'; stopMeter(); if (!speaking) onState?.('online'); }
    };
    return r;
  }

  return {
    supported,
    get hearing() { return serverHearing ? 'whisper' : 'browser'; },
    get mode() { return mode; },
    get muted() { return muted; },
    pushToTalk() {
      if (!supported) return false;
      stopSpeaking();
      if (serverHearing) {
        if (mode === 'ptt') { hearing.stop(); return true; }
        mode = 'ptt';
        startServerHearing(false);
        onState?.('listening');
        return true;
      }
      if (mode === 'ptt') { rec?.stop(); return true; }
      if (mode === 'handsfree') rec?.stop();
      mode = 'ptt';
      rec = makeRec(false);
      rec.start();
      startMeter();
      onState?.('listening');
      return true;
    },
    toggleHandsFree() {
      if (!supported) return false;
      if (serverHearing) {
        if (mode === 'handsfree') { mode = 'off'; hearing.stop(); onState?.('online'); return false; }
        mode = 'handsfree';
        startServerHearing(true);
        onState?.('online');
        return true;
      }
      if (mode === 'handsfree') { mode = 'off'; rec?.stop(); stopMeter(); onState?.('online'); return false; }
      rec?.stop();
      mode = 'handsfree';
      rec = makeRec(true);
      rec.start();
      startMeter();
      onState?.('online');
      return true;
    },
    feed,
    say(text) { stopSpeaking(); feed(text, true); },
    stop: stopSpeaking,
    think,
    reset: resetSpeech,
    prewarm,
    get speaking() { return speaking || q.busy || !!window.speechSynthesis?.speaking; },
    setMuted(v) { muted = v; localStorage.setItem('rigs.muted', v ? '1' : '0'); if (v) stopSpeaking(); },
    /** Server voices first (this machine's TTS), then this browser's voices: [{ id, label }]. */
    voices() {
      const out = [];
      if (server.engine && AC) {
        out.push({ id: 'system:', label: `System default${server.voice ? ` (${server.voice})` : ''} — ${server.engine}` });
        for (const v of server.voices.filter((x) => !x.lang || x.lang.startsWith('en'))) out.push({ id: 'system:' + v.name, label: `${v.name} (${v.lang || server.engine}) — system` });
      }
      if (window.speechSynthesis) for (const v of speechSynthesis.getVoices().filter((x) => x.lang?.startsWith('en'))) out.push({ id: 'browser:' + v.name, label: `${v.name} (${v.lang}) — browser` });
      return out;
    },
    get voiceId() {
      if (pref.kind === 'browser') return 'browser:' + (browserVoice()?.name || pref.name);
      return server.engine ? 'system:' + pref.name : 'browser:' + (browserVoice()?.name || '');
    },
    setVoice(id) {
      pref = parsePref(id || '');
      localStorage.setItem('rigs.voice', id || '');
      const phrases = [...phraseAudio.keys()];
      phraseAudio.clear(); // rendered in the old voice
      prewarm(phrases);
    },
  };
}
