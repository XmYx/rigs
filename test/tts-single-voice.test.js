// One voice: JARVIS speaks with Kokoro (the jarvis-voice app) when it is up, and one call produces exactly one synthesis
// and at most one playback, whatever fails along the way. The machine's own engine only stands in for a Kokoro that is
// down or starting (the resident piper voice is gone); the voice app itself is resident: the daemon revives it when its health says
// down (reviveVoice / startVoiceKeeper). The tests run in order: the failing-Kokoro cases come last because a failure parks Kokoro for 30 s.
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

// A fake voice server: Kokoro (the jarvis-voice app, with a viseme header) . Records every synth request.
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
function wire({ kokoro }) {
  const c = loadConfig();
  c.apps = kokoro ? [{ id: 'jarvis-voice', port: kokoro.port, healthPath: '/' }] : [];
  c.persona = { ...c.persona, neural: true, tts: { trim: false } };
  saveConfig(c);
  apps.resetAppsState();
}
// The machine's own engine may be missing on a test box: "none" then.
const engineOf = (p) => p.then((r) => r?.engine || 'none', () => 'none');

test('synthesize: Kokoro renders first, with its lipsync header; the neural voice ids pick a Kokoro voice', async () => {
  const cues = Buffer.from('{"cues":[[0,0.1,"aa"]]}').toString('base64');
  const kokoro = await fakeVoice({ visemes: cues });
  wire({ kokoro });
  assert.equal(await tts.neuralBase(), `http://127.0.0.1:${kokoro.port}`);
  const r = await tts.synthesize('**Hello**, sir.');
  assert.equal(r.engine, 'neural');
  assert.equal(r.visemes, cues);
  const r2 = await tts.synthesize('Again.', 'neural:bm_lewis');
  assert.equal(r2.engine, 'neural');
  assert.deepEqual(kokoro.calls, [{ text: 'Hello, sir.' }, { text: 'Again.', voice: 'bm_lewis' }]);
  assert.equal((await tts.info()).engine, 'neural');
  await close(kokoro);
});

test('speakAloud: one reply = one Kokoro render and one playback', async () => {
  const kokoro = await fakeVoice();
  wire({ kokoro });
  const before = played();
  const r = await tts.speakAloud('Good evening, sir.');
  assert.equal(r.engine, 'neural');
  assert.equal(kokoro.calls.length, 1);
  assert.equal(played() - before, 1);
  await close(kokoro);
});

test('persona.neural = false and a missing jarvis-voice app never ask Kokoro; the machine engine stands in', async () => {
  const kokoro = await fakeVoice();
  wire({ kokoro: null });
  assert.equal(await tts.neuralBase(), null);
  assert.notEqual(await engineOf(tts.synthesize('No Kokoro today, sir.')), 'neural');
  const c = loadConfig();
  c.apps = [{ id: 'jarvis-voice', port: kokoro.port, healthPath: '/' }];
  c.persona = { ...c.persona, neural: false };
  saveConfig(c);
  apps.resetAppsState();
  assert.equal(await tts.neuralBase(), null);
  assert.notEqual(await engineOf(tts.synthesize('Opted out.')), 'neural');
  assert.equal(kokoro.calls.length, 0);
  await close(kokoro);
});

test('synthesize: a Kokoro that fails is tried once, then parked so the next call does not wait on it again', async () => {
  const kokoro = await fakeVoice({ status: 500 });
  wire({ kokoro });
  assert.notEqual(await engineOf(tts.synthesize('Kokoro is down, sir.')), 'neural');
  assert.equal(kokoro.calls.length, 1);
  await engineOf(tts.synthesize('And the next one.'));
  assert.equal(kokoro.calls.length, 1); // parked for 30 s: no second timeout in front of the next sentence
  await close(kokoro);
});

