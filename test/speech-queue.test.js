// Early speech: the speech queue (ui/src/speech-queue.js) keeps clips ordered, never overlapping, says a thinking phrase
// first (or skips it when the reply is already ready) and drops the fast turn's speech on an escalation reset; the
// streamed reply is cut into sentences as deltas arrive and only the spoken line is ever voiced (ui/src/sentences.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpeechQueue } from '../ui/src/speech-queue.js';
import { drain, spokenText } from '../ui/src/sentences.js';

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 5) { for (let i = 0; i < n; i++) await tick(); }
function deferred() { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }

// A queue with hand-driven renders and playback: render(text) waits for done(text); play waits for end().
function harness(opts = {}) {
  const log = [];
  const renders = new Map();
  let current = null;
  let concurrent = 0;
  let maxConcurrent = 0;
  const q = createSpeechQueue({
    prefetch: opts.prefetch,
    render: (text, signal) => {
      const d = deferred();
      renders.set(text, d);
      log.push(`render:${text}`);
      signal?.addEventListener('abort', () => log.push(`abort:${text}`));
      return d.p;
    },
    play: (audio, it) => {
      const d = deferred();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      log.push(`play:${it.kind}:${it.text}:${audio}`);
      current = { text: it.text, end: () => { if (current?.text === it.text) current = null; concurrent--; log.push(`end:${it.text}`); d.resolve(); } };
      return d.p;
    },
    cut: () => { log.push('cut'); current?.end(); },
    onIdle: () => log.push('idle'),
    onSkip: (it) => log.push(`skip:${it.text}`),
  });
  return {
    q, log,
    done: async (text, audio = `wav(${text})`) => { await settle(); renders.get(text).resolve(audio); await settle(); },
    fail: async (text) => { await settle(); renders.get(text).reject(new Error('tts 500')); await settle(); },
    end: async () => { current?.end(); await settle(); },
    get playing() { return current?.text || null; },
    get maxConcurrent() { return maxConcurrent; },
    plays: () => log.filter((l) => l.startsWith('play:')).map((l) => l.split(':')[2]),
  };
}

test('sentences render one after another (the next while one plays) and play in the order pushed, one at a time', async () => {
  const h = harness();
  h.q.push('One.'); h.q.push('Two.'); h.q.push('Three.');
  await settle();
  assert.deepEqual(h.log.filter((l) => l.startsWith('render:')), ['render:One.'], 'a short first sentence never waits behind a long second one');
  await h.done('One.');
  assert.equal(h.playing, 'One.');
  assert.ok(h.log.includes('render:Two.'), 'Two renders while One plays');
  assert.ok(!h.log.includes('render:Three.'), 'at most `prefetch` (2) sentences are rendered at once');
  await h.done('Two.');
  assert.equal(h.playing, 'One.', 'Two is ready but waits for One to finish');
  await h.end(); assert.equal(h.playing, 'Two.');
  assert.ok(h.log.includes('render:Three.'), 'Three renders while Two plays');
  await h.done('Three.');
  assert.equal(h.playing, 'Two.');
  await h.end(); assert.equal(h.playing, 'Three.');
  await h.end();
  assert.deepEqual(h.plays(), ['One.', 'Two.', 'Three.']);
  assert.equal(h.maxConcurrent, 1);
  assert.equal(h.log.at(-1), 'idle');
  assert.equal(h.q.busy, false);
});

test('a thinking phrase renders alongside the first sentence, never queued behind it', async () => {
  const h = harness();
  h.q.think('Just a moment.'); // not pre-rendered: the queue renders it
  h.q.push('Answer.');
  await settle();
  assert.ok(h.log.includes('render:Just a moment.') && h.log.includes('render:Answer.'));
  await h.done('Just a moment.');
  assert.equal(h.playing, 'Just a moment.');
  await h.done('Answer.');
  await h.end();
  assert.equal(h.playing, 'Answer.');
  await h.end();
  assert.deepEqual(h.plays(), ['Just a moment.', 'Answer.']);
});

