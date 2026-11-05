// Home Security on macOS: webcams run inside "RIGS Camera.app" so macOS can show the camera Allow prompt
// (apps/home-security/camera-helper.js, macos/RigsCamera.swift). The Swift app itself is exercised on a Mac; here the real
// ingest worker, the unix-socket motion feed, the stop/permission flow and the HTTP routes run against a fake helper that
// speaks the same command line (test/fixtures/fake-rigs-camera.mjs) and a real ffmpeg.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'apps', 'home-security');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-rigs-camera.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-hs-cam-'));
const rigs = []; // every worker a test started: a failing assertion must not leave a helper and an ffmpeg running
after(async () => {
  await Promise.all(rigs.map((r) => r.worker.stop().catch(() => {})));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const H = await import('../apps/home-security/camera-helper.js');
const I = await import('../apps/home-security/ingest.js');
const { createApp } = await import('../apps/home-security/server.js');
const hasFfmpeg = I.findFfmpeg().found;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bundle id: the real home owns dev.rigs.camera, a scratch home gets its own id (its grant never touches the real one)', () => {
  const real = path.join(os.homedir(), '.rigs');
  assert.equal(H.helperLabel(real), 'dev.rigs.camera');
  const scratch = H.helperLabel(path.join(tmp, 'home'));
  assert.match(scratch, /^dev\.rigs\.camera\.[0-9a-f]{8}$/);
  const p = H.helperPaths(real);
  assert.equal(p.app, path.join(real, 'bin', 'RIGS Camera.app'));
  assert.equal(p.exe, path.join(p.app, 'Contents/MacOS/rigs-camera'));
  assert.equal(p.name, 'RIGS Camera');
  assert.equal(H.helperPaths(path.join(tmp, 'home')).name, 'RIGS Camera (dev)');
});

