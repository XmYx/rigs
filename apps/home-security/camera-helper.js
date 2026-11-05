// Home Security — macOS camera helper ("RIGS Camera.app", macos/RigsCamera.swift).
//
// Why: macOS shows the camera Allow prompt (and lists an app under Privacy & Security › Camera) only for an app bundle
// with NSCameraUsageDescription. This app runs as a bare `node` with a bare `ffmpeg` child, so the prompt never comes
// and ffmpeg silently waits for frames. On macOS a webcam's ffmpeg therefore runs as a child of RIGS Camera.app, which
// LaunchServices (`open`) starts as its own responsible process; TCC then attributes the camera to "RIGS Camera".
//
// This module: where the bundle lives, building it (only when its sources changed: the ad-hoc signature pins the grant
// to the build), asking its authorization state / asking macOS to prompt, and HelperChild, a child-process look-alike
// for one `rigs-camera run` job so ingest.js's CameraWorker keeps one code path:
//   child.stderr  ← the helper's ffmpeg.log (tailed)        child.stdout ← the motion frames, over a unix socket
//   child.stdin   ← write('q') → graceful stop              child.kill(sig), child.pid (the helper), 'exit' (code, sig)
//   child.auth()  → { status } the helper's camera authorization (notDetermined = the Allow prompt is up)
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_DIR = path.join(HERE, 'macos');
const SOURCE_FILES = ['RigsCamera.swift', 'Info.plist', 'build.sh'];
export const BUNDLE_ID = 'dev.rigs.camera';
export const APP_NAME = 'RIGS Camera.app';
export const DENIED_EXIT = 3;
export const SETTINGS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera';

/** The text for each way camera access can be missing. One place, so the UI, the status line and the tests agree. */
export const MESSAGES = {
  notDetermined: 'waiting for camera permission — click Allow on the Mac, or enable “RIGS Camera” in System Settings › Privacy & Security › Camera',
  denied: 'camera access is switched off for “RIGS Camera” — enable it in System Settings › Privacy & Security › Camera',
  restricted: 'camera access is blocked on this Mac (Screen Time or a device-management profile)',
  noHelper: (why) => `no frames from the camera and the “RIGS Camera” helper could not be set up (${why}) — install the Xcode command line tools (xcode-select --install) and restart the app, or allow ffmpeg in System Settings › Privacy & Security › Camera`,
};

/** Pure: the real home owns dev.rigs.camera; a scratch/dev home gets its own id so it never takes over the real grant. */
export function helperLabel(home, defaultHome = path.join(os.homedir(), '.rigs')) {
  const h = path.resolve(home);
  return h === path.resolve(defaultHome) ? BUNDLE_ID : `${BUNDLE_ID}.${crypto.createHash('sha256').update(h).digest('hex').slice(0, 8)}`;
}

export function helperPaths(home, defaultHome) {
  const bundleId = helperLabel(home, defaultHome);
  const app = path.join(home, 'bin', APP_NAME);
  return {
    bundleId, app, name: bundleId === BUNDLE_ID ? 'RIGS Camera' : 'RIGS Camera (dev)',
    exe: path.join(app, 'Contents/MacOS/rigs-camera'),
    hashFile: path.join(app, 'Contents/Resources/source.sha256'),
  };
}

