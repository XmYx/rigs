import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { guiEnv, refreshSessionEnv } from './desktop.js';
import * as rootsteps from './rootsteps.js';
import { RIGS_HOME } from './config.js';
import { APP_NAME, helperPaths, installMacHelper, readHelperState, requestHelper, resetStaleGrants } from './control-mac-helper.js';
import { HOME, isLinux, isMac, isWin, run, which } from './util.js';

/**
 * Can RIGS (and every agent it launches — they inherit its OS permissions) read and write the
 * user's home? Probed from inside the service, so it reflects what agents will actually get:
 *   macOS: privacy controls (TCC) on Documents/Desktop/Downloads/iCloud Drive; Full Disk Access
 *          for Mail, Safari, Messages and other protected app data
 *   Windows: Defender "Controlled folder access" can block writes to Documents/Desktop/Pictures
 *   Linux: plain Unix permissions
 */

function probe(dir) {
  if (!fs.existsSync(dir)) return null;
  let read = false;
  let write = false;
  try { fs.readdirSync(dir); read = true; } catch {}
  const f = path.join(dir, `.rigs-access-${process.pid}-${Date.now()}`);
  try { fs.writeFileSync(f, 'x'); fs.unlinkSync(f); write = true; } catch {}
  return { path: dir, read, write };
}

function folders() {
  const base = ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Music', 'Movies', 'Videos'].map((d) => path.join(HOME, d));
  if (isMac) base.push(path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  return base;
}

let cache = { at: 0, value: null };

export async function status(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 5 * 60 * 1000) return cache.value;
  const home = probe(HOME);
  const list = folders().map(probe).filter(Boolean);
  let fullDiskAccess = null;
  if (isMac) {
    // Safari/Mail data are only readable with Full Disk Access.
    const fda = [path.join(HOME, 'Library', 'Safari'), path.join(HOME, 'Library', 'Mail')].find((p) => fs.existsSync(p));
    if (fda) { try { fs.readdirSync(fda); fullDiskAccess = true; } catch { fullDiskAccess = false; } }
  }
  let controlledFolderAccess = null;
  if (isWin) {
    const r = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-MpPreference).EnableControlledFolderAccess'], { timeout: 15000 });
    controlledFolderAccess = r.stdout.trim() === '1';
  }
  const blocked = list.filter((x) => !x.write).map((x) => x.path);
  const control = await controlPermissions(fullDiskAccess);
  const value = {
    home, folders: list, blocked, fullDiskAccess, controlledFolderAccess,
    ...control,
    runtime: process.execPath,
    ok: !!home?.write && blocked.length === 0,
  };
  cache = { at: Date.now(), value };
  return value;
}