test('the bundle sources: Info.plist asks for the camera with a reason, runs without a Dock icon; build.sh and sourceHash agree', () => {
  const plist = fs.readFileSync(path.join(APP, 'macos', 'Info.plist'), 'utf8');
  assert.match(plist, /<key>NSCameraUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.rigs\.camera<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>rigs-camera<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
  const build = fs.readFileSync(path.join(APP, 'macos', 'build.sh'), 'utf8');
  assert.match(build, /-o "\$tmp\/Contents\/MacOS\/rigs-camera"/);
  assert.match(build, /codesign --force --sign - --identifier "\$id"/);
  assert.match(build, /cat "\$here\/RigsCamera\.swift" "\$here\/Info\.plist" "\$here\/build\.sh" \| shasum -a 256/);
  const want = crypto.createHash('sha256');
  for (const f of ['RigsCamera.swift', 'Info.plist', 'build.sh']) want.update(fs.readFileSync(path.join(APP, 'macos', f)));
  assert.equal(H.sourceHash(), want.digest('hex'));
});

test('the Swift helper keeps its contract: the three modes, auth/pid/exit files, denied = exit 3, ffmpeg gets SIGINT', () => {
  const swift = fs.readFileSync(path.join(APP, 'macos', 'RigsCamera.swift'), 'utf8');
  for (const needle of ['case "status"', 'case "request"', 'case "run"', '/auth.json', '/pid.json', '/exit.json', '/ffmpeg.log',
    'AVCaptureDevice.requestAccess(for: .video)', 'authorizationStatus(for: .video)', 'return 3', 'SIGINT']) assert.ok(swift.includes(needle), needle);
  assert.equal(H.DENIED_EXIT, 3);
});

test('motion socket path stays under the unix socket limit even for a long data dir', () => {
  const short = H.motionSocketPath('/Users/mix/.rigs/home-security', 'webcam-facetime-hd-camera');
  assert.ok(Buffer.byteLength(short) < 104, short);
  const long = H.motionSocketPath(`/Users/mix/${'x'.repeat(120)}/home-security`, 'cam');
  assert.ok(Buffer.byteLength(long) < 104, long);
  assert.notEqual(H.motionSocketPath('/d', 'a'), H.motionSocketPath('/d', 'b'));
});

test('ffmpeg argv: unchanged by default; inside the helper it has no stdin and sends motion frames to the socket', () => {
  const camera = { id: 'c', kind: 'webcam', source: { device: 'FaceTime HD Camera' } };
  const settings = { recording: { segmentSeconds: 2 }, motion: {}, live: {} };
  const base = { camera, settings, platform: 'darwin', copy: false, encoder: 'libx264', snapshotPath: '/s/latest.jpg' };
  const plain = I.buildFfmpegArgs(base);
  assert.ok(!plain.includes('-nostdin'));
  assert.equal(plain[plain.indexOf('rawvideo') + 1], 'pipe:1');
  const viaHelper = I.buildFfmpegArgs({ ...base, nostdin: true, motionOut: 'unix:/r/m.sock' });
  assert.ok(viaHelper.includes('-nostdin'));
  assert.equal(viaHelper[viaHelper.indexOf('rawvideo') + 1], 'unix:/r/m.sock');
  assert.ok(viaHelper.includes('avfoundation') && viaHelper.includes('FaceTime HD Camera:none'));
  // the banner of that output still gives the frame size
  assert.deepEqual(I.parseMotionDims("Output #1, rawvideo, to 'unix:/r/m.sock':\n  Stream #1:0: Video: rawvideo (Y800 / 0x30303859), gray, 160x90, 5 fps"), { width: 160, height: 90 });
});

test('stall wording: without the helper a silent macOS webcam is a permission problem; with it, the camera is the suspect', () => {
  const mac = { gotSegment: false, platform: 'darwin', kind: 'webcam' };
  assert.match(I.stallReason(mac), /camera permission denied/);
  assert.match(I.stallReason({ ...mac, helperProblem: 'swiftc not found' }), /could not be set up \(swiftc not found\).*xcode-select --install/);
  assert.equal(I.stallReason({ ...mac, viaHelper: true }), 'stalled: no video from the camera');
  assert.equal(I.stallReason({ ...mac, gotSegment: true }), 'stalled: the camera stopped sending video');
  assert.equal(I.stallReason({ gotSegment: false, platform: 'linux', kind: 'webcam' }), 'stalled: no video from the camera');
});

test('launch command: LaunchServices (open -W -n), the app bundle, the job dir; ffmpeg after --', () => {
  const helper = new H.CameraHelper({ home: path.join(tmp, 'home'), platform: 'darwin' });
  const run = helper.launchSpec({ jobDir: '/j', cwd: '/c', cmd: ['/opt/homebrew/bin/ffmpeg', '-i', 'x:none', '-filter_complex', '[0:v]split=2[a][b]'], parentPid: 42 });
  assert.equal(run.bin, '/usr/bin/open');
  assert.deepEqual(run.args.slice(0, 7), ['-W', '-n', '-g', '-j', '-a', helper.paths.app, '--args']);
  assert.deepEqual(run.args.slice(7), ['run', '--dir', '/j', '--cwd', '/c', '--parent', '42', '--', '/opt/homebrew/bin/ffmpeg', '-i', 'x:none', '-filter_complex', '[0:v]split=2[a][b]']);
  assert.deepEqual(helper.launchSpec({ jobDir: '/j', mode: 'status' }).args.slice(7), ['status', '--dir', '/j']);
  assert.equal(new H.CameraHelper({ home: tmp, platform: 'linux' }).supported, false);
});

test('building: only when the sources or bundle id changed (a rebuild invalidates the grant); swiftc missing is reported, not thrown', async () => {
  const src = path.join(tmp, 'macos-src');
  fs.cpSync(path.join(APP, 'macos'), src, { recursive: true });
  const home = path.join(tmp, 'build-home');
  const calls = [];
  const runner = async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === 'bash') { // play build.sh: stamp the bundle
      const [, app, id] = args;
      fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
      fs.mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
      fs.writeFileSync(path.join(app, 'Contents/MacOS/rigs-camera'), '');
      fs.writeFileSync(path.join(app, 'Contents/Resources/source.sha256'), `${H.sourceHash(src)} ${id}\n`);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const helper = new H.CameraHelper({ home, platform: 'darwin', runner, sourceDir: src });
  assert.deepEqual(await helper.ensureBuilt(), { ok: true, built: true });
  assert.equal(calls.filter((c) => c[0] === 'bash').length, 1);
  assert.ok(!calls.some((c) => c[0] === 'tccutil'), 'a first build has no old grant to drop');
  assert.deepEqual(await helper.ensureBuilt(), { ok: true, built: false });
  assert.equal(calls.filter((c) => c[0] === 'bash').length, 1, 'unchanged sources: no rebuild');
  fs.appendFileSync(path.join(src, 'RigsCamera.swift'), '\n// changed\n');
  assert.deepEqual(await helper.ensureBuilt(), { ok: true, built: true });
  assert.equal(calls.filter((c) => c[0] === 'bash').length, 2);
  assert.deepEqual(calls.at(-1), ['tccutil', 'reset', 'Camera', helper.paths.bundleId], "the old build's stale entry is reset, for this bundle id only");
  const noSwift = new H.CameraHelper({ home: path.join(tmp, 'nohome'), platform: 'darwin', sourceDir: src, runner: async () => ({ code: 2, stdout: '', stderr: 'swiftc not found: run xcode-select --install' }) });
  assert.deepEqual(await noSwift.ensureBuilt(), { ok: false, built: false, reason: 'swiftc not found' });
  assert.equal(noSwift.describe().problem, 'swiftc not found');
});

// ── the worker through the (fake) helper ─────────────────────────────────────────────────────────────────────────

function rig(name, auth) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'camera-state.json');
  const setAuth = (status) => fs.writeFileSync(stateFile, JSON.stringify({ status }));
  setAuth(auth);
  process.env.FAKE_CAMERA_STATE = stateFile;
  const helper = new H.CameraHelper({
    home: path.join(dir, 'home'), platform: 'darwin', handles: (c) => c.kind === 'test', ensure: async () => ({ ok: true, built: false }),
    runner: async (bin, args) => { helper.ran.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    launch: ({ jobDir, cwd, cmd, parentPid, mode }) => ({
      bin: process.execPath,
      args: [FAKE, mode, '--dir', jobDir, ...(mode === 'run' ? ['--cwd', cwd, '--parent', String(parentPid), '--', ...cmd] : [])],
    }),
  });
  helper.ran = [];
  const camera = { id: 't1', kind: 'test', enabled: true, source: { lavfi: 'testsrc2' }, input: { width: 320, height: 240, fps: 10 }, transcode: 'h264' };
  const settings = { recording: { segmentSeconds: 1 }, motion: { fps: 5, width: 160 }, live: { snapshotFps: 1 }, ffmpeg: {} };
  const worker = new I.CameraWorker('t1', {
    dataDir: dir, ffmpeg: I.findFfmpeg(), platform: 'linux', helper, settings: () => settings, camera: () => camera, inputUrl: () => null, ring: new I.SegmentRing(30),
  });
  const seen = { frames: 0, segments: 0, statuses: [] };
  worker.on('frame', () => seen.frames++);
  worker.on('segment', () => seen.segments++);
  worker.on('status', (s) => seen.statuses.push(s.status));
  const r = { dir, helper, worker, seen, setAuth, jobs: path.join(dir, 'run', 'camera-access') };
  rigs.push(r);
  return r;
}

