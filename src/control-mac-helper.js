import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { RIGS_HOME } from './config.js';
import { APP_DIR, run } from './util.js';
import { ControlError } from './control-error.js';

// RIGS Control.app: the macOS helper that holds Screen Recording and Accessibility (docs/full-access.md §4).
// Built from scripts/control/macos with swiftc into RIGS_HOME/bin, ad-hoc signed, and run as its own LaunchAgent
// so TCC sees it, not the daemon's node, as the responsible process.

export const BUNDLE_ID = 'dev.rigs.control';
export const APP_NAME = 'RIGS Control.app';
export const SOURCE_DIR = path.join(APP_DIR, 'scripts/control/macos');
const SOURCE_FILES = ['RigsControl.swift', 'Info.plist', 'build.sh'];

/**
 * Pure: the real home owns dev.rigs.control; a scratch or dev home gets its own label, so it never replaces the real
 * helper. The label is also the app's bundle id: TCC keeps one entry per bundle id, so a dev build never takes over
 * (or resets) the real helper's grants.
 */
export function helperLabel(home, defaultHome = path.join(os.homedir(), '.rigs')) {
  const h = path.resolve(home);
  return h === path.resolve(defaultHome) ? BUNDLE_ID : `${BUNDLE_ID}.${crypto.createHash('sha256').update(h).digest('hex').slice(0, 8)}`;
}

/** Pure: the name System Settings lists the app under. */
export const helperName = (label) => (label === BUNDLE_ID ? 'RIGS Control' : 'RIGS Control (dev)');

export function helperPaths(home = RIGS_HOME, { launchAgents = path.join(os.homedir(), 'Library/LaunchAgents'), defaultHome } = {}) {
  const label = helperLabel(home, defaultHome);
  const app = path.join(home, 'bin', APP_NAME);
  return {
    label, app, bundleId: label, name: helperName(label),
    exe: path.join(app, 'Contents/MacOS/rigs-control'),
    hashFile: path.join(app, 'Contents/Resources/source.sha256'),
    plist: path.join(launchAgents, `${label}.plist`),
    sock: path.join(home, 'run/control.sock'),
    token: path.join(home, 'run/control.token'),
    log: path.join(home, 'logs/control-helper.log'),
    state: path.join(home, 'control-helper.json'),
  };
}

