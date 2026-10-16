// Neural voice via the App Cloud: tts.synthesize prefers a "jarvis-voice" app and passes its lipsync
// timeline through; it falls back to the local engine when the app is missing or failing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-tts-'));
process.env.RIGS_NAME = 'mac';
const tts = await import('../src/tts.js');
const apps = await import('../src/apps.js');
const { saveConfig, loadConfig } = await import('../src/config.js');

function fakeVoice(handler) {
  const srv = http.createServer(handler);
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

test('synthesize uses the local jarvis-voice app and returns its viseme header', async () => {
  const seen = [];
  const srv = await fakeVoice((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      seen.push([req.url, JSON.parse(b)]);
      res.writeHead(200, { 'content-type': 'audio/wav', 'x-visemes': Buffer.from('{"cues":[[0,0.1,"aa"]]}').toString('base64') });
      res.end(Buffer.from('RIFFfake'));
    });
  });
  const cfg = loadConfig();
  cfg.apps = [{ id: 'jarvis-voice', port: srv.address().port, healthPath: '/' }];
  saveConfig(cfg);
  apps.resetAppsState();
  assert.equal(await tts.neuralBase(), `http://127.0.0.1:${srv.address().port}`);
  const r = await tts.synthesize('**Hello**, sir. `code`');
  assert.equal(r.engine, 'neural');
  assert.equal(r.audio.toString(), 'RIFFfake');
  assert.deepEqual(JSON.parse(Buffer.from(r.visemes, 'base64').toString()).cues, [[0, 0.1, 'aa']]);
  assert.equal(seen[0][0], '/tts');
  assert.equal(seen[0][1].text, 'Hello, sir. code');
  const r2 = await tts.synthesize('hi', 'neural:bm_lewis');
  assert.equal(r2.engine, 'neural');
  assert.equal(seen[1][1].voice, 'bm_lewis');
  await new Promise((ok) => srv.close(ok));
});

test('neural voice is skipped when opted out or when the app is down', async () => {
  const cfg = loadConfig();
  cfg.apps = [{ id: 'jarvis-voice', port: 9, healthPath: '/' }];
  cfg.persona = { ...cfg.persona, neural: false };
  saveConfig(cfg);
  apps.resetAppsState();
  assert.equal(await tts.neuralBase(), null);
  cfg.persona.neural = true;
  saveConfig(cfg);
  await apps.checkAll({ timeoutMs: 300 }); // port 9: down
  assert.equal(await tts.neuralBase(), null);
});