test('a thinking phrase plays at once from its pre-rendered audio; the reply follows it without overlap', async () => {
  const h = harness();
  assert.equal(h.q.think('One moment, sir.', 'cached-wav'), true);
  await settle();
  assert.equal(h.playing, 'One moment, sir.');
  assert.ok(!h.log.some((l) => l.startsWith('render:One moment')), 'pre-rendered: no TTS call');
  h.q.push('The mesh is healthy.');
  await h.done('The mesh is healthy.');
  assert.equal(h.playing, 'One moment, sir.', 'the phrase finishes; the ready sentence waits');
  await h.end();
  assert.equal(h.playing, 'The mesh is healthy.');
  await h.end();
  assert.deepEqual(h.plays(), ['One moment, sir.', 'The mesh is healthy.']);
  assert.equal(h.maxConcurrent, 1);
});

test('the thinking phrase is skipped when the reply\'s first sentence is ready before the phrase can start', async () => {
  const h = harness();
  const phrase = deferred();
  h.q.think('Bear with me a second.', phrase.p); // its audio is still rendering
  h.q.push('Done, sir.');
  await h.done('Done, sir.');
  assert.ok(h.log.includes('skip:Bear with me a second.'));
  assert.equal(h.playing, 'Done, sir.');
  phrase.resolve('late-wav');
  await settle();
  await h.end();
  assert.deepEqual(h.plays(), ['Done, sir.'], 'the late phrase never plays');
});

test('think() is refused while anything is queued or playing, so it never talks over a reply', async () => {
  const h = harness();
  h.q.push('Already talking.');
  assert.equal(h.q.think('One moment, sir.', 'wav'), false);
  await h.done('Already talking.');
  assert.equal(h.q.think('One moment, sir.', 'wav'), false);
  await h.end();
  assert.equal(h.q.think('One moment, sir.', 'wav'), true, 'idle again: allowed');
  assert.equal(h.q.think('', 'wav'), false);
});

test('reset (escalation) drops the fast turn\'s queued speech, aborts its renders and keeps the thinking phrase', async () => {
  const h = harness();
  h.q.think('Let me look into that.', 'wav');
  await settle();
  h.q.push('Fast answer one.'); h.q.push('Fast answer two.');
  await settle();
  h.q.reset();
  await settle();
  assert.ok(h.log.includes('abort:Fast answer one.'), 'the in-flight render is aborted');
  assert.ok(!h.log.includes('render:Fast answer two.'), 'the queued sentence never renders');
  assert.equal(h.playing, 'Let me look into that.', 'the phrase is not cut');
  assert.ok(!h.log.includes('cut'));
  h.q.push('Full brain answer.');
  await h.done('Full brain answer.');
  await h.end(); // phrase ends
  assert.equal(h.playing, 'Full brain answer.');
  await h.end();
  assert.deepEqual(h.plays(), ['Let me look into that.', 'Full brain answer.']);
});

test('reset while a fast-turn sentence is playing cuts it cleanly and nothing else from that turn plays', async () => {
  const h = harness();
  h.q.push('Fast one.'); h.q.push('Fast two.');
  await h.done('Fast one.');
  await h.done('Fast two.');
  assert.equal(h.playing, 'Fast one.');
  h.q.reset();
  await settle();
  assert.ok(h.log.includes('cut'));
  assert.equal(h.playing, null);
  h.q.push('Full answer.');
  await h.done('Full answer.');
  await h.end();
  assert.deepEqual(h.plays(), ['Fast one.', 'Full answer.']);
  assert.equal(h.maxConcurrent, 1);
});

test('stop silences at once, drops everything and the queue works again afterwards', async () => {
  const h = harness();
  h.q.think('On it, sir.', 'wav');
  h.q.push('A.'); h.q.push('B.');
  await settle();
  h.q.stop();
  await settle();
  assert.ok(h.log.includes('cut') && h.log.includes('abort:A.'));
  assert.equal(h.q.length, 0);
  h.q.push('C.');
  await h.done('C.');
  assert.equal(h.playing, 'C.');
  await h.end();
  assert.deepEqual(h.plays(), ['On it, sir.', 'C.']);
});

test('a failed render is handed to play as null (the browser voice says it) and the queue moves on', async () => {
  const h = harness();
  h.q.push('X.'); h.q.push('Y.');
  await h.fail('X.');
  assert.ok(h.log.includes('play:speech:X.:null'));
  await h.done('Y.');
  await h.end();
  await h.end();
  assert.deepEqual(h.plays(), ['X.', 'Y.']);
});

