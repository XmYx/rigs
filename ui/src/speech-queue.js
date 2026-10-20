// The order JARVIS speaks in: one thing at a time, never overlapping, never twice. voice.js gives it `render` (text →
// audio, e.g. a WAV from JARVIS's voice; null = "use the browser voice"), `play` (plays one rendered item and
// resolves when it ends) and `cut` (stops whatever is playing at once). No DOM here, so it is unit-tested
// (test/speech-queue.test.js).
//
// - push(text): a sentence of the reply. Sentences render one after another, up to `prefetch` ahead of the one playing,
//   and play in the order pushed.
// - think(text, audio?): a thinking phrase, said only when nothing else is queued or playing. It is skipped when the
//   reply's first sentence is ready before the phrase starts; once playing, it finishes, then the sentences follow.
// - reset(): the fast turn handed over to the full brain: drop every queued sentence (one playing is cut); a thinking
//   phrase stays.
// - stop(): silence now; everything queued is dropped and in-flight renders are aborted.

export function createSpeechQueue({ render, play, cut = () => {}, onIdle, onSkip, prefetch = 2 } = {}) {
  let gen = 0;
  let items = [];
  let running = false;
  let wake = null; // resolves when the queue changes or an item finishes rendering

  const notify = () => { const w = wake; wake = null; w?.(); };
  const changed = () => new Promise((r) => { wake = r; });

  const settle = (it, p) => {
    it.audio = Promise.resolve(p).catch(() => null).then((r) => { it.result = r; it.ready = true; fill(); notify(); return r; });
  };

  function startRender(it) {
    if (it.audio) return;
    it.ac = typeof AbortController === 'function' ? new AbortController() : null;
    settle(it, Promise.resolve().then(() => render(it.text, it.ac?.signal, it)));
  }

  // Render the thinking phrase (if any) and up to `prefetch` sentences ahead, one after another: a voice engine renders
  // one clip at a time, so a short first sentence must not wait behind a long second one (measured: 0.12 s → 1.25 s).
  function fill() {
    let n = 0;
    let prevReady = true;
    for (const it of items) {
      if (it.kind === 'thinking') { startRender(it); continue; }
      if (n++ >= prefetch || !prevReady) break;
      startRender(it);
      prevReady = it.ready;
    }
  }

  const firstSpeech = () => items.find((x) => x.kind === 'speech');
  const drop = (it) => { it.dropped = true; it.ac?.abort(); };

  async function pump() {
    if (running) return;
    running = true;
    const g = gen;
    try {
      while (items.length && g === gen) {
        const it = items[0];
        fill();
        if (it.kind === 'thinking' && firstSpeech()?.ready) { items.shift(); drop(it); onSkip?.(it); continue; } // the reply is ready: no filler
        if (!it.ready) { await Promise.race([it.audio, changed()]); continue; }
        it.playing = true;
        try { await play(it.result, it); } catch { /* a failed clip is skipped, never retried */ }
        it.playing = false;
        if (items[0] === it) items.shift();
      }
    } finally {
      running = false;
      if (g !== gen && items.length) pump();
      else if (!items.length) onIdle?.();
    }
  }

  function push(text) {
    if (!String(text || '').trim()) return false;
    items.push({ kind: 'speech', text, audio: null, ready: false, result: null });
    fill();
    notify();
    pump();
    return true;
  }

  /** Say a thinking phrase now, unless something is already queued or playing. `audio` = a pre-rendered result (or its promise). */
  function think(text, audio) {
    if (!String(text || '').trim() || items.length || running) return false;
    const it = { kind: 'thinking', text, audio: null, ready: false, result: null };
    if (audio !== undefined && audio !== null) settle(it, audio);
    items.unshift(it);
    fill();
    pump();
    return true;
  }

  function stop() {
    gen++;
    const wasPlaying = items.some((x) => x.playing);
    for (const it of items) drop(it);
    items = [];
    notify();
    if (wasPlaying) cut();
  }

  function reset() {
    if (items.find((x) => x.playing)?.kind === 'speech') { stop(); return; }
    for (const it of items) if (it.kind !== 'thinking') drop(it);
    items = items.filter((x) => x.kind === 'thinking');
    notify();
  }

  return {
    push,
    think,
    stop,
    reset,
    get length() { return items.length; },
    get busy() { return running || items.length > 0; },
    /** [{ kind, text, playing }]: for tests and timing logs. */
    snapshot: () => items.map((x) => ({ kind: x.kind, text: x.text, playing: !!x.playing })),
  };
}
