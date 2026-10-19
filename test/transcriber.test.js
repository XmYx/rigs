// Transcriber applet: config, the page helpers (time/export formats, recorder format, status line), the HTTP API
// against a fake speech worker (upload → queue → segments → done, history, validation, size limit, cancel, a
// crashing worker that recovers on the next job), python discovery, and that every element app.js addresses
// exists in index.html. No model, no GPU, no microphone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const S = await import('../applets/transcriber/server.js');
const T = await import('../applets/transcriber/public/transcript.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'applets', 'transcriber');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-transcriber-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A worker that speaks the worker.py protocol. ".crash" files kill it, ".slow" files never finish.
const FAKE = path.join(tmp, 'fake-worker.cjs');
fs.writeFileSync(FAKE, `
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let loaded = false;
rl.on('line', (line) => {
  const r = JSON.parse(line);
  if (!loaded) { out({ type: 'loading', id: r.id }); out({ type: 'loaded', id: r.id, device: 'cpu', compute: 'int8' }); loaded = true; }
  if (r.path.endsWith('.crash')) process.exit(3);
  out({ type: 'info', id: r.id, duration: 10 });
  out({ type: 'segment', id: r.id, start: 0, end: 5, text: 'Szia világ.', progress: 0.5 });
  if (r.path.endsWith('.slow')) return;
  out({ type: 'segment', id: r.id, start: 5, end: 10, text: 'Ez egy teszt.', progress: 1 });
  out({ type: 'done', id: r.id, text: 'Szia világ. Ez egy teszt.', language: r.language, probability: 1, duration: 10, elapsed: 0.1 });
});
`);

let n = 0;
async function start(over = {}) {
  const dataDir = over.dataDir || path.join(tmp, `data-${++n}`);
  const { cfg } = S.loadConfig({ env: { RIGS_HOME: tmp, TRANSCRIBER_DATA_DIR: dataDir }, configFile: path.join(tmp, 'none.json') });
  Object.assign(cfg, { workerCommand: [process.execPath, FAKE], idleSec: 0 }, over);
  const t = S.createTranscriberServer({ cfg });
  await new Promise((r) => t.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${t.server.address().port}`;
  const j = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json().catch(() => null) }; };
  const upload = (q, body = Buffer.from('RIFFxxxx'), type = 'audio/wav') => j(`/api/jobs?${q}`, { method: 'POST', headers: { 'content-type': type }, body });
  const wait = async (id, until = (x) => x.status === 'done' || x.status === 'error') => {
    for (let i = 0; i < 200; i++) { const { body } = await j(`/api/jobs/${id}`); if (body && until(body)) return body; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`job ${id} did not finish`);
  };
  const stop = () => new Promise((r) => { t.server.close(r); t.server.closeAllConnections?.(); });
  return { ...t, base, j, upload, wait, stop, dataDir };
}

test('config: defaults, env, invalid values', () => {
  const { cfg, warnings } = S.loadConfig({ env: { RIGS_HOME: tmp }, configFile: path.join(tmp, 'none.json') });
  assert.equal(cfg.defaultLanguage, 'hu');
  assert.equal(cfg.model, 'large-v3-turbo');
  assert.equal(cfg.dataDir, path.join(tmp, 'transcriber'));
  assert.deepEqual(warnings, []);
  const e = S.loadConfig({ env: { RIGS_HOME: tmp, TRANSCRIBER_PORT: '9000', TRANSCRIBER_MODEL: 'large-v3', TRANSCRIBER_DEVICE: 'cpu', TRANSCRIBER_LANGUAGE: 'de' }, configFile: path.join(tmp, 'none.json') });
  assert.equal(e.cfg.port, 9000);
  assert.equal(e.cfg.model, 'large-v3');
  assert.equal(e.cfg.device, 'cpu');
  assert.equal(e.cfg.defaultLanguage, 'de');
  const bad = S.loadConfig({ env: { RIGS_HOME: tmp, TRANSCRIBER_PORT: 'x', TRANSCRIBER_DEVICE: 'tpu', TRANSCRIBER_LANGUAGE: '../x', TRANSCRIBER_MAX_MB: '-1' }, configFile: path.join(tmp, 'none.json') });
  assert.equal(bad.cfg.port, 8741);
  assert.equal(bad.cfg.device, 'auto');
  assert.equal(bad.cfg.defaultLanguage, 'hu');
  assert.equal(bad.cfg.maxMb, 500);
  assert.equal(bad.warnings.length, 4);
});

test('findPython: explicit setting, own venv, then the JARVIS Voice venv', () => {
  const cfg = { python: '/opt/py/bin/python', rigsHome: '/r' };
  const bin = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const own = path.join('/r', 'transcriber', 'venv', ...bin);
  assert.equal(S.findPython(cfg, () => true), '/opt/py/bin/python');
  assert.equal(S.findPython(cfg, (p) => p === own), own);
  assert.match(S.findPython({ rigsHome: '/r' }, (p) => p.includes('jarvis-voice')), /jarvis-voice/);
  assert.equal(S.findPython({ rigsHome: '/r' }, () => false), null);
});

test('page helpers: clock, subtitle stamps, exports, recorder format, status line', () => {
  assert.equal(T.clock(75), '1:15');
  assert.equal(T.clock(3725), '1:02:05');
  assert.equal(T.clock(-3), '0:00');
  assert.equal(T.stamp(3.5), '00:00:03,500');
  assert.equal(T.stamp(3725.04, '.'), '01:02:05.040');
  const job = { name: 'minta 1.wav', text: 'A. B.', segments: [{ start: 0, end: 1.2, text: ' A. ' }, { start: 1.2, end: 2, text: '   ' }, { start: 2, end: 3, text: 'B.' }] };
  assert.equal(T.toTxt(job), 'A.\nB.');
  assert.equal(T.toTxt({ text: 'csak szöveg', segments: [] }), 'csak szöveg');
  assert.equal(T.toSrt(job), '1\n00:00:00,000 --> 00:00:01,200\nA.\n\n2\n00:00:02,000 --> 00:00:03,000\nB.\n');
  assert.equal(T.toVtt(job), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nA.\n\n00:00:02.000 --> 00:00:03.000\nB.\n');
  assert.deepEqual(JSON.parse(T.EXPORTS.json.make(job)).segments.length, 3);
  assert.equal(T.exportName('minta.wav', 'srt'), 'minta.srt');
  assert.equal(T.exportName('előadás: 1/2.m4a', 'txt'), 'előadás_ 1_2.txt');
  assert.equal(T.exportName('', 'txt'), 'transcript.txt');
  assert.equal(T.pickMime((m) => m === 'audio/webm'), 'audio/webm');
  assert.equal(T.pickMime(() => { throw new Error('x'); }), '');
  assert.equal(T.pickMime((m) => m === 'audio/mp4'), 'audio/mp4');
  assert.equal(T.recordingName(new Date(2026, 9, 19, 18, 2, 3), 'audio/ogg;codecs=opus'), 'mikrofon-20261019-180203.ogg');
  assert.equal(T.engineLine(null).cls, 'warn');
  assert.equal(T.engineLine({ engine: { ok: false, error: 'no engine' } }).text, 'no engine');
  assert.match(T.engineLine({ engine: { ok: true }, state: 'ready', model: 'm', device: 'cuda', busy: false }).text, /m · GPU · ready/);
  assert.match(T.engineLine({ engine: { ok: true }, state: 'unloaded', model: 'm' }).text, /loads on first use/);
});

test('healthz, status, page files and path traversal', async () => {
  const t = await start();
  try {
    assert.deepEqual((await t.j('/healthz')).body, { ok: true });
    const st = (await t.j('/api/status')).body;
    assert.equal(st.ok, true);
    assert.equal(st.defaultLanguage, 'hu');
    assert.equal(st.languages.hu, 'Magyar (Hungarian)');
    assert.equal(st.state, 'unloaded');
    assert.equal(st.engine.ok, true);
    const page = await fetch(`${t.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<title>Transcriber<\/title>/);
    assert.equal((await fetch(`${t.base}/app.js`)).headers.get('content-type').startsWith('text/javascript'), true);
    assert.equal((await fetch(`${t.base}/nope.txt`)).status, 404);
    const get = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: t.server.address().port, path: p }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(await get('/%2e%2e/server.js'), 404); // the URL parser collapses it to /server.js, which is not in public/
    assert.equal(await get('/..%2fserver.js'), 403); // an encoded slash survives parsing and is stopped by the root check
    assert.equal((await t.j('/api/jobs', { method: 'PUT' })).status, 404);
  } finally { await t.stop(); }
});

