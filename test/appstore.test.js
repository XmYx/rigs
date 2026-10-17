// App Store tests: manifest validation, catalog loading, the resumable install job, uninstall to trash and status.
// Everything external is faked (git, uv/pip, hf, systemctl, health) — no network, venv or systemd is touched;
// URL downloads go to a local HTTP server.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-appstore-'));
process.env.RIGS_HOME = HOME;
process.env.RIGS_NAME = 'test-node';
process.env.RIGS_SYSTEMD_USER_DIR = path.join(HOME, 'systemd-user');
process.env.RIGS_GPU_OVERSEER_CLIENTS = path.join(HOME, 'gpu-overseer', 'clients.json');
process.env.HF_HOME = path.join(HOME, 'hf');
delete process.env.RIGS_APPS_DIR;
delete process.env.HF_TOKEN;
delete process.env.HUGGING_FACE_HUB_TOKEN;
const S = await import('../src/appstore.js');
const { config, saveConfig } = await import('../src/config.js');

const CATALOG = path.join(HOME, 'appstore', 'catalog');
const UNITS = process.env.RIGS_SYSTEMD_USER_DIR;
const OVERSEER = process.env.RIGS_GPU_OVERSEER_CLIENTS;
const REPO = 'https://example.invalid/acme/studio.git';
const VAE = crypto.randomBytes(200 * 1024);
const served = []; // { url, range } per request to the fake file server
let srv;
let PORT;

