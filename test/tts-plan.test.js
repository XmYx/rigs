// Pure speech planning: engine order, silent fallback, silence trimming, sentence chunking for streamed speech.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineOrder, runChain, trimSilence } from '../src/tts-plan.js';
import { drain, nextChunk } from '../ui/src/sentences.js';

test('engineOrder: auto prefers neural, then piper, then the machine engine; unreachable engines are left out', () => {
  assert.deepEqual(engineOrder({ up: { piper: true } }), ['neural', 'piper', 'local']);
  assert.deepEqual(engineOrder({ up: { piper: false } }), ['neural', 'local']);
  assert.deepEqual(engineOrder({ neural: false, up: { piper: true, local: false } }), ['piper']);
  assert.deepEqual(engineOrder({ up: { piper: true, neural: false } }), ['piper', 'local']);
});

test('engineOrder: the chosen engine goes first, the rest remain as fallback; named local voices stay local', () => {
  assert.deepEqual(engineOrder({ choice: 'piper', up: { piper: true } }), ['piper', 'neural', 'local']);
  assert.deepEqual(engineOrder({ choice: 'local', up: { piper: true } }), ['local', 'neural', 'piper']);
  assert.deepEqual(engineOrder({ choice: 'bogus', up: { piper: true } }), ['neural', 'piper', 'local']);
  assert.deepEqual(engineOrder({ voice: 'Daniel', up: { piper: true } }), ['local']);
  assert.deepEqual(engineOrder({ voice: 'neural:bm_lewis', up: {} }), ['neural', 'local']);
});

test('runChain falls through failing engines, reports them, and keeps a null ("nothing to say") result', async () => {
  const failed = [];
  const r = await runChain(['neural', 'piper', 'local'], {
    neural: async () => { throw new Error('down'); },
    piper: async () => { throw new Error('refused'); },
    local: async () => ({ engine: 'espeak' }),
  }, (n, e) => failed.push([n, e.message]));
  assert.deepEqual(r, { engine: 'espeak' });
  assert.deepEqual(failed, [['neural', 'down'], ['piper', 'refused']]);
  assert.equal(await runChain(['neural', 'local'], { neural: async () => null, local: async () => assert.fail('not reached') }), null);
  await assert.rejects(runChain(['neural'], { neural: async () => { throw new Error('boom'); } }), /boom/);
  await assert.rejects(runChain([], {}), /no text-to-speech engine/);
});

function wav(samples, rate = 24000) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => pcm.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const dataLen = (b) => b.readUInt32LE(40);

test('trimSilence cuts the lead/tail, keeps a margin and shifts the viseme cues', () => {
  const rate = 24000;
  const lead = new Array(Math.round(rate * 0.28)).fill(0); // 280 ms
  const tail = new Array(Math.round(rate * 0.7)).fill(0); // 700 ms
  const speech = new Array(Math.round(rate * 0.5)).fill(5000);
  const cues = Buffer.from(JSON.stringify({ cues: [[0.28, 0.4, 'aa'], [0.4, 0.78, 'oh']], duration: 1.48 })).toString('base64');
  const r = trimSilence(wav([...lead, ...speech, ...tail]), cues);
  const secs = dataLen(r.audio) / 2 / rate;
  assert.ok(Math.abs(secs - (0.03 + 0.5 + 0.15)) < 0.002, `trimmed length ${secs}`);
  assert.ok(Math.abs(r.trimmedMs - 800) <= 2);
  const t = JSON.parse(Buffer.from(r.visemes, 'base64').toString());
  assert.deepEqual(t.cues[0], [0.03, 0.15, 'aa']);
  assert.ok(Math.abs(t.duration - secs) < 0.002);
});

test('trimSilence leaves silent, tight, non-WAV and non-16-bit audio alone', () => {
  const silent = wav(new Array(2400).fill(0));
  assert.equal(trimSilence(silent).audio, silent);
  const tight = wav(new Array(2400).fill(4000));
  assert.equal(trimSilence(tight).audio, tight);
  const junk = Buffer.from('not a wav at all, definitely longer than forty-four bytes of text');
  assert.equal(trimSilence(junk, 'x').audio, junk);
});

test('nextChunk/drain release a sentence only after its trailing whitespace, like the original chunker', () => {
  assert.equal(nextChunk('Hello there.').chunk, '');
  assert.deepEqual(nextChunk('Hello there. Next'), { chunk: 'Hello there. ', rest: 'Next' });
  assert.deepEqual(drain('One. Two! Three? Four'), { chunks: ['One. ', 'Two! ', 'Three? '], rest: 'Four' });
  assert.deepEqual(drain('Line one\nLine two'), { chunks: ['Line one\n'], rest: 'Line two' });
  assert.deepEqual(drain('Version 3.5 is out. ').chunks, ['Version 3.5 is out. ']);
});

test('the first chunk of a reply may end at a comma once it is long; later chunks never do', () => {
  const long = 'Right away sir, I am checking the status of every machine on the mesh and will report back, once the last one has answered the call. ';
  const first = drain(long, { first: true });
  assert.equal(first.chunks[0], 'Right away sir, I am checking the status of every machine on the mesh and will report back, ');
  assert.equal(first.chunks.join('') + first.rest, long);
  assert.deepEqual(drain(long, { first: false }).chunks, [long]);
  assert.deepEqual(drain('Yes, sir, right away, as you wish. ', { first: true }).chunks, ['Yes, sir, right away, as you wish. ']);
});
