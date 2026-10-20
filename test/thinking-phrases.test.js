// Thinking phrases (src/thinking-phrases.js): the curated set, the on/off switch and the picker that never repeats.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { THINKING_PHRASES, allPhrases, fillPhrase, pickPhrase, thinkingEnabled } from '../src/thinking-phrases.js';

test('the set is small, short and in JARVIS\'s register', () => {
  assert.ok(THINKING_PHRASES.length >= 4 && THINKING_PHRASES.length <= 12);
  for (const p of THINKING_PHRASES) {
    assert.ok(fillPhrase(p).length <= 40, p);
    assert.match(fillPhrase(p), /[.!?]$/, p);
  }
  assert.ok(allPhrases().includes('One moment, sir.'));
  assert.ok(allPhrases().includes('Let me look into that.'));
});

test('fillPhrase uses persona.address and drops it cleanly when there is none', () => {
  assert.equal(fillPhrase('One moment, {address}.', 'ma\'am'), 'One moment, ma\'am.');
  assert.equal(fillPhrase('One moment, {address}.', ''), 'One moment.');
  assert.equal(fillPhrase('Right away, {address}. Checking now.', ''), 'Right away. Checking now.');
  assert.equal(fillPhrase('Bear with me a second.', 'boss'), 'Bear with me a second.');
});

test('pickPhrase never says the same phrase twice in a row', () => {
  let last = '';
  for (let i = 0; i < 500; i++) {
    const p = pickPhrase({ last });
    assert.ok(allPhrases().includes(p));
    assert.notEqual(p, last);
    last = p;
  }
  // even when the random source keeps asking for the same slot
  const first = pickPhrase({ rand: () => 0 });
  assert.notEqual(pickPhrase({ last: first, rand: () => 0 }), first);
  // an unfilled template as `last` counts as the same phrase
  assert.equal(pickPhrase({ last: 'One moment, {address}.', rand: () => 0, list: ['One moment, {address}.', 'Just a moment.'] }), 'Just a moment.');
});

test('pickPhrase covers the whole set and handles edge lists', () => {
  const seen = new Set();
  let last = '';
  for (let i = 0; i < 400; i++) { last = pickPhrase({ last }); seen.add(last); }
  assert.equal(seen.size, allPhrases().length);
  assert.equal(pickPhrase({ list: ['Only one.'], last: 'Only one.' }), 'Only one.'); // one phrase: it may repeat
  assert.equal(pickPhrase({ list: [] }), '');
  assert.equal(pickPhrase({ rand: () => 0.999999 }), allPhrases().at(-1)); // rand near 1 stays in range
});

test('thinking phrases are on by default and switch off with persona.thinkingPhrases: false', () => {
  assert.equal(thinkingEnabled({}), true); // an older config without the key
  assert.equal(thinkingEnabled(undefined), true);
  assert.equal(thinkingEnabled({ thinkingPhrases: true }), true);
  assert.equal(thinkingEnabled({ thinkingPhrases: false }), false);
  // the shipped default persona has it on
  assert.match(fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8'), /persona: \{[^}]*thinkingPhrases: true[^}]*\}/);
});