test('allowed: ffmpeg runs inside the helper; segments, the motion feed (unix socket) and latest.jpg all arrive; stop is graceful', { skip: !hasFfmpeg }, async () => {
  const r = rig('allowed', 'authorized');
  r.worker.start();
  await waitFor(() => r.worker.status === 'recording' && r.seen.frames > 2, 25000, 'recording with motion frames');
  assert.ok(r.seen.segments >= 1);
  await waitFor(() => { try { return fs.statSync(path.join(r.dir, 'live', 't1', 'latest.jpg')).size > 500; } catch { return false; } }, 10000, 'latest.jpg');
  assert.equal(r.worker.viaHelper, true);
  assert.ok(Number.isInteger(r.worker.pid) && Number.isInteger(r.worker.childPid), 'the helper and its ffmpeg are both tracked');
  assert.notEqual(r.worker.pid, r.worker.childPid);
  assert.ok(!r.seen.statuses.includes('needs-permission') && !r.seen.statuses.includes('error'), r.seen.statuses.join());
  const { pid, childPid } = r.worker;
  const t0 = Date.now();
  await r.worker.stop();
  assert.ok(Date.now() - t0 < 4000, 'SIGTERM → ffmpeg SIGINT closes it at once, no SIGKILL timeout');
  assert.equal(r.worker.status, 'idle');
  await waitFor(() => !alive(pid) && !alive(childPid), 5000, 'helper and ffmpeg gone');
  assert.ok(fs.readdirSync(path.join(r.dir, 'segments', 't1')).length >= 1);
  assert.ok(!fs.existsSync(H.motionSocketPath(r.dir, 't1')), 'the motion socket is removed');
});