/** Same bytes, same order as build.sh, which stamps "<hash> <bundle id>" into the bundle. */
export function sourceHash(dir = SOURCE_DIR) {
  const h = crypto.createHash('sha256');
  for (const f of SOURCE_FILES) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

/** Pure: unix socket paths are limited to ~104 bytes on macOS; the data dir path can be long. */
export function motionSocketPath(dataDir, id) {
  const tag = crypto.createHash('sha256').update(`${dataDir}\0${id}`).digest('hex').slice(0, 10);
  const preferred = path.join(dataDir, 'run', `m-${tag}.sock`);
  return Buffer.byteLength(preferred) < 100 ? preferred : path.join('/tmp', `rigs-hs-${tag}.sock`);
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function execFileP(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000, encoding: 'utf8', maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
}

// ── the child look-alike for one `rigs-camera run` job ────────────────────────────────────────────────────────────

export class HelperChild extends EventEmitter {
  /** @param o { jobDir, launcher:{bin,args}, motionSock?, spawnImpl? } */
  constructor(o) {
    super();
    Object.assign(this, { jobDir: o.jobDir, launcherSpec: o.launcher, motionSock: o.motionSock || null, spawnImpl: o.spawnImpl || spawn });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = Object.assign(new EventEmitter(), {
      write: (s) => { if (String(s).includes('q')) this.kill('SIGTERM'); return true; },
      end: () => {},
    });
    this.logOffset = 0; this.exited = false; this.pidInfo = {}; this.server = null; this.launcher = null; this.timer = null;
  }

  get pid() { return this.pidInfo.helper || null; }
  get childPid() { return this.pidInfo.child || null; }
  /** The helper's camera authorization as last written: { status:'authorized'|'notDetermined'|'denied'|'restricted', at } or null. */
  auth() { return readJson(path.join(this.jobDir, 'auth.json')); }

  async start() {
    fs.rmSync(this.jobDir, { recursive: true, force: true });
    fs.mkdirSync(this.jobDir, { recursive: true });
    if (this.motionSock) {
      fs.mkdirSync(path.dirname(this.motionSock), { recursive: true });
      fs.rmSync(this.motionSock, { force: true });
      this.server = net.createServer((sock) => {
        sock.on('data', (d) => this.stdout.write(d));
        sock.on('error', () => {});
      });
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.motionSock, resolve); });
    }
    const { bin, args } = this.launcherSpec;
    this.launcher = this.spawnImpl(bin, args, { stdio: 'ignore' });
    this.launcher.on('error', (e) => { setImmediate(() => this.emit('error', e)); this.finish(127, null, e.message); });
    this.launcher.on('exit', (code, sig) => this.finish(code, sig));
    this.timer = setInterval(() => this.pump(), 200);
    this.timer.unref?.();
    return this;
  }

  pump() {
    try {
      const file = path.join(this.jobDir, 'ffmpeg.log');
      const st = fs.statSync(file);
      if (st.size < this.logOffset) this.logOffset = 0;
      if (st.size > this.logOffset) {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(st.size - this.logOffset);
          fs.readSync(fd, buf, 0, buf.length, this.logOffset);
          this.logOffset = st.size;
          this.stderr.write(buf);
        } finally { fs.closeSync(fd); }
      }
    } catch { /* no log yet */ }
    const p = readJson(path.join(this.jobDir, 'pid.json'));
    if (p && (p.helper !== this.pidInfo.helper || p.child !== this.pidInfo.child)) { this.pidInfo = p; this.emit('pids', p); }
  }

  finish(code, sig, error) {
    if (this.exited) return;
    this.exited = true;
    clearInterval(this.timer);
    this.pump();
    const x = readJson(path.join(this.jobDir, 'exit.json'));
    if (this.server) { this.server.close(); fs.rmSync(this.motionSock, { force: true }); }
    this.stdout.end(); this.stderr.end();
    // exit.json carries the real result (`open -W` does not relay the exit status); without it the helper died abruptly
    const exitCode = x ? Number(x.code) : (code ?? (sig ? 1 : 0));
    this.exitInfo = { code: exitCode, reason: x?.reason || null, error: error || x?.error || null };
    // a tick later: the caller attaches its 'exit' listener after `await start()`, which a fast spawn failure would beat
    setImmediate(() => this.emit('exit', x?.signal ? null : exitCode, x?.signal ? 'SIGKILL' : (sig || null)));
  }

  /** SIGTERM = graceful (the helper sends ffmpeg SIGINT so it closes its last segment); SIGKILL takes both processes. */
  kill(sig = 'SIGTERM') {
    const send = (pid, s) => { try { if (pid) process.kill(pid, s); } catch { /* gone */ } };
    const { helper, child } = this.pidInfo;
    if (sig === 'SIGKILL') { send(child, 'SIGKILL'); send(helper, 'SIGKILL'); }
    else if (helper) send(helper, sig);
    if (!helper || sig === 'SIGKILL') { try { this.launcher?.kill(sig); } catch { /* gone */ } }
  }
}

// ── the helper: build, authorization, launching ───────────────────────────────────────────────────────────────────

export class CameraHelper {
  /**
   * @param o { home, platform, runner, defaultHome, sourceDir, launch, spawnImpl, handles, ensure }
   *   launch({ jobDir, cwd, cmd, parentPid, mode }) → { bin, args }  (tests replace it with a fake helper)
   *   handles(camera) → should this camera run through the helper? (webcams)
   *   ensure() → { ok, built, reason? }  (tests skip the swiftc build)
   */
  constructor(o = {}) {
    this.home = o.home;
    this.platform = o.platform || process.platform;
    this.runner = o.runner || execFileP;
    this.sourceDir = o.sourceDir || SOURCE_DIR;
    this.paths = helperPaths(this.home, o.defaultHome);
    this.launchFn = o.launch || null;
    this.spawnImpl = o.spawnImpl || spawn;
    this.handles = o.handles || ((c) => c.kind === 'webcam');
    this.ensureFn = o.ensure || null;
    this.buildPromise = null;
    this.problem = null;
    this.statusCache = null;
  }