before(async () => {
  srv = http.createServer((req, res) => {
    served.push({ url: req.url, range: req.headers.range || '' });
    if (req.url !== '/vae.bin') { res.writeHead(404).end(); return; }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      if (start >= VAE.length) { res.writeHead(416).end(); return; }
      res.writeHead(206, { 'content-length': VAE.length - start, 'content-range': `bytes ${start}-${VAE.length - 1}/${VAE.length}` });
      res.end(VAE.subarray(start));
    } else {
      res.writeHead(200, { 'content-length': VAE.length });
      res.end(VAE);
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  PORT = srv.address().port;
  fs.mkdirSync(path.dirname(OVERSEER), { recursive: true });
  fs.writeFileSync(OVERSEER, JSON.stringify([{ id: 'comfyui', name: 'ComfyUI', match: 'ComfyUI/', unload: { url: 'http://127.0.0.1:8188/free', body: {} } }], null, 2));
});

after(() => { srv?.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

/** A Python GPU app with a git source, an HF and a URL model, a post-install step and a GPU Overseer entry. */
function studio(over = {}) {
  return {
    id: 'studio', name: 'Studio', icon: '🎛', description: 'test app', version: '1.0.0', platforms: ['linux'],
    needs: { gpu: 'nvidia', vramGB: 8, diskGB: 1, python: '3.11' },
    source: { type: 'git', url: REPO, ref: 'v1' },
    runtime: { type: 'python', requirements: ['requirements.txt'], torch: { index: 'https://download.pytorch.org/whl/cu128', packages: ['torch'] } },
    models: [
      { name: 'weights', kind: 'hf', repo: 'acme/weights', files: ['model.safetensors'], dest: 'models/weights', sizeGB: 0.001 },
      { name: 'vae', kind: 'url', url: `http://127.0.0.1:${PORT}/vae.bin`, dest: 'models/vae.bin', sizeGB: 0.0002 },
    ],
    port: 18211, healthPath: '/healthz',
    env: { STUDIO_PORT: '{port}', STUDIO_MODELS: '{appDir}/models' },
    launch: { command: ['{python}', '{appDir}/server.py', '--port', '{port}'], systemd: { after: ['gpu-overseer.service'], service: { KillMode: 'mixed' } } },
    gpuOverseer: { unload: { url: 'http://127.0.0.1:{port}/api/unload' }, busy: { url: 'http://127.0.0.1:{port}/api/busy' } },
    postInstall: [{ name: 'warm up', run: ['{python}', '-c', 'print("warm")'] }],
    ...over,
  };
}

function putManifest(m) {
  fs.mkdirSync(CATALOG, { recursive: true });
  fs.writeFileSync(path.join(CATALOG, `${m.id}.json`), JSON.stringify(m, null, 2));
}

/** A fake machine: records every command and fakes its effect on disk. */
function world({ uv = true, systemd = true, platform = 'linux', gpus = [{ name: 'RTX 4090', vramGB: 24, nvidia: true }], pipFailures = 0, hangPip = false } = {}) {
  const calls = [];
  const started = [];
  let failures = pipFailures;
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const exec = async (cmd, args, opts = {}) => {
    const name = path.basename(cmd).replace(/\.exe$/, '');
    calls.push({ name, args: [...args] });
    if (name === 'git') {
      if (args[0] === 'init') { fs.mkdirSync(path.join(args[2], '.git'), { recursive: true }); return ok(); }
      const [, dir, sub] = args;
      if (sub === 'checkout') { fs.writeFileSync(path.join(dir, 'requirements.txt'), 'fastapi==0.115\n'); fs.writeFileSync(path.join(dir, 'server.py'), '# app\n'); }
      if (sub === 'rev-parse') return ok('abc123def4567890abc\n');
      if (sub === 'remote' && args[3] === 'get-url') return ok(`${REPO}\n`);
      return ok();
    }
    if (name === 'uv' && args[0] === 'venv') {
      const py = S.venvPython(args[args.length - 1]);
      fs.mkdirSync(path.dirname(py), { recursive: true });
      fs.writeFileSync(py, '');
      return ok();
    }
    if (name === 'uv' && args[0] === 'pip') {
      if (hangPip) return new Promise((r) => opts.signal?.addEventListener('abort', () => r({ code: -3, stdout: '', stderr: '[cancelled]' })));
      if (failures-- > 0) return { code: 1, stdout: '', stderr: 'error: No matching distribution found for fastapi==0.115' };
      opts.onLine?.('Installed 3 packages in 12ms');
      return ok('Installed 3 packages');
    }
    if (/^python/.test(name)) {
      if (args[0] === '-m' && args[1] === 'venv') { const py = S.venvPython(args[2]); fs.mkdirSync(path.dirname(py), { recursive: true }); fs.writeFileSync(py, ''); return ok(); }
      const code = args[1] || '';
      if (code.includes('[:2]')) return ok('3.11\n');
      if (code.includes('[:3]')) return ok('3.11.9\n');
      return ok('warm\n');
    }
    if (name === 'hf') {
      const i = args.indexOf('--local-dir');
      const files = args.slice(2, i >= 0 ? i : undefined).filter((a) => !a.startsWith('--'));
      for (const f of files) { fs.mkdirSync(args[i + 1], { recursive: true }); fs.writeFileSync(path.join(args[i + 1], f), 'weights'); }
      return ok();
    }
    return ok(); // systemctl, journalctl, …
  };
  const tools = { git: '/usr/bin/git', uv: uv ? '/usr/bin/uv' : null, hf: '/usr/bin/hf', python3: '/usr/bin/python3', tar: '/usr/bin/tar', npm: '/usr/bin/npm' };
  return {
    calls, started,
    names: () => calls.map((c) => `${c.name} ${c.args.filter((a) => !a.includes(path.sep)).slice(0, 3).join(' ')}`.trim()),
    deps: {
      exec, which: (n) => tools[n] ?? null, platform: () => platform, systemd: async () => systemd, gpus: async () => gpus,
      freeGB: () => 500, unitDir: () => UNITS, fetch: (...a) => fetch(...a),
      startApp: async (id) => { started.push(id); return { started: true, health: { status: 'up' } }; },
    },
  };
}

async function installAndWait(id, opts, w) {
  S.install(id, opts, w.deps);
  await S.whenDone(id);
  return S.jobFor(id);
}

const appsInConfig = () => (config().apps || []).map((a) => a.id);
const root = (id) => path.join(HOME, 'apps', id);

// ---------------------------------------------------------------- validation

test('validateManifest: a full manifest normalizes, with defaults filled in', () => {
  const { manifest, errors } = S.validateManifest(studio());
  assert.deepEqual(errors, []);
  assert.equal(manifest.id, 'studio');
  assert.equal(manifest.healthTimeoutSec, 180);
  assert.equal(manifest.models[0].repoType, 'model');
  assert.deepEqual(manifest.runtime.torch, { index: 'https://download.pytorch.org/whl/cu128', packages: ['torch'] });
  assert.equal(manifest.launch.systemd.unit, '');
  const min = S.validateManifest({ id: 'Mini', name: 'Mini', source: { type: 'rigs', path: 'applets/navigation' }, port: 9000, launch: { command: ['{node}', 'x.js'] } });
  assert.deepEqual(min.errors, []);
  assert.equal(min.manifest.id, 'mini');
  assert.deepEqual(min.manifest.platforms, ['linux', 'mac', 'windows']);
  assert.deepEqual(min.manifest.runtime, { type: 'none' });
});

test('validateManifest: rejects invalid manifests with clear, field-level errors', () => {
  const cases = [
    [{ id: 'Bad Id!' }, /id must be 1-40 chars/],
    [{ name: '' }, /studio: name is required/],
    [{ platforms: ['linux', 'beos'] }, /platforms has unknown platform\(s\) beos/],
    [{ needs: { python: '3' } }, /needs.python must be a Python minor version like "3.11"/],
    [{ needs: { vram: 8 } }, /needs.vram is not a known field/],
    [{ source: { type: 'svn', url: 'x' } }, /source.type must be git, rigs or tarball/],
    [{ source: { type: 'git', url: 'ftp://x/y' } }, /source.url must be a git URL/],
    [{ source: { type: 'rigs', path: '../etc' } }, /source.path must be a relative path inside the RIGS repo/],
    [{ runtime: { type: 'python', requirements: ['/etc/passwd'] } }, /runtime.requirements must be requirement file path\(s\) relative/],
    [{ runtime: { type: 'conda' } }, /runtime.type must be python, node or none/],
    [{ models: [{ name: 'm', kind: 'torrent', sizeGB: 1 }] }, /models\[0\].kind must be "hf" or "url"/],
    [{ models: [{ name: 'm', kind: 'hf', repo: 'nope', sizeGB: 1 }] }, /models\[0\].repo must be a Hugging Face repo id/],
    [{ models: [{ name: 'm', kind: 'hf', repo: 'a/b' }] }, /models\[0\].sizeGB must be the download size in GB/],
    [{ models: [{ name: 'm', kind: 'url', url: 'http://x/y', sizeGB: 1 }] }, /models\[0\].dest is required/],
    [{ models: [{ name: 'm', kind: 'hf', repo: 'a/b', sizeGB: 1, dest: '../../x' }] }, /models\[0\].dest must be a path without ".."/],
    [{ port: 70000 }, /port must be an integer 1-65535/],
    [{ healthPath: 'healthz' }, /healthPath must start with \//],
    [{ launch: { command: 'python server.py' } }, /launch.command must be the argv list/],
    [{ launch: { command: ['{pyhton}', 'server.py'] } }, /launch.command\[0\] uses unknown placeholder \{pyhton\}/],
    [{ launch: { command: ['x'], systemd: { service: { ExecStart: '/bin/sh' } } } }, /launch.systemd.service.ExecStart comes from launch.command/],
    [{ env: { 'BAD-NAME': 'x' } }, /env.BAD-NAME is not a valid variable name/],
    [{ gpuOverseer: { unload: { url: 'nope' } } }, /gpuOverseer.unload must be/],
    [{ postInstall: [{ run: 'make' }] }, /postInstall\[0\].run must be the argv list/],
    [{ rewrite: { nonsense: true } }, /rewrite.nonsense is not a known hint/],
    [{ colour: 'red' }, /colour is not a known field/],
  ];
  for (const [patch, re] of cases) {
    const { manifest, errors } = S.validateManifest(studio(patch));
    assert.equal(manifest, null, `accepted ${JSON.stringify(patch)}`);
    assert.ok(errors.some((e) => re.test(e)), `${JSON.stringify(patch)} → ${errors.join(' | ')}`);
  }
  assert.match(S.validateManifest(42).errors[0], /must be a JSON object/);
  const inPlace = S.validateManifest(studio({ source: { type: 'rigs', path: 'applets/x' }, models: [{ name: 'w', kind: 'hf', repo: 'a/b', sizeGB: 1, dest: 'models' }] }));
  assert.ok(inPlace.errors.some((e) => /must not be inside the RIGS checkout/.test(e)), inPlace.errors.join(' | '));
  assert.deepEqual(S.validateManifest(studio({ source: { type: 'rigs', path: 'applets/x' }, models: [{ name: 'w', kind: 'hf', repo: 'a/b', sizeGB: 1, dest: '{root}/models' }] })).errors, []);
});

test('loadCatalog: the built-in catalog is valid; broken files are reported; a later dir overrides an id', () => {
  const builtIn = S.loadCatalog([S.CATALOG_DIR]);
  assert.deepEqual(builtIn.errors, []);
  assert.ok(builtIn.apps.some((a) => a.id === 'navigation'));
  const a = fs.mkdtempSync(path.join(HOME, 'cat-a-'));
  const b = fs.mkdtempSync(path.join(HOME, 'cat-b-'));
  fs.writeFileSync(path.join(a, 'studio.json'), JSON.stringify(studio()));
  fs.writeFileSync(path.join(a, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(a, 'invalid.json'), JSON.stringify(studio({ id: 'other', port: 0 })));
  fs.writeFileSync(path.join(b, 'studio.json'), JSON.stringify(studio({ name: 'Studio (local)' })));
  const { apps, errors } = S.loadCatalog([a, b]);
  assert.deepEqual(apps.map((x) => `${x.id}:${x.name}`), ['studio:Studio (local)']);
  assert.ok(errors.some((e) => /^broken.json: not valid JSON/.test(e)), errors.join(' | '));
  assert.ok(errors.some((e) => /^invalid.json: other: port must be/.test(e)), errors.join(' | '));
});

test('fitFor: platform, GPU, VRAM and disk', () => {
  const m = S.validateManifest(studio()).manifest;
  const facts = { platform: 'linux', gpus: [{ name: 'RTX', vramGB: 24, nvidia: true }], freeGB: 100, memGB: 64 };
  assert.deepEqual(S.fitFor(m, facts), { ok: true, reasons: [], warnings: [] });
  assert.match(S.fitFor(m, { ...facts, platform: 'mac' }).reasons[0], /runs on linux only \(this machine is mac\)/);
  assert.match(S.fitFor(m, { ...facts, gpus: [{ name: 'Intel UHD', vramGB: null, nvidia: false }] }).reasons[0], /needs an NVIDIA GPU/);
  assert.match(S.fitFor(m, { ...facts, gpus: [{ name: 'RTX 3050', vramGB: 4, nvidia: true }] }).reasons[0], /needs 8 GB VRAM \(the largest GPU here has 4 GB\)/);
  assert.match(S.fitFor(m, { ...facts, freeGB: 0.5 }).reasons[0], /needs 1 GB of disk \(0.5 GB free\)/);
  const unknownVram = S.fitFor(m, { ...facts, gpus: [{ name: 'NVIDIA ?', vramGB: null, nvidia: true }] });
  assert.equal(unknownVram.ok, true);
  assert.match(unknownVram.warnings[0], /could not read this machine's VRAM/);
});

test('installOptions and redact', () => {
  assert.deepEqual(S.installOptions({ port: '9001', suffix: '-test', dryRun: 1, until: 'venv', gpuOverseer: false }), { port: 9001, suffix: '-test', dryRun: true, until: 'venv', gpuOverseer: false });
  assert.throws(() => S.installOptions({ port: 0 }), /port must be/);
  assert.throws(() => S.installOptions({ suffix: 'Bad Suffix' }), /suffix must be/);
  assert.throws(() => S.installOptions({ until: 'everything' }), /until must be one of check, fetch/);
  assert.equal(S.redact('hf download --token hf_abcdefghijklmnopqrstuvwxyz x'), 'hf download --token *** x');
  assert.equal(S.redact('Authorization: Bearer hf_abcdefghijk'), 'Authorization: Bearer ***');
  assert.equal(S.redact('git fetch https://bob:s3cret@github.com/a/b'), 'git fetch https://bob:***@github.com/a/b');
});

// ---------------------------------------------------------------- downloads

test('downloadFile: resumes a partial download with a Range request, then skips the finished file', async () => {
  const dest = path.join(HOME, 'dl', 'vae.bin');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.part`, VAE.subarray(0, 50000));
  served.length = 0;
  const seen = [];
  const r = await S.downloadFile(`http://127.0.0.1:${PORT}/vae.bin`, dest, { onBytes: (b) => seen.push(b) });
  assert.equal(r.resumed, true);
  assert.deepEqual(served.map((s) => s.range), ['bytes=50000-']);
  assert.ok(fs.readFileSync(dest).equals(VAE));
  assert.ok(!fs.existsSync(`${dest}.part`));
  assert.equal(seen[0], 50000);
  assert.equal(seen[seen.length - 1], VAE.length);
  const again = await S.downloadFile(`http://127.0.0.1:${PORT}/vae.bin`, dest);
  assert.equal(again.skipped, true);
  assert.equal(served.length, 1, 'no second request for a file already on disk');
});

test('downloadFile: a sha256 mismatch fails and keeps the bad file aside (nothing deleted)', async () => {
  const dest = path.join(HOME, 'dl', 'bad.bin');
  await assert.rejects(S.downloadFile(`http://127.0.0.1:${PORT}/vae.bin`, dest, { sha256: '0'.repeat(64) }), /sha256 mismatch for bad.bin/);
  assert.ok(!fs.existsSync(dest));
  assert.ok(fs.readdirSync(path.dirname(dest)).some((n) => n.startsWith('bad.bin.part.bad-')));
  await assert.rejects(S.downloadFile(`http://127.0.0.1:${PORT}/missing.bin`, path.join(HOME, 'dl', 'm.bin')), /HTTP 404/);
});

// ---------------------------------------------------------------- install

test('install: fetch → venv → deps → models → post → launch → register → health, with progress', async () => {
  putManifest(studio());
  served.length = 0;
  const w = world();
  const events = [];
  const off = S.onJobEvent((j) => { if (j.id === 'studio') events.push(j); });
  const first = S.install('studio', {}, w.deps);
  assert.equal(first.state, 'running');
  assert.equal(S.install('studio', {}, w.deps).already, true, 'a second call returns the running job');
  await S.whenDone('studio');
  off();
  const job = S.jobFor('studio');
  assert.equal(job.state, 'done', job.error + '\n' + job.log.join('\n'));
  assert.equal(job.percent, 100);
  assert.deepEqual(job.steps.map((s) => `${s.id}:${s.status}`), ['check:done', 'fetch:done', 'venv:done', 'deps:done', 'models:done', 'post:done', 'launch:done', 'register:done', 'health:done']);

  // the commands, in order
  const order = ['git init', 'git -C', 'uv venv', 'uv pip', 'hf download', 'python -c', 'systemctl --user daemon-reload', 'systemctl --user enable'];
  const names = w.names();
  let at = -1;
  for (const o of order) { const i = names.findIndex((nm, k) => k > at && nm.startsWith(o)); assert.ok(i > at, `${o} after #${at} in\n${names.join('\n')}`); at = i; }
  assert.deepEqual(w.started, ['studio']);
  const fetchCall = w.calls.find((c) => c.name === 'git' && c.args.includes('fetch'));
  assert.deepEqual(fetchCall.args.slice(-2), ['origin', 'v1']);
  const pip = w.calls.find((c) => c.name === 'uv' && c.args[0] === 'pip').args;
  assert.ok(pip.includes('torch') && pip.includes('-r') && pip.includes('--extra-index-url') && pip.includes('https://download.pytorch.org/whl/cu128'), pip.join(' '));
  assert.equal(pip[pip.indexOf('--python') + 1], S.venvPython(path.join(root('studio'), 'venv')));
  assert.deepEqual(w.calls.find((c) => c.name === 'uv' && c.args[0] === 'venv').args.slice(0, 4), ['venv', '--seed', '--python', '3.11']);

  // files on disk
  const appDir = path.join(root('studio'), 'app');
  assert.equal(fs.readFileSync(path.join(appDir, 'models', 'weights', 'model.safetensors'), 'utf8'), 'weights');
  assert.ok(fs.readFileSync(path.join(appDir, 'models', 'vae.bin')).equals(VAE));
  const unit = fs.readFileSync(path.join(UNITS, 'rigs-app-studio.service'), 'utf8');
  assert.ok(unit.includes(S.MARKER));
  assert.match(unit, /After=network-online.target gpu-overseer.service/);
  assert.ok(unit.includes(`ExecStart="${S.venvPython(path.join(root('studio'), 'venv')).replace(/\\/g, '\\\\')}"`), unit);
  assert.match(unit, /Environment="STUDIO_PORT=18211"/);
  assert.match(unit, /Environment="PYTHONUNBUFFERED=1"/);
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /WantedBy=default.target/);

  // registry, overseer, state, log
  const entry = config().apps.find((a) => a.id === 'studio');
  assert.deepEqual(entry, { id: 'studio', name: 'Studio', icon: '🎛', port: 18211, healthPath: '/healthz', launch: { systemd: 'rigs-app-studio.service' }, installedBy: 'appstore' });
  const clients = JSON.parse(fs.readFileSync(OVERSEER, 'utf8'));
  assert.deepEqual(clients.map((c) => c.id), ['comfyui', 'studio']);
  assert.equal(clients[1].managedBy, 'rigs-appstore');
  assert.equal(clients[1].unload.url, 'http://127.0.0.1:18211/api/unload');
  assert.equal(clients[1].match, path.join(root('studio'), 'venv') + path.sep);
  const st = S.readState('studio');
  assert.equal(st.state, 'installed');
  assert.equal(st.version, '1.0.0');
  assert.equal(st.sourceRev, 'abc123def4567890abc');
  assert.equal(st.python, 'Python 3.11.9');
  assert.match(fs.readFileSync(path.join(root('studio'), 'install.log'), 'utf8'), /Studio is installed\./);
  const status = S.statusFor('studio', S.validateManifest(studio()).manifest);
  assert.equal(status.state, 'installed');
  assert.equal(status.updateAvailable, false);

  // progress events: every step reported, overall percent never goes back
  assert.ok(events.some((e) => e.step === 'models'));
  assert.ok(events.some((e) => e.step === 'deps' && e.state === 'running'));
  const pct = events.map((e) => e.percent);
  assert.deepEqual(pct, [...pct].sort((x, y) => x - y), `percent went back: ${pct.join(',')}`);
  assert.equal(events[events.length - 1].state, 'done');
});

test('install again: every finished step is skipped; only the check and the health check run', async () => {
  const w = world();
  const job = await installAndWait('studio', {}, w);
  assert.equal(job.state, 'done', job.error);
  assert.deepEqual(job.steps.map((s) => `${s.id}:${s.status}`), ['check:done', 'fetch:skipped', 'venv:skipped', 'deps:skipped', 'models:skipped', 'post:skipped', 'launch:skipped', 'register:skipped', 'health:done']);
  assert.deepEqual(w.names(), [], 'no git, venv, pip, hf or systemctl on a re-run');
  assert.deepEqual(w.started, ['studio']);
  assert.equal(served.filter((s) => s.url === '/vae.bin').length, 1, 'the URL model was downloaded once');
});

test('a changed manifest redoes only what it affects (a new port rewrites the unit and the registration)', async () => {
  putManifest(studio({ version: '1.1.0', port: 18212 }));
  const m = S.validateManifest(studio({ version: '1.1.0' })).manifest;
  assert.equal(S.statusFor('studio', m).updateAvailable, true);
  const w = world();
  const job = await installAndWait('studio', {}, w);
  assert.equal(job.state, 'done', job.error);
  const status = Object.fromEntries(job.steps.map((s) => [s.id, s.status]));
  assert.deepEqual([status.fetch, status.venv, status.deps, status.models], ['skipped', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual([status.post, status.launch, status.register], ['done', 'done', 'done']);
  assert.match(fs.readFileSync(path.join(UNITS, 'rigs-app-studio.service'), 'utf8'), /STUDIO_PORT=18212/);
  assert.ok(w.names().some((nm) => nm.startsWith('systemctl --user try-restart')), 'a running unit is restarted with its new settings');
  assert.equal(config().apps.find((a) => a.id === 'studio').port, 18212);
  assert.equal(JSON.parse(fs.readFileSync(OVERSEER, 'utf8')).find((c) => c.id === 'studio').unload.url, 'http://127.0.0.1:18212/api/unload');
  assert.equal(S.readState('studio').version, '1.1.0');
});

test('a failed install keeps its error and log, then resumes from the failed step', async () => {
  putManifest(studio({ id: 'studio2', port: 18213, gpuOverseer: undefined }));
  const w1 = world({ pipFailures: 1 });
  const failed = await installAndWait('studio2', {}, w1);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.step, 'deps');
  assert.match(failed.error, /uv pip failed \(exit 1\): error: No matching distribution found for fastapi==0.115/);
  assert.equal(failed.steps.find((s) => s.id === 'deps').status, 'failed');
  const st = S.statusFor('studio2');
  assert.equal(st.state, 'failed');
  assert.equal(st.failedStep, 'deps');
  assert.ok(st.logTail.some((l) => /No matching distribution/.test(l)), st.logTail.join('\n'));
  assert.ok(!appsInConfig().includes('studio2'));

  const w2 = world();
  const job = await installAndWait('studio2', {}, w2);
  assert.equal(job.state, 'done', job.error);
  assert.deepEqual(job.steps.slice(1, 4).map((s) => `${s.id}:${s.status}`), ['fetch:skipped', 'venv:skipped', 'deps:done']);
  assert.ok(!w2.names().some((nm) => nm.startsWith('git') || nm.startsWith('uv venv')), w2.names().join('\n'));
  assert.ok(appsInConfig().includes('studio2'));
});

test('cancel stops the running step; installing again resumes there', async () => {
  putManifest(studio({ id: 'studio3', port: 18214, gpuOverseer: undefined }));
  const w = world({ hangPip: true });
  S.install('studio3', {}, w.deps);
  for (let i = 0; i < 200 && !w.calls.some((c) => c.name === 'uv' && c.args[0] === 'pip'); i++) await new Promise((r) => setTimeout(r, 5));
  S.cancel('studio3');
  await S.whenDone('studio3');
  const job = S.jobFor('studio3');
  assert.equal(job.state, 'cancelled');
  assert.equal(S.readState('studio3').failedStep, 'deps');
  assert.throws(() => S.cancel('studio3'), /no install of "studio3" is running/);
  const again = await installAndWait('studio3', {}, world());
  assert.equal(again.state, 'done', again.error);
  assert.equal(again.steps.find((s) => s.id === 'venv').status, 'skipped');
});

test('dry run: checks and plans every step without changing anything', async () => {
  putManifest(studio({ id: 'planned', port: 18215 }));
  const before = JSON.stringify(config().apps);
  const w = world();
  const job = await installAndWait('planned', { dryRun: true }, w);
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.steps[0].status, 'done');
  for (const s of job.steps.slice(1)) {
    assert.equal(s.status, 'skipped');
    assert.match(s.detail, /^dry run: would /, `${s.id}: ${s.detail}`);
  }
  assert.match(job.steps.find((s) => s.id === 'models').detail, /would download 2 model\(s\)/);
  assert.deepEqual(w.calls, []);
  assert.ok(!fs.existsSync(root('planned')));
  assert.equal(JSON.stringify(config().apps), before);
  assert.equal(S.statusFor('planned').state, 'not-installed');
});

test('until: stops after the named step and reports a partial install', async () => {
  const job = await installAndWait('planned', { until: 'venv' }, world());
  assert.equal(job.state, 'done', job.error);
  assert.deepEqual(job.steps.map((s) => s.status), ['done', 'done', 'done', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(S.statusFor('planned').state, 'partial');
});

test('check: refuses misfits and conflicts before touching anything', async () => {
  putManifest(studio({ id: 'clash', port: 18216 }));
  const cfg = config();
  cfg.apps = [...cfg.apps, { id: 'clash', name: 'Clash', port: 18216, launch: { systemd: 'clash.service' } }];
  saveConfig(cfg);
  assert.equal(S.statusFor('clash').state, 'external');
  const j1 = await installAndWait('clash', {}, world());
  assert.equal(j1.state, 'failed');
  assert.equal(j1.step, 'check');
  assert.match(j1.error, /"clash" is already in the App Cloud, registered by hand/);
  assert.ok(!fs.existsSync(root('clash')), 'a failed check leaves nothing behind');
  await assert.rejects(S.uninstall('clash', world().deps), /registered by hand, not installed by the App Store/);

  putManifest(studio({ id: 'portclash', port: 18216 }));
  const jp = await installAndWait('portclash', {}, world());
  assert.match(jp.error, /port 18216 is already used by app "clash" — install with another port/);
  const jp2 = await installAndWait('portclash', { port: 18299, dryRun: true }, world());
  assert.equal(jp2.state, 'done', jp2.error);

  putManifest(studio({ id: 'wrongos', port: 18217 }));
  const j2 = await installAndWait('wrongos', {}, world({ platform: 'windows' }));
  assert.match(j2.error, /runs on linux only \(this machine is windows\)/);
  assert.equal(S.statusFor('wrongos').state, 'failed');

  putManifest(studio({ id: 'foreign', port: 18218 }));
  fs.mkdirSync(UNITS, { recursive: true });
  fs.writeFileSync(path.join(UNITS, 'rigs-app-foreign.service'), '[Service]\nExecStart=/bin/true\n');
  const j3 = await installAndWait('foreign', {}, world());
  assert.match(j3.error, /rigs-app-foreign.service already exists .* not written by the App Store/);
  assert.equal(fs.readFileSync(path.join(UNITS, 'rigs-app-foreign.service'), 'utf8'), '[Service]\nExecStart=/bin/true\n', 'never overwritten');

  putManifest(studio({ id: 'nopython', port: 18219 }));
  const w = world({ uv: false });
  w.deps.which = (n) => ({ git: '/usr/bin/git', python3: '/usr/bin/python3' }[n] ?? null);
  w.deps.exec = async () => ({ code: 0, stdout: '3.14\n', stderr: '' });
  const j4 = await installAndWait('nopython', {}, w);
  assert.match(j4.error, /needs Python 3.11: install uv/);

  putManifest(studio({ id: 'gated', port: 18220, models: [{ name: 'Flux', kind: 'hf', repo: 'acme/flux', files: ['f.safetensors'], sizeGB: 1, gated: true }] }));
  const j5 = await installAndWait('gated', {}, world());
  assert.match(j5.error, /Flux is gated on Hugging Face: accept its license at https:\/\/huggingface.co\/acme\/flux and run "hf auth login"/);
});

test('without uv: python -m venv and the venv pip', async () => {
  putManifest(studio({ id: 'plainpy', port: 18221, gpuOverseer: undefined, models: [] }));
  const w = world({ uv: false });
  const job = await installAndWait('plainpy', {}, w);
  assert.equal(job.state, 'done', job.error);
  const venvCall = w.calls.find((c) => c.args[0] === '-m' && c.args[1] === 'venv');
  assert.equal(venvCall.name, 'python3');
  const pip = w.calls.find((c) => c.name === 'python' && c.args.includes('install') && c.args.includes('-r'));
  assert.ok(pip, w.names().join('\n'));
  assert.deepEqual(pip.args.slice(0, 3), ['-m', 'pip', 'install']);
});

// ---------------------------------------------------------------- launcher without systemd, built-in applets

test('no user systemd: a launcher script is the launch recipe; uninstall unregisters and trashes the copy', async () => {
  putManifest({ id: 'hello', name: 'Hello', icon: '👋', version: '1', source: { type: 'rigs', path: 'test/fixtures/appstore-hello', copy: true }, runtime: { type: 'node' }, port: 18222, healthPath: '/healthz', env: { HELLO_PORT: '{port}' }, launch: { command: ['{node}', '{appDir}/server.mjs'] } });
  const w = world({ systemd: false });
  const job = await installAndWait('hello', {}, w);
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.steps.find((s) => s.id === 'venv').status, 'skipped');
  assert.equal(job.steps.find((s) => s.id === 'deps').detail, 'no package.json — nothing to install');
  const launcher = fs.readFileSync(path.join(root('hello'), 'launch.mjs'), 'utf8');
  assert.ok(launcher.includes(S.MARKER));
  assert.ok(launcher.includes(JSON.stringify(path.join(root('hello'), 'app', 'server.mjs'))), launcher);
  assert.ok(launcher.includes('"HELLO_PORT": "18222"'));
  const entry = config().apps.find((a) => a.id === 'hello');
  assert.match(entry.launch.command, /launch\.mjs/);
  assert.ok(fs.existsSync(path.join(root('hello'), 'app', 'server.mjs')), 'copy: true copies the source out of the RIGS repo');
  assert.ok(!w.calls.some((c) => c.name === 'systemctl'));
  const out = await S.uninstall('hello', w.deps);
  assert.equal(out.unregistered, true);
  assert.equal(out.unit, null);
  assert.ok(fs.existsSync(new URL('./fixtures/appstore-hello/server.mjs', import.meta.url)), 'the RIGS repo copy is untouched');
});

test('built-in navigation manifest: runs in place from the RIGS checkout, node, no venv', async () => {
  const w = world({ systemd: false });
  const job = await installAndWait('navigation', { dryRun: true }, w);
  assert.equal(job.state, 'done', job.error);
  assert.match(job.steps.find((s) => s.id === 'fetch').detail, /built into RIGS \(applets\/navigation\), runs in place/);
  assert.equal(job.steps.find((s) => s.id === 'venv').detail, 'no Python environment needed');
  assert.ok(!fs.existsSync(root('navigation')), 'a dry run creates nothing');
});

test('built-in catalog: Live Video, ACE-Step Studio, Krea Studio and Navigation, each model pinned, sized and placed', () => {
  const { apps, errors } = S.loadCatalog([S.CATALOG_DIR]);
  assert.deepEqual(errors, []);
  const by = Object.fromEntries(apps.map((a) => [a.id, a]));
  for (const id of ['live-video', 'acestep-studio', 'krea-studio', 'navigation']) assert.ok(by[id], `${id} is in the catalog`);
  const rigsApp = path.resolve(S.CATALOG_DIR, '..', '..');
  for (const id of ['live-video', 'acestep-studio', 'krea-studio']) {
    const m = by[id];
    assert.equal(m.needs.gpu, 'nvidia', id);
    assert.ok(m.models.length > 0, `${id} lists its models`);
    for (const x of m.models) {
      assert.ok(x.sizeGB > 0.1, `${id}: ${x.name} has a size`);
      assert.match(x.revision, /^[0-9a-f]{40}$/, `${id}: ${x.name} is pinned to a commit`);
      assert.equal(x.gated, false, `${id}: ${x.name} needs no Hugging Face login`);
    }
    if (m.runtime.type === 'python') {
      assert.match(m.needs.python, /^3\.\d+$/, `${id} pins its Python`);
      assert.match(m.runtime.torch?.index || '', /^https:\/\/download\.pytorch\.org\/whl\/cu\d+$/, `${id} names its torch CUDA index`);
      for (const a of m.runtime.pipArgs.filter((v) => v.startsWith('{rigsApp}/'))) assert.ok(fs.existsSync(a.replace('{rigsApp}', rigsApp)), `${id}: ${a} exists`);
    }
    if (m.source.type === 'rigs') {
      const dir = path.join(rigsApp, m.source.path);
      assert.ok(fs.existsSync(path.join(dir, 'server.py')), `${id}: vendored source in ${m.source.path}`);
      for (const r of m.runtime.requirements || []) assert.ok(fs.existsSync(path.join(dir, r)), `${id}: ${r} is in the source`);
    } else assert.match(m.source.ref, /^[0-9a-f]{40}$/, `${id}: git source pinned to a commit`);
  }
  const files = [...fs.readdirSync(S.CATALOG_DIR).map((n) => path.join(S.CATALOG_DIR, n))];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
  walk(path.join(rigsApp, 'appstore', 'sources'));
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes('/home/magix'), `${path.relative(rigsApp, f)} has no machine-specific path`);
});

test('built-in GPU apps: a dry run plans every step on a 24 GB NVIDIA machine', async () => {
  for (const id of ['live-video', 'acestep-studio', 'krea-studio']) {
    const job = await installAndWait(id, { dryRun: true, gpuOverseer: false }, world({ systemd: false }));
    assert.equal(job.state, 'done', `${id}: ${job.error}`);
    assert.match(job.steps.find((s) => s.id === 'models').detail, /dry run: would download|already on disk/, id);
    assert.ok(!fs.existsSync(root(id)), `${id}: a dry run creates nothing`);
  }
});

test('copy source: a re-install copies the RIGS folder again only when its files changed', async () => {
  const rel = `test/fixtures/.tmp-appstore-copy-${process.pid}`;
  const src = new URL(`../${rel}/`, import.meta.url);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(new URL('server.mjs', src), '// v1\n');
  try {
    putManifest({ id: 'copied', name: 'Copied', version: '1', source: { type: 'rigs', path: rel, copy: true }, runtime: { type: 'none' }, port: 18223, launch: { command: ['{node}', '{appDir}/server.mjs'] } });
    const w = world({ systemd: false });
    assert.equal((await installAndWait('copied', {}, w)).state, 'done');
    const again = await installAndWait('copied', {}, w);
    assert.equal(again.steps.find((s) => s.id === 'fetch').status, 'skipped', 'unchanged: not copied again');
    fs.writeFileSync(new URL('server.mjs', src), '// v2\n');
    const updated = await installAndWait('copied', {}, w);
    assert.equal(updated.steps.find((s) => s.id === 'fetch').status, 'done', 'changed in RIGS: copied again');
    assert.equal(fs.readFileSync(path.join(root('copied'), 'app', 'server.mjs'), 'utf8'), '// v2\n');
    await S.uninstall('copied', w.deps);
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('runtime.pipArgs: placeholders are rendered (e.g. a constraints file shipped in RIGS) and checked', async () => {
  assert.match(S.validateManifest(studio({ runtime: { type: 'python', pipArgs: ['-c', '{nope}/c.txt'] } })).errors.join(' | '), /runtime\.pipArgs\[1\] uses unknown placeholder \{nope\}/);
  putManifest(studio({ id: 'pinned', port: 18224, runtime: { type: 'python', requirements: ['requirements.txt'], pipArgs: ['--constraint', '{rigsApp}/appstore/sources/acestep-studio/constraints.txt'] } }));
  const w = world();
  const job = await installAndWait('pinned', { until: 'deps' }, w);
  assert.equal(job.state, 'done', job.error);
  assert.equal(S.statusFor('pinned').state, 'partial');
  const pip = w.calls.find((c) => c.name === 'uv' && c.args[0] === 'pip');
  const i = pip.args.indexOf('--constraint');
  assert.equal(pip.args[i + 1], path.join(path.resolve(S.CATALOG_DIR, '..', '..'), 'appstore', 'sources', 'acestep-studio', 'constraints.txt'));
});

// ---------------------------------------------------------------- uninstall, status, list

test('uninstall: unregisters, disables the unit and moves everything to the trash — nothing is deleted', async () => {
  const w = world();
  const appRoot = root('studio');
  const out = await S.uninstall('studio', w.deps);
  assert.equal(out.unregistered, true);
  assert.equal(out.unit, 'rigs-app-studio.service');
  assert.equal(out.overseer, true);
  assert.ok(w.calls.some((c) => c.name === 'systemctl' && c.args.join(' ') === '--user disable --now rigs-app-studio.service'));
  assert.ok(w.calls.some((c) => c.name === 'systemctl' && c.args.join(' ') === '--user daemon-reload'));
  assert.ok(!appsInConfig().includes('studio'));
  assert.ok(!fs.existsSync(appRoot));
  assert.ok(!fs.existsSync(path.join(UNITS, 'rigs-app-studio.service')));
  const trash = path.join(HOME, 'trash');
  const trashedRoot = out.trashed.find((p) => p.endsWith('-appstore-studio'));
  assert.ok(trashedRoot && trashedRoot.startsWith(trash), out.trashed.join(', '));
  assert.ok(fs.readFileSync(path.join(trashedRoot, 'app', 'models', 'vae.bin')).equals(VAE), 'models moved, not deleted');
  assert.ok(fs.existsSync(path.join(trashedRoot, 'install.json')));
  assert.ok(fs.readFileSync(out.trashed.find((p) => p.endsWith('rigs-app-studio.service')), 'utf8').includes(S.MARKER));
  const clients = JSON.parse(fs.readFileSync(OVERSEER, 'utf8'));
  assert.deepEqual(clients.map((c) => c.id), ['comfyui'], 'only the store\'s own overseer entry is removed');
  assert.equal(S.statusFor('studio').state, 'not-installed');
  await assert.rejects(S.uninstall('studio', w.deps), /"studio" is not installed/);
});

test('uninstall keeps models that live outside the app folder and lists them', async () => {
  const shared = path.join(HOME, 'shared-models');
  putManifest(studio({ id: 'sharer', port: 18223, gpuOverseer: undefined, postInstall: [], models: [{ name: 'shared', kind: 'hf', repo: 'acme/shared', files: ['s.bin'], dest: shared, sizeGB: 0.001 }] }));
  const w = world();
  assert.equal((await installAndWait('sharer', {}, w)).state, 'done');
  const out = await S.uninstall('sharer', w.deps);
  assert.ok(fs.existsSync(path.join(shared, 's.bin')));
  assert.deepEqual(out.kept, [`shared: ${shared}`]);
});

test('list: catalog cards with fit and install state; unknown ids are 404s', async () => {
  const r = await S.list(world().deps);
  assert.equal(r.node, 'test-node');
  assert.equal(r.platform, 'linux');
  assert.equal(r.freeGB, 500);
  const by = Object.fromEntries(r.apps.map((a) => [a.id, a]));
  assert.equal(by.navigation.install.state, 'not-installed');
  assert.equal(by.navigation.fit.ok, true);
  assert.equal(by.studio2.install.state, 'installed');
  assert.equal(by.clash.install.state, 'external');
  assert.equal(by.studio2.models.length, 2);
  assert.equal(by.studio2.runtime, 'python');
  assert.equal(by.studio2.diskGB, 1);
  const d = await S.detail('studio2', world().deps);
  assert.equal(d.manifest.source.url, REPO);
  assert.throws(() => S.install('nope', {}, world().deps), /"nope" is not in the App Store catalog/);
  await assert.rejects(S.detail('nope'), /not in the App Store catalog/);
  assert.throws(() => S.jobFor('nope'), /not in the App Store catalog/);
});

test('status after a restart: an install that was running reads as interrupted, and its job rebuilds from disk', () => {
  const st = S.readState('studio2');
  fs.writeFileSync(path.join(root('studio2'), 'install.json'), JSON.stringify({ ...st, state: 'installing' }));
  S.resetAppstoreState();
  const s = S.statusFor('studio2');
  assert.equal(s.state, 'failed');
  assert.match(s.error, /interrupted/);
  const j = S.jobFor('studio2');
  assert.equal(j.state, 'failed');
  assert.equal(j.steps.find((x) => x.id === 'models').status, 'done');
  assert.ok(j.log.length > 0);
});
