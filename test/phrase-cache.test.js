// Thinking phrases stay in the voice that is speaking: a phrase a stand-in voice rendered while Kokoro was down is
// rendered again once Kokoro answers, and the other way round, so phrases and sentences never mix voices.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhraseCache } from '../ui/src/phrase-cache.js';

// A fake renderer: engine() says who answers right now; every render is logged.
function setup(first = 'neural') {
  const log = [];
  let engine = first;
  const cache = createPhraseCache(async (text) => { log.push([text, engine]); return { text, engine }; });
  return { cache, log, setEngine: (e) => { engine = e; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('phrases are rendered once and served from the cache', async () => {
  const { cache, log } = setup();
  await cache.get('One moment, sir.');
  await cache.get('One moment, sir.');
  assert.deepEqual(log, [['One moment, sir.', 'neural']]);
  assert.ok(cache.has('One moment, sir.'));
});

test('Kokoro comes back: phrases rendered by the stand-in are rendered again in Kokoro', async () => {
  const { cache, log, setEngine } = setup('piper'); // Kokoro was down while the phrases were prewarmed
  await Promise.all(['A.', 'B.'].map((t) => cache.warm(t)));
  cache.note('piper');
  setEngine('neural');
  assert.deepEqual(cache.note('neural'), ['A.', 'B.']); // a sentence just came out of Kokoro
  await settle();
  assert.equal((await cache.get('A.')).engine, 'neural');
  assert.equal((await cache.get('B.')).engine, 'neural');
  assert.deepEqual(log.slice(2), [['A.', 'neural'], ['B.', 'neural']]);
});

test('Kokoro goes down: Kokoro phrases give way to the stand-in so the reply is not two voices', async () => {
  const { cache, setEngine } = setup('neural');
  await cache.warm('A.');
  cache.note('neural');
  setEngine('piper');
  assert.deepEqual(cache.note('piper'), ['A.']);
  await settle();
  assert.equal((await cache.get('A.')).engine, 'piper');
});

test('the same engine again changes nothing; failed and empty renders are not kept', async () => {
  const { cache, log } = setup();
  await cache.warm('A.');
  assert.deepEqual(cache.note('neural'), []);
  assert.deepEqual(cache.note('neural'), []);
  assert.equal(log.length, 1);
  const bad = createPhraseCache(async () => 'empty');
  await bad.warm('x');
  assert.equal(bad.has('x'), false);
  const boom = createPhraseCache(async () => { throw new Error('down'); });
  assert.equal(await boom.warm('x'), null);
  assert.equal(boom.has('x'), false);
});

test('clear forgets the phrases and the live engine (a changed voice preference)', async () => {
  const { cache } = setup();
  await cache.warm('A.');
  cache.note('neural');
  assert.deepEqual(cache.keys(), ['A.']);
  cache.clear();
  assert.deepEqual(cache.keys(), []);
  assert.deepEqual(cache.note('piper'), []);
});