test('upload → queued → segments → done, with the language passed to the worker, the upload removed and the history kept', async () => {
  const t = await start();
  try {
    const r = await t.upload('lang=hu&name=mikrofon-1.webm&source=mic', Buffer.from('webm-bytes'), 'audio/webm;codecs=opus');
    assert.equal(r.status, 202);
    const job = await t.wait(r.body.id);
    assert.equal(job.status, 'done');
    assert.equal(job.language, 'hu');
    assert.equal(job.source, 'mic');
    assert.equal(job.text, 'Szia világ. Ez egy teszt.');
    assert.equal(job.segments.length, 2);
    assert.equal(job.device, 'cpu');
    assert.equal(job.progress, 1);
    const files = fs.existsSync(path.join(t.dataDir, 'uploads')) ? fs.readdirSync(path.join(t.dataDir, 'uploads')) : [];
    assert.deepEqual(files, []);
    const list = (await t.j('/api/jobs')).body.jobs;
    assert.equal(list[0].id, r.body.id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dataDir, 'history.json'), 'utf8'))[0].text, 'Szia világ. Ez egy teszt.');
    assert.equal((await t.j('/api/status')).body.state, 'ready');
    // a file upload keeps the name's extension for ffmpeg and defaults the language to Hungarian
    const f = await t.upload('name=hang.m4a&source=file', Buffer.from('x'), 'audio/mp4');
    assert.equal((await t.wait(f.body.id)).language, 'hu');
    const auto = await t.upload('lang=auto&name=x.ogg');
    assert.equal((await t.wait(auto.body.id)).language, 'auto');
  } finally { await t.stop(); }
});

