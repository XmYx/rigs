// JARVIS senses: emotion choice from LocalJev answers, the keyword fallback, and the WAV encoder used for hearing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-senses-'));
const S = await import('../src/senses.js');
const { encodeWav } = await import('../ui/src/hearing.js');

test('pickEmotion: most likely emotion above the threshold, else neutral', () => {
  assert.equal(S.pickEmotion({ happy: 0.9, amused: 0.6 }), 'happy');
  assert.equal(S.pickEmotion({ happy: 0.3, sad: 0.45 }), 'neutral');
  assert.equal(S.pickEmotion({ sad: 0.7, bogus: 0.99 }), 'sad');
  assert.equal(S.pickEmotion({}), 'neutral');
});

test('guessEmotion: keyword fallback when LocalJev is down', () => {
  assert.equal(S.guessEmotion('My apologies, sir, I lost the recording.'), 'sad');
  assert.equal(S.guessEmotion('The build failed on the MacBook.'), 'concerned');
  assert.equal(S.guessEmotion('Which machine should I use?'), 'curious');
  assert.equal(S.guessEmotion('Splendid, the render is done.'), 'happy');
  assert.equal(S.guessEmotion('Disk usage is 61 percent.'), 'neutral');
});

test('emotion: no LocalJev on the mesh → keyword guess, never throws', async () => {
  const r = await S.emotion('I am afraid the deploy failed.');
  assert.equal(r.emotion, 'concerned');
  assert.equal(r.source, 'guess');
  assert.deepEqual(await S.emotion(''), { emotion: 'neutral', confidence: 1, scores: {}, source: 'guess' });
});

test('encodeWav: 48 kHz float chunks → 16 kHz mono 16-bit WAV with a valid header', async () => {
  const a = new Float32Array(2400).fill(0.5);
  const b = new Float32Array(2400).fill(-0.5);
  const wav = Buffer.from(await encodeWav([a, b], 48000).arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  const samples = wav.readUInt32LE(40) / 2;
  assert.equal(samples, 1600); // 0.1 s
  assert.ok(wav.readInt16LE(44) > 16000 && wav.readInt16LE(44 + (samples - 1) * 2) < -16000);
});