test('waiting for Allow: "needs-permission" with the click-Allow text, not an error loop; it records once Allow is clicked', { skip: !hasFfmpeg }, async () => {
  const r = rig('prompt', 'notDetermined');
  r.worker.start();
  await waitFor(() => r.worker.status === 'needs-permission', 10000, 'needs-permission');
  assert.equal(r.worker.error, H.MESSAGES.notDetermined);
  assert.match(r.worker.error, /click Allow on the Mac.*System Settings › Privacy & Security › Camera/);
  await sleep(1500);
  assert.equal(r.worker.status, 'needs-permission');
  assert.equal(r.worker.restarts, 0, 'no restart loop while the prompt is up');
  assert.ok(r.worker.pid, 'the waiting helper is tracked, so it can be stopped');
  // the person clicks Allow (what `rigs-camera request` reports)
  assert.equal(await r.helper.request(r.jobs), 'authorized');
  await waitFor(() => r.worker.status === 'recording', 25000, 'recording after Allow');
  assert.equal(r.worker.restarts, 0);
  await r.worker.stop();
});

test('waiting for Allow is not a stall: the no-frames watchdog does not kill the helper at the prompt', { skip: !hasFfmpeg }, async () => {
  const r = rig('prompt-long', 'notDetermined');
  r.worker.start();
  await waitFor(() => r.worker.status === 'needs-permission', 10000, 'needs-permission');
  const pid = r.worker.pid;
  await sleep(14000); // the watchdog fires after 3 × 1 s segment + 10 s = 13 s without a segment
  assert.equal(r.worker.status, 'needs-permission');
  assert.equal(r.worker.restarts, 0);
  assert.ok(alive(pid), 'still waiting, not killed');
  await r.worker.stop();
  await waitFor(() => !alive(pid), 5000, 'helper stopped');
});

test('denied: a plain "switch it on in System Settings" state with a slow re-check; no error count; re-check right away on request', { skip: !hasFfmpeg }, async () => {
  const r = rig('denied', 'denied');
  r.worker.start();
  await waitFor(() => r.worker.status === 'needs-permission' && r.worker.error === H.MESSAGES.denied, 10000, 'denied state');
  assert.equal(r.worker.restarts, 0);
  assert.ok(r.worker.retryAt > Date.now() + 5000, 'a slow re-check, not a hot loop');
  assert.equal(r.worker.child, null);
  r.setAuth('authorized'); // switched on in System Settings
  assert.equal(r.worker.retryPermissionNow(), true);
  await waitFor(() => r.worker.status === 'recording', 25000, 'recording after switching it on');
  assert.equal(r.worker.retryPermissionNow(), false, 'nothing to re-check once it runs');
  await r.worker.stop();
});