test('wakeApp starts a down voice app on demand (once a minute), never an app that is up or unknown', async () => {
  const kokoro = await fakeVoice();
  const port = kokoro.port;
  await close(kokoro); // nothing listens there now: the app is down
  const c = loadConfig();
  c.apps = [{ id: 'jarvis-voice', port, healthPath: '/', launch: { command: 'true' } }];
  saveConfig(c);
  apps.resetAppsState();
  await apps.checkAll();
  const urls = [];
  const fetchImpl = async (u) => { urls.push(u); return { ok: true }; };
  assert.equal(tts.wakeApp('jarvis-voice', { fetchImpl, now: 1e12 }), true);
  assert.match(urls[0], /\/api\/nodes\/mac\/app-start\/jarvis-voice$/);
  assert.equal(tts.wakeApp('jarvis-voice', { fetchImpl, now: 1e12 + 1000 }), false); // not again within a minute
  assert.equal(tts.wakeApp('nope', { fetchImpl, now: 2e12 }), false);
  assert.equal(urls.length, 1);
});

// ---------------------------------------------------------------- resident voice: revived without a synthesize call
async function downVoice(persona = {}, app = {}) {
  const probe = await fakeVoice();
  const port = probe.port;
  await close(probe); // nothing listens there now: the app is down
  const c = loadConfig();
  c.apps = [{ id: 'jarvis-voice', port, healthPath: '/', keepAlive: true, launch: { command: 'true' }, ...app }];
  c.persona = { ...c.persona, neural: true, voiceApp: undefined, tts: { trim: false }, ...persona };
  saveConfig(c);
  apps.resetAppsState();
  await apps.checkAll();
}
const recorder = () => { const urls = []; return { urls, fetchImpl: async (u) => { urls.push(u); return { ok: true }; } }; };

test('reviveVoice: a down jarvis-voice app on this machine is started without any synthesize call, once a minute', async () => {
  await downVoice();
  assert.equal(apps.localApps().apps[0].health.status, 'down');
  const { urls, fetchImpl } = recorder();
  assert.equal(tts.reviveVoice({ fetchImpl, now: 1.1e12 }), true);
  assert.match(urls[0], /\/api\/nodes\/mac\/app-start\/jarvis-voice$/);
  assert.equal(tts.reviveVoice({ fetchImpl, now: 1.1e12 + 1000 }), false); // the wakeApp guard: not again within a minute
  assert.equal(tts.reviveVoice({ fetchImpl, now: 1.1e12 + 61000 }), true); // still down a minute later: tried again
  assert.equal(urls.length, 2);
});

test('reviveVoice: not when neural voice is off or the engine is "local", not for an app on another machine, not while it is up or unregistered', async () => {
  const { urls, fetchImpl } = recorder();
  await downVoice({ neural: false });
  assert.equal(tts.reviveVoice({ fetchImpl, now: 1.2e12 }), false);
  await downVoice({ tts: { engine: 'local' } });
  assert.equal(tts.reviveVoice({ fetchImpl, now: 1.2e12 }), false);
  await downVoice({ voiceApp: 'elsewhere/jarvis-voice' }); // that machine's own daemon revives it
  assert.equal(tts.reviveVoice({ fetchImpl, now: 1.2e12 }), false);
  await downVoice({ voiceApp: 'mac/jarvis-voice' }); // this machine, named explicitly
  assert.equal(tts.reviveVoice({ fetchImpl, now: 1.2e12 }), true);
  const kokoro = await fakeVoice();
  wire({ kokoro }); // up
  await apps.checkAll();
  assert.equal(tts.reviveVoice({ fetchImpl, now: 1.3e12 }), false);
  wire({ kokoro: null }); // no jarvis-voice app declared here at all
  assert.equal(tts.reviveVoice({ fetchImpl, now: 1.4e12 }), false);
  assert.equal(urls.length, 1);
  await close(kokoro);
});

test('startVoiceKeeper: the daemon starts a down voice app by itself (timer and apps health changes), and stopVoiceKeeper ends it', async () => {
  await downVoice();
  const { urls, fetchImpl } = recorder();
  tts.startVoiceKeeper({ intervalMs: 20, fetchImpl });
  await new Promise((ok) => setTimeout(ok, 150));
  assert.equal(urls.length, 1, 'started once; the minute guard holds back the later ticks');
  assert.match(urls[0], /app-start\/jarvis-voice$/);
  tts.stopVoiceKeeper();
});
