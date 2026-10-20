// JARVIS's thinking phrases: a short line he says the moment a request is sent, so he answers at once while the
// router and the brain work. Shared by the server (config default) and the UI (voice.js pre-renders their audio
// from the bundled voice, main.js speaks one per request). Pure, tested in test/thinking-phrases.test.js.
// persona.thinkingPhrases: true (default) | false = today's behaviour, nothing is said before the reply.

/** The curated set, in JARVIS's register. `{address}` becomes persona.address ("sir"). Keep them short: under ~1.5 s. */
export const THINKING_PHRASES = [
  'One moment, {address}.',
  'Let me look into that.',
  'Right away, {address}. Checking now.',
  'Bear with me a second.',
  'On it, {address}.',
  'Just a moment.',
  'Looking into it now.',
  'Give me a second, {address}.',
];

/** True unless the persona switches thinking phrases off. */
export function thinkingEnabled(persona) {
  return persona?.thinkingPhrases !== false;
}

/** A phrase with `{address}` filled in (a missing address drops the ", {address}" part cleanly). */
export function fillPhrase(phrase, address = 'sir') {
  const a = String(address ?? '').trim();
  const s = String(phrase);
  return a ? s.replace(/\{address\}/g, a) : s.replace(/,?\s*\{address\}/g, '').replace(/\s+([.!?])/g, '$1');
}

/** Every phrase filled in for this address: the set the UI pre-renders. */
export function allPhrases(address = 'sir', list = THINKING_PHRASES) {
  return [...new Set(list.map((p) => fillPhrase(p, address)))];
}

/**
 * Pick the next phrase: random, never the same as `last` (the previously spoken phrase, filled or not) twice in a row.
 * `rand` is injectable for tests (returns [0, 1)).
 */
export function pickPhrase({ last = '', address = 'sir', rand = Math.random, list = THINKING_PHRASES } = {}) {
  const all = allPhrases(address, list);
  if (!all.length) return '';
  const lastFilled = last ? fillPhrase(last, address) : '';
  const pool = all.length > 1 ? all.filter((p) => p !== lastFilled) : all;
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  return pool[i];
}