// What main.js + voice.js do with chat `delta` events: spokenText over the reply so far, new characters fed to the
// chunker, complete sentences queued at once.
function streamSpeech(deltas) {
  const out = []; // [{ chunk, afterDelta }]
  let reply = '';
  let fed = 0;
  let buf = '';
  let first = true;
  deltas.forEach((d, i) => {
    reply += d;
    const say = spokenText(reply);
    if (say.length > fed) { buf += say.slice(fed); fed = say.length; }
    const r = drain(buf, { first });
    for (const c of r.chunks) { out.push({ chunk: c, afterDelta: i }); first = false; }
    buf = r.rest;
  });
  const say = spokenText(reply, true);
  if (say.length > fed) buf += say.slice(fed);
  if (say.length >= fed && buf.trim()) out.push({ chunk: buf, afterDelta: deltas.length }); // main.js: feed('', true, say.length >= fed)
  return out;
}
const tokens = (s) => s.match(/\S+\s*|\s+/g);

test('streamed reply: the first sentence is released while the rest is still streaming; nothing after --- is spoken', () => {
  const reply = 'Certainly, sir. Four machines are online and all of them are healthy. The Ubuntu box is running warm.\n---\n```visual\n{"kind":"status","items":[]}\n```\nDetails: magix-system 72% CPU.';
  const parts = streamSpeech(tokens(reply));
  assert.deepEqual(parts.map((p) => p.chunk), ['Certainly, sir. ', 'Four machines are online and all of them are healthy. ', 'The Ubuntu box is running warm.\n']);
  assert.ok(parts[0].afterDelta <= 3, 'first sentence goes to the voice after its third token');
  assert.ok(parts.every((p) => !/visual|kind|magix|Details|---/.test(p.chunk)));
});

test('streamed reply: fenced code or visual blocks are never spoken, even without a --- separator', () => {
  const reply = 'Here is the fix, sir.\n```js\nconst x = await fetch(url);\n```\nIt retries twice.';
  const spoken = streamSpeech(tokens(reply)).map((p) => p.chunk).join('');
  assert.equal(spoken.trim(), 'Here is the fix, sir.');
  // char by char, so a half-typed fence or separator is at the end of the text at some point
  const byChar = streamSpeech([...'Done, sir.\n``' + '`visual\n{"kind":"bars"}\n```']).map((p) => p.chunk).join('');
  assert.equal(byChar.trim(), 'Done, sir.');
  const sep = streamSpeech([...'All set.\n---\nWritten only.']).map((p) => p.chunk).join('');
  assert.equal(sep.trim(), 'All set.');
});

test('streamed reply past the spoken-length cap: whole sentences only, never a half sentence at the end', () => {
  // the reply from a measured run (after.json, 452 chars): the last sentence crosses the 420-char cap
  const reply = 'The sky is blue because sunlight, which looks white, is really a mix of all colours. As it passes through the atmosphere, it collides with air molecules that scatter short wavelengths, such as blue, far more strongly than long ones like red. That scattered blue light reaches your eyes from every direction, so the whole sky glows with it. At sunset the light travels through much more air, the blue is scattered away, and the reds and oranges are what remain.';
  const parts = streamSpeech(tokens(reply)).map((p) => p.chunk);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((c) => /[.!?]\s*$/.test(c)), JSON.stringify(parts));
  assert.ok(!parts.join('').includes('At sunset'));
});

test('spokenText: the spoken line, held-back partial markers while streaming, and the length cap', () => {
  assert.equal(spokenText('Hello.\n---\nhidden'), 'Hello.');
  assert.equal(spokenText('Hello.\n--'), 'Hello.', 'a half-typed --- is held back while streaming');
  assert.equal(spokenText('Hello.\n--', true), 'Hello.\n--', 'the final text is kept as written');
  assert.equal(spokenText('Look: ``'), 'Look: ', 'a half-typed fence is held back');
  assert.equal(spokenText('Look:\n```js\ncode'), 'Look:\n');
  assert.equal(spokenText('Inline ```x``` here', true), 'Inline ');
  const long = 'This sentence is long enough to count. '.repeat(20);
  const s = spokenText(long, true);
  assert.ok(s.length <= 420 && s.endsWith('.'));
});
