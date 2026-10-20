// Pre-rendered thinking phrases that stay in one voice. Every render reports the engine that made it (the server's
// x-tts-engine header). JARVIS's voice is Kokoro, with piper / the machine's engine only standing in while Kokoro is
// down, so a phrase cached during an outage would keep sounding like the stand-in after Kokoro is back, and a phrase
// cached from Kokoro would clash with sentences rendered by a stand-in. The cache therefore follows the engine of the
// latest render: when it changes, every phrase made by another engine is dropped and rendered again. Pure; the
// render function is injected, so it is unit-tested.

/** render(text) → Promise<{ engine?: string, … } | 'empty' | null>; a null / 'empty' result is not kept. */
export function createPhraseCache(render) {
  const entries = new Map(); // text → { promise, engine }
  let live = null; // engine of the latest render

  function warm(text) {
    const e = { promise: null, engine: null };
    e.promise = Promise.resolve().then(() => render(text)).catch(() => null).then((r) => {
      if (!r || r === 'empty') { if (entries.get(text) === e) entries.delete(text); return r; }
      e.engine = r.engine || null;
      return r;
    });
    entries.set(text, e);
    return e.promise;
  }

  return {
    has: (text) => entries.has(text),
    keys: () => [...entries.keys()],
    /** The cached render (or a fresh one) as a promise. */
    get: (text) => entries.get(text)?.promise || warm(text),
    warm,
    clear: () => { entries.clear(); live = null; },
    /** Report the engine that just rendered anything (a sentence or a phrase); re-renders the phrases made by another one. */
    note(engine) {
      if (!engine || engine === live) return [];
      live = engine;
      const stale = [];
      for (const [text, e] of entries) if (e.engine && e.engine !== engine) stale.push(text);
      for (const text of stale) { entries.delete(text); warm(text); }
      return stale;
    },
  };
}