/** Hash of the helper's sources: the same bytes in the same order as build.sh, which stores it (and the bundle id) in the bundle. */
export function sourceHash(dir = SOURCE_DIR) {
  const h = crypto.createHash('sha256');
  for (const f of SOURCE_FILES) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Pure: the LaunchAgent. Its own job in the Aqua session; restarted after a crash, not after a clean stop. */
export function launchAgentPlist({ label, exe, home, log }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(exe)}</string><string>--home</string><string>${xml(home)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>RIGS_HOME</key><string>${xml(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function readHelperState(home = RIGS_HOME) {
  try { return JSON.parse(fs.readFileSync(helperPaths(home).state, 'utf8')); } catch { return {}; }
}
function writeHelperState(home, state) {
  const file = helperPaths(home).state;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}

export function builtHash(p) {
  try { return fs.readFileSync(p.hashFile, 'utf8').trim(); } catch { return null; }
}
/** What build.sh stamps into a current build for these paths: the source hash and the bundle id. */
export const wantedHash = (p) => `${sourceHash()} ${p.bundleId}`;

/**
 * One request on a fresh authenticated connection (status, grant, install checks). The control adapter keeps
 * its own long-lived connection for actions.
 */
export function requestHelper(home, op, args = {}, { timeout = 5000, connect = net.createConnection } = {}) {
  const p = helperPaths(home);
  return new Promise((resolve, reject) => {
    let token;
    try { token = fs.readFileSync(p.token, 'utf8').trim(); } catch { reject(new ControlError('no-session', 'RIGS Control is not running (no token)')); return; }
    const socket = connect(p.sock);
    let buf = '';
    const done = (fn, v) => { clearTimeout(timer); socket.destroy(); fn(v); };
    const timer = setTimeout(() => done(reject, new ControlError('timeout', `RIGS Control did not answer ${op}`)), timeout);
    socket.on('error', (e) => done(reject, new ControlError('no-session', `RIGS Control is not reachable: ${e.message}`)));
    socket.on('connect', () => socket.write(JSON.stringify({ ...args, id: 1, op, token }) + '\n'));
    socket.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        let m;
        try { m = JSON.parse(buf.slice(0, i)); } catch { continue; }
        if (m.id !== 1) continue;
        if (m.ok) done(resolve, m.result);
        else done(reject, new ControlError(m.error?.code || 'error', m.error?.message || 'RIGS Control failed'));
        return;
      }
    });
  });
}

const launchctl = (runner, ...args) => runner('launchctl', args, { timeout: 15000 });

/**
 * Builds the app when its sources or bundle id changed, writes the LaunchAgent and (re)starts it, then waits until
 * it answers. Idempotent: with nothing changed it only makes sure the job is running. A new build has a new cdhash,
 * so any TCC entry under its bundle id (an older build's) no longer applies: `regrant` is recorded and the grant
 * flow resets that bundle id's entries first.
 */
export async function installMacHelper({ home = RIGS_HOME, runner = run, launchAgents, defaultHome, uid = process.getuid?.(), ready, wait = 8000 } = {}) {
  const p = helperPaths(home, { launchAgents, defaultHome });
  const want = wantedHash(p);
  const had = builtHash(p);
  let built = false;
  if (had !== want) {
    const r = await runner('bash', [path.join(SOURCE_DIR, 'build.sh'), p.app, p.bundleId, p.name], { timeout: 300000 });
    if (r.code === 2 || /swiftc not found/.test(r.stderr || '')) {
      throw new ControlError('unsupported', 'Building RIGS Control needs swiftc', { kind: 'command', text: 'Install the Xcode Command Line Tools: run `xcode-select --install` in a terminal on this Mac, then restart RIGS.' });
    }
    if (r.code !== 0) throw new ControlError('error', `Building RIGS Control failed: ${String(r.stderr || r.stdout || '').trim().slice(-600)}`);
    built = true;
    writeHelperState(home, { ...readHelperState(home), hash: want, builtAt: new Date().toISOString(), regrant: true });
  }
  const plist = launchAgentPlist({ label: p.label, exe: p.exe, home, log: p.log });
  let old = null;
  try { old = fs.readFileSync(p.plist, 'utf8'); } catch {}
  fs.mkdirSync(path.dirname(p.log), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  if (old !== plist) fs.writeFileSync(p.plist, plist, { mode: 0o644 });
  const domain = `gui/${uid}`, service = `${domain}/${p.label}`;
  const loaded = (await launchctl(runner, 'print', service)).code === 0;
  if (loaded && (built || old !== plist)) await launchctl(runner, 'bootout', service);
  if (!loaded || built || old !== plist) {
    // bootout returns before launchd has torn the job down; bootstrap then fails with EIO for a moment.
    let r;
    for (let i = 0; i < 10; i++) {
      r = await launchctl(runner, 'bootstrap', domain, p.plist);
      if (r.code === 0 || /already (loaded|bootstrapped)/i.test(r.stderr || '')) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (r.code !== 0 && !/already/i.test(r.stderr || '')) throw new ControlError('error', `launchctl bootstrap ${p.label} failed: ${String(r.stderr || r.stdout).trim()}`);
  } else {
    await launchctl(runner, 'kickstart', service);
  }
  ready ||= async () => {
    const until = Date.now() + wait;
    for (;;) {
      try { return await requestHelper(home, 'hello', {}, { timeout: 1500 }); } catch (e) {
        if (Date.now() > until) throw new ControlError('no-session', `RIGS Control did not start: ${e.message}; see ${p.log}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  await ready();
  return { label: p.label, app: p.app, plist: p.plist, built, regrant: !!readHelperState(home).regrant };
}

/** Stops the helper (kill switch, control off). Its grants stay with the app; the next setup starts it again. */
export async function stopMacHelper({ home = RIGS_HOME, runner = run, launchAgents, defaultHome, uid = process.getuid?.() } = {}) {
  const p = helperPaths(home, { launchAgents, defaultHome });
  if (!fs.existsSync(p.plist)) return { label: p.label, stopped: false };  // never installed for this home
  const r = await launchctl(runner, 'bootout', `gui/${uid}/${p.label}`);
  return { label: p.label, stopped: r.code === 0 };
}

/** Removes the LaunchAgent (the app and its grants stay, so a reinstall needs no new grant). */
export async function uninstallMacHelper({ home = RIGS_HOME, runner = run, launchAgents, defaultHome, uid = process.getuid?.() } = {}) {
  const p = helperPaths(home, { launchAgents, defaultHome });
  await stopMacHelper({ home, runner, launchAgents, defaultHome, uid });
  fs.rmSync(p.plist, { force: true });
  return { label: p.label, removed: p.plist };
}

/**
 * Before a grant after a build: TCC pinned any entry under this bundle id to an older cdhash, so it shows "on" but no
 * longer applies. Reset only this home's own entries, then the person switches the new build on.
 */
export async function resetStaleGrants({ home = RIGS_HOME, runner = run, defaultHome, grants = {} } = {}) {
  const st = readHelperState(home);
  if (!st.regrant) return { reset: false };
  const { bundleId } = helperPaths(home, { defaultHome });
  // A grant the running build already holds is not stale: never take it away (e.g. one switched on by hand).
  const services = [['ScreenCapture', grants.screen], ['Accessibility', grants.ax]].filter(([, ok]) => ok !== true).map(([s]) => s);
  for (const service of services) await runner('tccutil', ['reset', service, bundleId], { timeout: 10000 });
  writeHelperState(home, { ...st, regrant: false });
  return { reset: services.length > 0, services };
}