test('history survives a restart and entries can be removed', async () => {
  const a = await start();
  const dataDir = a.dataDir;
  let id;
  try { id = (await a.upload('lang=hu&name=egy.wav')).body.id; await a.wait(id); } finally { await a.stop(); }
  const b = await start({ dataDir });
  try {
    assert.equal((await b.j('/api/jobs')).body.jobs[0].id, id);
    assert.equal((await b.j(`/api/jobs/${id}`)).body.status, 'done');
    assert.equal((await b.j(`/api/jobs/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await b.j(`/api/jobs/${id}`)).status, 404);
    assert.equal((await b.j(`/api/jobs/${id}`, { method: 'DELETE' })).status, 404);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8')), []);
  } finally { await b.stop(); }
});

test('validation: language, empty body, size limit, unknown job', async () => {
  const t = await start({ maxMb: 0.0005 }); // ~524 bytes
  try {
    assert.equal((await t.upload('lang=../etc')).status, 400);
    assert.equal((await t.upload('lang=hu', Buffer.alloc(0))).status, 400);
    const big = await t.upload('lang=hu', Buffer.alloc(4096, 1));
    assert.equal(big.status, 413);
    assert.match(big.body.error, /larger than/);
    assert.equal((await t.j('/api/jobs/t-nope')).status, 404);
    assert.equal(fs.existsSync(path.join(t.dataDir, 'uploads')) ? fs.readdirSync(path.join(t.dataDir, 'uploads')).length : 0, 0);
  } finally { await t.stop(); }
});

test('jobs run one at a time, in order', async () => {
  const t = await start();
  try {
    const ids = [];
    for (const name of ['a.wav', 'b.wav', 'c.wav']) ids.push((await t.upload(`lang=hu&name=${name}`)).body.id);
    const done = [];
    for (const id of ids) done.push(await t.wait(id));
    assert.deepEqual(done.map((x) => x.status), ['done', 'done', 'done']);
    const list = (await t.j('/api/jobs')).body.jobs;
    assert.deepEqual(list.slice(0, 3).map((x) => x.name), ['c.wav', 'b.wav', 'a.wav']);
  } finally { await t.stop(); }
});

test('a crashing worker fails that job with a clear message and the next job starts a fresh worker', async () => {
  const t = await start();
  try {
    const bad = await t.upload('lang=hu&name=boom.crash');
    const failed = await t.wait(bad.body.id);
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /speech engine stopped/);
    const good = await t.upload('lang=hu&name=jo.wav');
    assert.equal((await t.wait(good.body.id)).status, 'done');
  } finally { await t.stop(); }
});

test('cancelling a running job stops the worker, and the queue carries on', async () => {
  const t = await start();
  try {
    const slow = (await t.upload('lang=hu&name=lassu.slow')).body.id;
    const next = (await t.upload('lang=hu&name=kovetkezo.wav')).body.id;
    const mid = await t.wait(slow, (x) => x.segments.length > 0);
    assert.equal(mid.status, 'running');
    assert.equal(mid.text, 'Szia világ.');
    assert.equal((await t.j(`/api/jobs/${slow}`, { method: 'DELETE' })).status, 200);
    assert.equal((await t.j(`/api/jobs/${slow}`)).status, 404);
    assert.equal((await t.wait(next)).status, 'done');
    const names = (await t.j('/api/jobs')).body.jobs.map((x) => x.name);
    assert.deepEqual(names, ['kovetkezo.wav']);
  } finally { await t.stop(); }
});

test('no speech engine installed: the job fails with the setup hint instead of hanging', async () => {
  const { cfg } = S.loadConfig({ env: { RIGS_HOME: tmp, TRANSCRIBER_DATA_DIR: path.join(tmp, 'data-noengine') }, configFile: path.join(tmp, 'none.json') });
  const engine = S.createEngine({ cfg: { ...cfg, workerCommand: null }, find: () => null });
  const seen = [];
  const ev = await engine.run({ id: 'x', path: '/nope.wav', language: 'hu' }, (e) => seen.push(e.type));
  assert.equal(ev.type, 'error');
  assert.match(ev.error, /setup\.sh/);
  assert.deepEqual(seen, ['error']);
  assert.equal(engine.state, 'unloaded');
  assert.equal(engine.busy, false);
});

test('every element app.js addresses exists in index.html', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const used = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size > 15);
  for (const id of used) assert.ok(html.includes(`id="${id}"`), `index.html has no #${id}`);
  assert.ok(html.includes('src="app.js"') && html.includes('href="style.css"'));
  assert.ok(!/(?:src|href)="\//.test(html), 'the page must use relative URLs only');
  assert.ok(!/fetch\(\s*['"`]\//.test(js), 'app.js must fetch relative URLs only');
});