  get supported() { return this.platform === 'darwin'; }

  /** Build RIGS Camera.app when its sources/bundle id changed. → { ok, built, reason? }. Never throws. Concurrent calls share one build. */
  ensureBuilt() {
    if (this.ensureFn) return this.ensureFn();
    this.buildPromise ||= this.#build().finally(() => { this.buildPromise = null; });
    return this.buildPromise;
  }

  async #build() {
    const p = this.paths;
    try {
      const want = `${sourceHash(this.sourceDir)} ${p.bundleId}`;
      let had = null;
      try { had = fs.readFileSync(p.hashFile, 'utf8').trim(); } catch { /* not built */ }
      if (had === want && fs.existsSync(p.exe)) { this.problem = null; return { ok: true, built: false }; }
      const r = await this.runner('bash', [path.join(this.sourceDir, 'build.sh'), p.app, p.bundleId, p.name], { timeout: 300000 });
      if (r.code !== 0) {
        this.problem = r.code === 2 || /swiftc not found/.test(r.stderr) ? 'swiftc not found' : `build failed: ${String(r.stderr || r.stdout).trim().split('\n').pop()}`;
        return { ok: false, built: false, reason: this.problem };
      }
      // an older build's grant is pinned to its cdhash: it shows "on" but no longer applies. Drop this app's entry only.
      if (had) await this.runner('tccutil', ['reset', 'Camera', p.bundleId], { timeout: 10000 });
      this.problem = null; this.statusCache = null;
      return { ok: true, built: true };
    } catch (e) {
      this.problem = `build failed: ${e.message}`;
      return { ok: false, built: false, reason: this.problem };
    }
  }

  launchSpec({ jobDir, cwd, cmd, parentPid = process.pid, mode = 'run' }) {
    if (this.launchFn) return this.launchFn({ jobDir, cwd, cmd, parentPid, mode });
    const tail = mode === 'run' ? ['--cwd', cwd, '--parent', String(parentPid), '--', ...cmd] : [];
    return { bin: '/usr/bin/open', args: ['-W', '-n', '-g', '-j', '-a', this.paths.app, '--args', mode, '--dir', jobDir, ...tail] };
  }

  /** Start one supervised ffmpeg inside the helper. → HelperChild (already running). */
  async launchRun({ jobDir, cwd, cmd, motionSock }) {
    const child = new HelperChild({ jobDir, motionSock, spawnImpl: this.spawnImpl, launcher: this.launchSpec({ jobDir, cwd, cmd }) });
    return child.start();
  }

  /** Run a short job (`status`/`request`) and read its auth.json. → { status, ... } or null */
  async #job(mode, jobDir, timeoutMs) {
    fs.rmSync(jobDir, { recursive: true, force: true });
    fs.mkdirSync(jobDir, { recursive: true });
    const { bin, args } = this.launchSpec({ jobDir, mode });
    await new Promise((resolve) => {
      let child;
      try { child = this.spawnImpl(bin, args, { stdio: 'ignore' }); } catch { resolve(); return; }
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, timeoutMs);
      child.on('error', () => { clearTimeout(t); resolve(); });
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
    return readJson(path.join(jobDir, 'auth.json'));
  }

  /** The camera authorization for this helper: authorized | notDetermined | denied | restricted | unknown (cached 3 s). */
  async authStatus(jobsDir) {
    if (this.statusCache && Date.now() - this.statusCache.at < 3000) return this.statusCache.status;
    const a = await this.#job('status', path.join(jobsDir, 'status'), 15000);
    const status = a?.status || 'unknown';
    this.statusCache = { at: Date.now(), status };
    return status;
  }

  /** Make macOS show the Allow prompt (it waits for the person). Resolves when answered. → authorization status. */
  async request(jobsDir, timeoutMs = 10 * 60_000) {
    this.statusCache = null;
    const a = await this.#job('request', path.join(jobsDir, 'request'), timeoutMs);
    this.statusCache = null;
    return a?.status || 'unknown';
  }

  /** Open System Settings › Privacy & Security › Camera. */
  async openSettings() {
    const r = await this.runner('/usr/bin/open', [SETTINGS_PANE], { timeout: 10000 });
    return r.code === 0;
  }

  describe() {
    return { supported: this.supported, bundleId: this.paths.bundleId, name: this.paths.name, app: this.paths.app, problem: this.problem };
  }
}