/** macOS: open Full Disk Access settings and reveal the binary to add (drag it into the list). */
export async function grantFullDiskAccess() {
  if (!isMac) return { ok: false, message: 'Full Disk Access is a macOS setting' };
  await run('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], { timeout: 10000 });
  await run('open', ['-R', process.execPath], { timeout: 10000 });
  return { ok: true, binary: process.execPath, message: `Add ${process.execPath} (shown in Finder) to Full Disk Access, then restart RIGS.` };
}

// ---------------------------------------------------------------- screen, input and accessibility
//
// What an agent needs to see and drive the desktop (docs/full-access.md §8). Each permission is
// { ok: true | false | null (cannot tell), via, detail?, fix? }; `fix` says how to get it:
//   { kind: 'rootstep' | 'settings' | 'consent' | 'relogin', text, id?, url?, permission? }
// The probes are thin shell-outs; parsing and decisions are pure so they are unit-tested with fixtures.

const SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_';
export const MAC_PANES = {
  screenCapture: `${SETTINGS}ScreenCapture`,
  accessibility: `${SETTINGS}Accessibility`,
  fullDiskAccess: `${SETTINGS}AllFiles`,
  automation: `${SETTINGS}Automation`,
};
const MAC_LABEL = { screenCapture: 'Screen Recording', accessibility: 'Accessibility', fullDiskAccess: 'Full Disk Access', automation: 'Automation' };

/** Names owned on the bus, from `busctl --user list` (cheap: it never calls into the compositor). */
export function parseBusNames(out) {
  const names = new Set();
  for (const l of String(out || '').split('\n')) {
    const n = l.trim().split(/\s+/)[0];
    if (/^[A-Za-z_][\w-]*(\.[\w-]+)+$/.test(n)) names.add(n);
  }
  return names;
}

/** `busctl get-property` prints `u 2` or `i 1`; returns the number or null. */
export function parseBusNumber(out) {
  const m = String(out || '').trim().match(/^[a-z]\s+(-?\d+)$/);
  return m ? Number(m[1]) : null;
}

const flag = (v) => (v === '1' ? true : v === '0' ? false : null);

/** macOS probe output: `key=value` lines from the swift script, or a bare `true`/`false` from the JXA fallback. */
export function parseMacProbe(out) {
  const kv = {};
  for (const l of String(out || '').split('\n')) {
    const m = l.trim().match(/^(ax|screen|post|automation)=(-?\d+)$/);
    if (m) kv[m[1]] = m[2];
  }
  const bare = String(out || '').trim();
  const ax = kv.ax != null ? flag(kv.ax) : bare === 'true' ? true : bare === 'false' ? false : null;
  // AEDeterminePermissionToAutomateTarget: 0 granted, -1743 denied, -1744 would prompt, -600 target not running.
  const a = kv.automation == null ? null : Number(kv.automation);
  return {
    ax,
    screen: flag(kv.screen),
    post: flag(kv.post),
    automation: a === 0 ? true : a === -1743 ? false : null,
    automationAsks: a === -1744,
  };
}

const macFix = (permission) => ({
  kind: 'settings', permission, url: MAC_PANES[permission],
  text: `Open System Settings > Privacy & Security > ${MAC_LABEL[permission]} and switch on ${path.basename(process.execPath)} (the RIGS daemon), then restart RIGS.`,
});

/** macOS: the probe result plus Full Disk Access → the permissions. Pure. */
export function decideMac({ probe, fullDiskAccess }) {
  const one = (key, ok, via) => ({ ok, via, ...(ok === true ? {} : { fix: macFix(key) }) });
  // Synthetic input needs Accessibility (and the post-event right that comes with it).
  const input = probe.ax === null && probe.post === null ? null : probe.ax !== false && probe.post !== false;
  return {
    screenCapture: one('screenCapture', probe.screen, 'CGPreflightScreenCaptureAccess'),
    input: { ...one('accessibility', input, 'CGEventPost'), requires: 'accessibility' },
    accessibility: one('accessibility', probe.ax, 'AXIsProcessTrusted'),
    fullDiskAccessPermission: one('fullDiskAccess', fullDiskAccess, 'readdir ~/Library/Safari'),
    automation: { ...one('automation', probe.automation, 'AEDeterminePermissionToAutomateTarget'), ...(probe.automationAsks ? { detail: 'macOS asks on first use' } : {}) },
  };
}

const helperFix = (permission, { app, regrant }) => ({
  kind: 'settings', permission, url: MAC_PANES[permission], app,
  text: `Open System Settings > Privacy & Security > ${MAC_LABEL[permission]} and switch on RIGS Control${regrant ? ' (it was updated: click Grant so the old entry is reset, then switch it on again)' : ''}. Grant it to RIGS Control, not to node: the helper holds these rights so agents cannot bypass the control gate.`,
});

/**
 * macOS: what the RIGS Control helper itself may do (its own TCC grants, docs/full-access.md §8). Pure.
 * Not running → every control permission is missing with the fix to start it. A grant the helper did not report
 * (an older helper) is unknown (null), never assumed.
 */
export function decideMacHelper({ running = false, grants, app = '', regrant = false, error } = {}) {
  if (!running) {
    const fix = { kind: 'helper', app, text: `RIGS Control (the macOS helper that holds the screen and input rights) is not running${error ? ` (${error})` : ''}. Click Grant (JARVIS → Access & control) or run \`rigs control helper install\` on this Mac.` };
    return {
      screenCapture: { ok: false, via: 'RIGS Control', fix },
      input: { ok: false, via: 'RIGS Control', requires: 'accessibility', fix },
      accessibility: { ok: false, via: 'RIGS Control', fix },
    };
  }
  const g = grants || {};
  const flag = (v) => (typeof v === 'boolean' ? v : null);
  const one = (key, ok, via) => ({ ok, via: `RIGS Control · ${via}`, ...(ok === true ? {} : { fix: helperFix(key, { app, regrant }) }) });
  const ax = flag(g.ax), post = flag(g.post);
  const input = ax === false || post === false ? false : ax === null || post === null ? null : true;
  return {
    screenCapture: one('screenCapture', flag(g.screen), 'CGPreflightScreenCaptureAccess'),
    input: { ...one('accessibility', input, 'CGEventPost'), requires: 'accessibility' },
    accessibility: one('accessibility', ax, 'AXIsProcessTrusted'),
  };
}

/** The daemon's own node must not hold screen/input rights: every agent it starts would inherit them. Pure. */
export function nodeGrantWarning(probe) {
  const held = [probe?.screen === true && 'Screen Recording', probe?.ax === true && 'Accessibility'].filter(Boolean);
  if (!held.length) return null;
  return { held, text: `${path.basename(process.execPath)} (the RIGS daemon) has ${held.join(' and ')}: every agent it starts can bypass the control gate. Remove it from ${held.join(' and ')} in System Settings > Privacy & Security; RIGS Control holds these rights.` };
}

async function probeMacHelper() {
  const p = helperPaths(RIGS_HOME);
  const regrant = !!readHelperState(RIGS_HOME).regrant;
  try {
    const r = await requestHelper(RIGS_HOME, 'probe', {}, { timeout: 8000 });
    return { running: true, grants: r.grants, app: r.helper?.path || p.app, regrant };
  } catch (e) {
    return { running: false, app: p.app, regrant, error: fs.existsSync(p.app) ? e.message : 'not installed' };
  }
}

/** Linux: facts about the session → the permissions. Pure. */
export function decideLinux(f) {
  if (!f.session) {
    const fix = { kind: 'relogin', text: 'No graphical session is reachable: log in on the desktop of this machine (the daemon needs the session bus).' };
    return { screenCapture: { ok: null, via: null, fix }, input: { ok: null, via: null, fix }, accessibility: { ok: null, via: null, fix } };
  }
  const names = f.busNames || new Set();
  const wayland = f.sessionType === 'wayland';
  const mutter = names.has('org.gnome.Mutter.ScreenCast') && names.has('org.gnome.Mutter.RemoteDesktop');
  const portalSc = (f.portalScreenCast ?? 0) >= 1;
  const portalRd = (f.portalRemoteDesktop ?? 0) >= 1;
  const tool = (n) => !!f.tools?.[n];
  const consent = 'The first request shows a permission dialog at the machine; approve it once.';
  const install = (pkgs, text) => ({ kind: 'rootstep', id: 'apt', text: `${text}: sudo apt-get install -y ${pkgs}` });

  let screenCapture;
  let input;
  if (wayland) {
    if (mutter) screenCapture = { ok: true, via: 'mutter' };
    else if (tool('grim')) screenCapture = { ok: true, via: 'grim' };
    else if (portalSc) screenCapture = { ok: null, via: 'portal', detail: consent, fix: { kind: 'consent', text: consent } };
    else screenCapture = { ok: false, via: null, fix: install('grim', 'Install a Wayland screenshot tool') };

    if (mutter) input = { ok: true, via: 'mutter' };
    else if (f.uinputWritable) input = { ok: true, via: 'uinput' };
    else if (tool('ydotoold') && f.ydotoolSocket) input = { ok: true, via: 'ydotool' };
    else if (portalRd) input = { ok: null, via: 'portal', detail: consent, fix: { kind: 'consent', text: consent } };
    else input = { ok: false, via: null, fix: { kind: 'rootstep', id: 'uinput', permission: 'input', text: 'Let the logged-in user write /dev/uinput (one udev rule, one password).' } };
  } else {
    const shot = ['import', 'scrot', 'maim', 'gnome-screenshot', 'ffmpeg'].find(tool);
    screenCapture = shot ? { ok: true, via: shot } : { ok: false, via: null, fix: install('scrot', 'Install a screenshot tool') };
    if (tool('xdotool')) input = { ok: true, via: 'xdotool' };
    else if (f.uinputWritable) input = { ok: true, via: 'uinput' };
    else input = { ok: false, via: null, fix: install('xdotool', 'Install xdotool') };
  }

  let accessibility;
  if (names.has('dev.rigs.Control')) accessibility = { ok: true, via: 'gnome-extension' };
  else if (f.atspi && names.has('org.a11y.Bus')) {
    accessibility = { ok: true, via: 'at-spi', ...(wayland ? { partial: true, detail: 'AT-SPI misses some apps (Firefox, Unity); no window list without the RIGS Shell extension' } : {}) };
  } else if (!wayland && tool('wmctrl')) accessibility = { ok: true, via: 'wmctrl' };
  else accessibility = { ok: false, via: null, fix: install('python3-gi gir1.2-atspi-2.0 at-spi2-core', 'Install the accessibility bindings') };
  return { screenCapture, input, accessibility };
}

const MAC_SWIFT = `import ApplicationServices
import CoreServices
import CoreGraphics
print("ax=\\(AXIsProcessTrusted() ? 1 : 0)")
print("screen=\\(CGPreflightScreenCaptureAccess() ? 1 : 0)")
print("post=\\(CGPreflightPostEventAccess() ? 1 : 0)")
var addr = AEAddressDesc()
let bid = "com.apple.systemevents"
AECreateDesc(DescType(typeApplicationBundleID), bid, bid.utf8.count, &addr)
print("automation=\\(AEDeterminePermissionToAutomateTarget(&addr, AEEventClass(typeWildCard), AEEventID(typeWildCard), false))")
`;

async function probeMac() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-tcc-'));
  try {
    const file = path.join(dir, 'probe.swift');
    fs.writeFileSync(file, MAC_SWIFT);
    const p = parseMacProbe((await run('swift', [file], { timeout: 60000 })).stdout);
    if (p.ax !== null) return p;
  } catch {} finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // No Swift toolchain (or it failed): JXA still answers Accessibility.
  const j = await run('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()"], { timeout: 15000 });
  return parseMacProbe(j.stdout);
}

async function portalVersion(env, iface) {
  const r = await run('busctl', ['--user', '--timeout=3', 'get-property', 'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', iface, 'version'], { timeout: 6000, env });
  return parseBusNumber(r.stdout);
}

async function probeLinux() {
  await refreshSessionEnv();
  const env = guiEnv();
  const sock = (env.DBUS_SESSION_BUS_ADDRESS || '').replace(/^unix:path=/, '').split(',')[0];
  if (!sock || !fs.existsSync(sock)) return { session: false };
  const list = await run('busctl', ['--user', '--no-pager', '--timeout=3', 'list'], { timeout: 6000, env });
  const busNames = parseBusNames(list.stdout);
  const [portalRemoteDesktop, portalScreenCast] = busNames.has('org.freedesktop.portal.Desktop')
    ? await Promise.all([portalVersion(env, 'org.freedesktop.portal.RemoteDesktop'), portalVersion(env, 'org.freedesktop.portal.ScreenCast')])
    : [null, null];
  let uinputWritable = false;
  try { fs.accessSync('/dev/uinput', fs.constants.W_OK); uinputWritable = true; } catch {}
  const uid = os.userInfo().uid;
  const ydotoolSocket = [env.YDOTOOL_SOCKET, `/run/user/${uid}/.ydotool_socket`, '/tmp/.ydotool_socket'].some((p) => p && fs.existsSync(p));
  const tools = Object.fromEntries(['grim', 'ydotoold', 'xdotool', 'wmctrl', 'import', 'scrot', 'maim', 'gnome-screenshot', 'ffmpeg'].map((n) => [n, !!which(n)]));
  const py = await run('python3', ['-c', "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi"], { timeout: 8000, env });
  return {
    session: true,
    sessionType: env.XDG_SESSION_TYPE || (env.WAYLAND_DISPLAY ? 'wayland' : env.DISPLAY ? 'x11' : ''),
    busNames, portalRemoteDesktop, portalScreenCast, uinputWritable, ydotoolSocket, tools, atspi: py.code === 0,
  };
}

async function controlPermissions(fullDiskAccess) {
  try {
    if (isMac) {
      // Screen and input belong to the RIGS Control helper; node is probed only for FDA, Automation and the bypass warning.
      const [helper, node] = await Promise.all([probeMacHelper(), probeMac().catch(() => null)]);
      const own = decideMac({ probe: node || parseMacProbe(''), fullDiskAccess });
      const warning = nodeGrantWarning(node);
      return {
        ...decideMacHelper(helper),
        automation: own.automation,
        fullDiskAccessFix: own.fullDiskAccessPermission.fix,
        helper: { running: helper.running, app: helper.app, ...(helper.regrant ? { regrant: true } : {}) },
        ...(warning ? { nodeGrants: warning } : {}),
      };
    }
    if (isLinux) return decideLinux(await probeLinux());
  } catch (e) {
    return { controlError: String(e.message || e) };
  }
  // Windows: SendInput and screen capture need no grant in a normal desktop session.
  return { screenCapture: { ok: null, via: 'gdi' }, input: { ok: null, via: 'SendInput' }, accessibility: { ok: null, via: 'uia' } };
}

/**
 * Guided grant. macOS opens the matching System Settings pane (a person must flip the switch: TCC
 * ignores synthetic clicks); Linux queues the uinput udev rule as a root step (one password).
 */
export async function grant(permission) {
  cache = { at: 0, value: null };
  if (isMac) {
    const key = permission === 'input' ? 'accessibility' : permission;
    if (key === 'fullDiskAccess') return grantFullDiskAccess();
    if (!MAC_PANES[key]) return { ok: false, message: `Unknown permission "${permission}"` };
    if (key === 'automation') {
      await run('open', [MAC_PANES[key]], { timeout: 10000 });
      return { ok: true, pane: MAC_PANES[key], message: 'Automation is only used by the opt-in mac-jxa fallback; RIGS Control does not need it.' };
    }
    // Screen Recording and Accessibility go to RIGS Control: make sure it runs, then let it ask (adds it to the list).
    const installed = await installMacHelper();
    const reset = await resetStaleGrants();
    let asked = null;
    try { asked = await requestHelper(RIGS_HOME, 'grant', { permission: key }, { timeout: 15000 }); } catch {}
    await run('open', [MAC_PANES[key]], { timeout: 10000 });
    await run('open', ['-R', installed.app], { timeout: 10000 });
    return {
      ok: true, pane: MAC_PANES[key], app: installed.app, granted: asked?.granted ?? null, reset: reset.reset,
      message: `In ${MAC_LABEL[key]}, switch on RIGS Control (${APP_NAME} is shown in Finder; drag it into the list if missing). It applies at once; no restart needed.`,
    };
  }
  if (isLinux && (permission === 'input' || permission === 'uinput')) {
    const r = await rootsteps.ensureUinput();
    return { ok: true, ...r, steps: rootsteps.pending(), message: r.uinput ? '/dev/uinput is already writable.' : 'Queued the uinput rule: run the pending root step ("Finish setup") on this machine.' };
  }
  return { ok: false, message: `Nothing to grant for "${permission}" on this OS; see the fix hint in the access status.` };
}