test('restricted (Screen Time / MDM): its own explanation', { skip: !hasFfmpeg }, async () => {
  const r = rig('restricted', 'restricted');
  r.worker.start();
  await waitFor(() => r.worker.status === 'needs-permission', 10000, 'restricted state');
  assert.equal(r.worker.error, H.MESSAGES.restricted);
  await r.worker.stop();
});

// ── HTTP: Grant camera access ────────────────────────────────────────────────────────────────────────────────────

async function api(name, auth, { ensure } = {}) {
  const r = rig(name, auth);
  if (ensure) r.helper.ensureFn = ensure;
  const env = { ...process.env, HOME_SECURITY_DATA: path.join(r.dir, 'data'), RIGS_PORT: '1' };
  const app = createApp({ env, cameraHelper: r.helper, fetchImpl: async () => { throw new Error('no daemon'); } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (p, method = 'GET') => (await fetch(base + p, { method })).json();
  return { ...r, app, call, close: () => new Promise((resolve) => app.server.close(resolve)) };
}

test('GET /api/camera-access: the authorization state and what to do about it; Linux/Windows report "unsupported"', async () => {
  const a = await api('http-state', 'notDetermined');
  try {
    const st = await a.call('/api/camera-access');
    assert.equal(st.supported, true);
    assert.equal(st.status, 'notDetermined');
    assert.equal(st.message, H.MESSAGES.notDetermined);
    assert.equal(st.helper.bundleId, a.helper.paths.bundleId);
  } finally { await a.close(); }
  const app = createApp({ env: { ...process.env, HOME_SECURITY_DATA: path.join(tmp, 'http-linux') }, platform: 'linux' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const st = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/camera-access`)).json();
    assert.equal(st.supported, false);
    assert.equal(st.status, 'unsupported');
    assert.equal(app.helper, null);
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});

test('POST /api/camera-access/grant: undecided → the prompt is raised ("prompting") and the answer is picked up', async () => {
  const a = await api('http-grant', 'notDetermined');
  try {
    const g = await a.call('/api/camera-access/grant', 'POST');
    assert.equal(g.ok, true);
    assert.equal(g.status, 'prompting');
    assert.match(g.message, /Click Allow in the “RIGS Camera \(dev\)” dialog/);
    await waitFor(async () => (await a.call('/api/camera-access')).status === 'authorized', 8000, 'authorized after the answer');
    assert.equal((await a.call('/api/camera-access/grant', 'POST')).ok, true);
  } finally { await a.close(); }
});

test('POST /api/camera-access/grant: denied → System Settings › Camera is opened; macOS will not ask again', async () => {
  const a = await api('http-denied', 'denied');
  try {
    const g = await a.call('/api/camera-access/grant', 'POST');
    assert.equal(g.ok, false);
    assert.equal(g.status, 'denied');
    assert.equal(g.openedSettings, true);
    assert.equal(g.message, H.MESSAGES.denied);
    assert.deepEqual(a.helper.ran.at(-1), ['/usr/bin/open', H.SETTINGS_PANE]);
  } finally { await a.close(); }
  const b = await api('http-restricted', 'restricted');
  try {
    const g = await b.call('/api/camera-access/grant', 'POST');
    assert.equal(g.ok, false);
    assert.equal(g.openedSettings, false);
    assert.equal(g.message, H.MESSAGES.restricted);
  } finally { await b.close(); }
});

test('no swiftc: the helper cannot be built → a clear "install the Xcode command line tools" message, not a crash', async () => {
  const a = await api('http-noswift', 'notDetermined', { ensure: async () => ({ ok: false, built: false, reason: 'swiftc not found' }) });
  try {
    const st = await a.call('/api/camera-access');
    assert.equal(st.status, 'helper-unavailable');
    assert.match(st.message, /xcode-select --install/);
    const g = await a.call('/api/camera-access/grant', 'POST');
    assert.equal(g.ok, false);
    assert.equal(g.status, 'helper-unavailable');
  } finally { await a.close(); }
});
