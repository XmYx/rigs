// One voice: JARVIS speaks with Kokoro (the jarvis-voice app) when it is up, and one call produces exactly one synthesis
// and at most one playback, whatever fails along the way. Resident piper and the machine's engine only stand in for a
// Kokoro that is down. The tests run in order: the failing-Kokoro cases come last because a failure parks Kokoro for 30 s.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-tts-'));
process.env.RIGS_HOME = home;
process.env.RIGS_NAME = 'mac';
// A stand-in WAV player on PATH: every playback appends a line to played.log.
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'paplay'), `#!/bin/sh\necho "$1" >> "${home}/played.log"\n`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const tts = await import('../src/tts.js');
const apps = await import('../src/apps.js');
const { saveConfig, loadConfig } = await import('../src/config.js');

const played = () => (fs.existsSync(`${home}/played.log`) ? fs.readFileSync(`${home}/played.log`, 'utf8').trim().split('\n').filter(Boolean).length : 0);

// A fake voice server: Kokoro (the jarvis-voice app, with a viseme header) or piper (/healthz too). Records every synth request.
function fakeVoice({ status = 200, visemes = '' } = {}) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.url === '/healthz') { res.writeHead(200); return res.end('{"ok":true}'); }
      if (req.method === 'POST') calls.push(JSON.parse(b));
      res.writeHead(status, { 'content-type': 'audio/wav', ...(visemes ? { 'x-visemes': visemes } : {}) });
      res.end(Buffer.from('RIFFfake'));
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, calls, port: srv.address().port })));
}
const close = (...v) => Promise.all(v.map((x) => new Promise((ok) => x.srv.close(ok))));
// kokoro: a fake's port, or null for "no jarvis-voice app on the mesh"
function wire({ kokoro, piper }) {
  const c = loadConfig();
  c.apps = kokoro ? [{ id: 'jarvis-voice', port: kokoro.port, healthPath: '/' }] : [];
  c.persona = { ...c.persona, neural: true, tts: { piperUrl: `http://127.0.0.1:${piper.port}`, trim: false } };
  saveConfig(c);
  apps.resetAppsState();
}

test('synthesize: Kokoro renders first, with its lipsync header, and piper is never asked; the neural voice ids pick a Kokoro voice', async () => {
  const cues = Buffer.from('{"cues":[[0,0.1,"aa"]]}').toString('base64');
  const kokoro = await fakeVoice({ visemes: cues });
  const piper = await fakeVoice();
  wire({ kokoro, piper });
  assert.equal(await tts.neuralBase(), `http://127.0.0.1:${kokoro.port}`);
  const r = await tts.synthesize('**Hello**, sir.');
  assert.equal(r.engine, 'neural');
  assert.equal(r.visemes, cues);
  const r2 = await tts.synthesize('Again.', 'neural:bm_lewis');
  assert.equal(r2.engine, 'neural');
  assert.deepEqual(kokoro.calls, [{ text: 'Hello, sir.' }, { text: 'Again.', voice: 'bm_lewis' }]);
  assert.equal(piper.calls.length, 0);
  assert.equal((await tts.info()).engine, 'neural');
  await close(kokoro, piper);
});

test('speakAloud: one reply = one Kokoro render and one playback', async () => {
  const kokoro = await fakeVoice();
  const piper = await fakeVoice();
  wire({ kokoro, piper });
  const before = played();
  const r = await tts.speakAloud('Good evening, sir.');
  assert.equal(r.engine, 'neural');
  assert.equal(kokoro.calls.length, 1);
  assert.equal(piper.calls.length, 0);
  assert.equal(played() - before, 1);
  await close(kokoro, piper);
});

test('persona.neural = false and a missing jarvis-voice app leave the resident piper voice speaking, once', async () => {
  const kokoro = await fakeVoice();
  const piper = await fakeVoice();
  wire({ kokoro: null, piper });
  assert.equal(await tts.neuralBase(), null);
  const before = played();
  const r = await tts.speakAloud('No Kokoro today, sir.');
  assert.equal(r.engine, 'piper');
  assert.equal(piper.calls.length, 1);
  assert.equal(played() - before, 1);
  const c = loadConfig();
  c.apps = [{ id: 'jarvis-voice', port: kokoro.port, healthPath: '/' }];
  c.persona = { ...c.persona, neural: false };
  saveConfig(c);
  apps.resetAppsState();
  assert.equal(await tts.neuralBase(), null);
  assert.equal((await tts.synthesize('Opted out.')).engine, 'piper');
  assert.equal(kokoro.calls.length, 0);
  await close(kokoro, piper);
});

test('speakAloud: a Kokoro that fails falls through to piper, and that one clip is played once; the next call does not wait on Kokoro again', async () => {
  const kokoro = await fakeVoice({ status: 500 });
  const piper = await fakeVoice();
  wire({ kokoro, piper });
  const before = played();
  const r = await tts.speakAloud('Kokoro is down, sir.');
  assert.equal(r.engine, 'piper');
  assert.equal(kokoro.calls.length, 1); // tried once, its render never played
  assert.equal(piper.calls.length, 1);
  assert.equal(played() - before, 1);
  await tts.speakAloud('And the next one.');
  assert.equal(kokoro.calls.length, 1); // parked for 30 s: no second timeout in front of the next sentence
  assert.equal(piper.calls.length, 2);
  assert.equal(played() - before, 2);
  assert.equal((await tts.synthesize('For the UI.')).engine, 'piper'); // /api/local/tts reports the engine that really spoke
  await close(kokoro, piper);
});

test('speakAloud: with every WAV engine failing nothing is played twice, and a failed render is never played', async () => {
  const kokoro = await fakeVoice({ status: 500 });
  const piper = await fakeVoice({ status: 500 });
  wire({ kokoro, piper });
  const before = played();
  await tts.speakAloud('Nobody home, sir.').catch(() => {}); // the machine may have no engine at all: a silent failure is fine, a second voice is not
  assert.ok(piper.calls.length <= 1);
  assert.equal(played() - before, 0);
  await close(kokoro, piper);
});
