// Voice in (Web Speech recognition, wake word "Jarvis", barge-in) and voice out (speech synthesis,
// sentence-by-sentence while the reply streams). Needs a secure context: localhost or
// https://<machine>.<tailnet>.ts.net (rigs setup --https).

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function createVoice({ onTranscript, onInterim, onState, onLevel, wakeWord = 'jarvis' }) {
  const supported = !!SR && window.isSecureContext;
  let rec = null;
  let mode = 'off'; // off | ptt | handsfree
  let speaking = false;
  let muted = localStorage.getItem('rigs.muted') === '1';
  let voiceName = localStorage.getItem('rigs.voice') || '';
  let queue = '';
  let meter = null;

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    if (voiceName) { const v = voices.find((x) => x.name === voiceName); if (v) return v; }
    const prefs = ['Daniel', 'Google UK English Male', 'Microsoft Ryan', 'Microsoft George', 'Arthur', 'Oliver', 'en-GB'];
    for (const p of prefs) { const v = voices.find((x) => x.name.includes(p) || x.lang === p); if (v) return v; }
    return voices.find((x) => x.lang?.startsWith('en')) || voices[0];
  }

  function speakNow(text) {
    if (muted || !text.trim() || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text.replace(/[*_`#>]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1'));
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = 1.04;
    u.pitch = 0.95;
    u.onstart = () => { speaking = true; onState?.('speaking'); };
    u.onboundary = () => onLevel?.(0.4 + Math.random() * 0.6);
    u.onend = () => { if (!speechSynthesis.speaking) { speaking = false; onLevel?.(0); onState?.(mode === 'handsfree' ? 'listening' : 'online'); } };
    speechSynthesis.speak(u);
  }

  /** Feed streaming text; complete sentences are spoken as they arrive. */
  function feed(delta, final = false) {
    queue += delta;
    const re = /([^.!?\n]+[.!?]+["')\]]?\s|[^\n]+\n)/;
    let m;
    while ((m = queue.match(re))) {
      speakNow(m[0]);
      queue = queue.slice(m.index + m[0].length);
    }
    if (final) { speakNow(queue); queue = ''; }
  }

  function stopSpeaking() {
    queue = '';
    if (window.speechSynthesis) speechSynthesis.cancel();
    speaking = false;
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
    r.onerror = (e) => { if (e.error === 'not-allowed') { mode = 'off'; onState?.('error'); } };
    r.onend = () => {
      if (mode === 'handsfree') { try { r.start(); } catch {} } else { mode = 'off'; stopMeter(); if (!speaking) onState?.('online'); }
    };
    return r;
  }

  return {
    supported,
    get mode() { return mode; },
    get muted() { return muted; },
    pushToTalk() {
      if (!supported) return false;
      stopSpeaking();
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
    setMuted(v) { muted = v; localStorage.setItem('rigs.muted', v ? '1' : '0'); if (v) stopSpeaking(); },
    voices: () => (window.speechSynthesis ? speechSynthesis.getVoices().filter((v) => v.lang?.startsWith('en')) : []),
    setVoice(name) { voiceName = name; localStorage.setItem('rigs.voice', name); },
    get voiceName() { return pickVoice()?.name || ''; },
  };
}
