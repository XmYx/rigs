// One voice: JARVIS speaks with the bundled engines only (resident piper, then the machine's own), and one call
// produces exactly one synthesis and at most one playback, whatever fails along the way.
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
const { saveConfig, loadConfig } = await import('../src/config.js');

const played = () => (fs.existsSync(`${home}/played.log`) ? fs.readFileSync(`${home}/played.log`, 'utf8').trim().split('\n').filter(Boolean).length : 0);

function fakePiper(status = 200) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.url === '/healthz') { res.writeHead(200); return res.end('{"ok":true}'); }
      calls.push(JSON.parse(b).text);
      res.writeHead(status, { 'content-type': 'audio/wav' });
      res.end(Buffer.from('RIFFfake'));
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, calls })));
}
const point = (port) => { const c = loadConfig(); c.persona = { ...c.persona, tts: { piperUrl: `http://127.0.0.1:${port}`, trim: false } }; saveConfig(c); };

test('synthesize renders with resident piper once, also for the retired neural voice ids', async () => {
  const { srv, calls } = await fakePiper();
  point(srv.address().port);
  const r = await tts.synthesize('**Hello**, sir.');
  assert.equal(r.engine, 'piper');
  const r2 = await tts.synthesize('Again.', 'neural:bm_lewis');
  assert.equal(r2.engine, 'piper');
  assert.deepEqual(calls, ['Hello, sir.', 'Again.']);
  await new Promise((ok) => srv.close(ok));
});

test('speakAloud: one reply = one synthesis and one playback', async () => {
  const { srv, calls } = await fakePiper();
  point(srv.address().port);
  const before = played();
  const r = await tts.speakAloud('Good evening, sir.');
  assert.equal(r.engine, 'piper');
  assert.equal(calls.length, 1);
  assert.equal(played() - before, 1);
  await new Promise((ok) => srv.close(ok));
});

test('speakAloud: a failing piper falls through to the machine engine, never to both, and never to a Kokoro app', async () => {
  const { srv, calls } = await fakePiper(500);
  point(srv.address().port);
  const before = played();
  await tts.speakAloud('Still here, sir.').catch(() => {}); // the machine may have no engine at all: silent failure is fine, a second voice is not
  assert.equal(calls.length, 1);
  assert.equal(played() - before, 0); // the failed render is never played
  await new Promise((ok) => srv.close(ok));
});

test('the neural voice is gone from the module', () => {
  assert.equal(tts.neuralBase, undefined);
});
