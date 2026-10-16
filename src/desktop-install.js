import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { bin } from './tools.js';
import { HOME, clearWhichCache, isMac, isWin, log, run } from './util.js';

/**
 * Installs the hardware-accelerated remote desktop stack on this machine, unattended where the OS
 * allows it: Sunshine (host: NVENC / VAAPI / QuickSync / VideoToolbox, KMS capture on Wayland) and
 * Moonlight (client). Everything comes from the projects' latest GitHub releases.
 *
 * Steps that need root (Linux .deb + setcap, Windows MSI) run directly when sudo needs no password;
 * otherwise they're written to ~/.rigs/desktop-finish.sh (.ps1) and the node reports "needs-sudo",
 * so JARVIS can open a terminal on that machine where you type the password once.
 */

const STATE = path.join(RIGS_HOME, 'desktop.json');
const DL = path.join(RIGS_HOME, 'downloads');
const APPS = path.join(HOME, '.local', 'share', 'rigs');
let busy = null;

async function readState() {
  try { return JSON.parse(await fsp.readFile(STATE, 'utf8')); } catch { return { state: 'idle', steps: [] }; }
}

async function writeState(s) {
  await fsp.mkdir(RIGS_HOME, { recursive: true });
  s.at = Date.now();
  await fsp.writeFile(STATE, JSON.stringify(s, null, 2));
  return s;
}

export async function status() {
  const s = await readState();
  return { ...s, sunshine: !!bin('sunshine'), moonlight: !!bin('moonlight') || fs.existsSync(path.join(HOME, '.local', 'bin', 'moonlight')) };
}

async function latestAssets(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'rigs-mesh' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${repo} releases: HTTP ${r.status}`);
  const j = await r.json();
  return { tag: j.tag_name, assets: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })) };
}

async function download(url, name) {
  await fsp.mkdir(DL, { recursive: true });
  const dest = path.join(DL, name);
  if (fs.existsSync(dest) && (await fsp.stat(dest)).size > 0) return dest;
  const r = await fetch(url, { headers: { 'user-agent': 'rigs-mesh' }, redirect: 'follow', signal: AbortSignal.timeout(20 * 60 * 1000) });
  if (!r.ok) throw new Error(`download ${name}: HTTP ${r.status}`);
  const tmp = dest + '.part';
  await fsp.writeFile(tmp, Buffer.from(await r.arrayBuffer()));
  await fsp.rename(tmp, dest);
  return dest;
}

function osRelease() {
  try {
    const t = fs.readFileSync('/etc/os-release', 'utf8');
    const get = (k) => (t.match(new RegExp(`^${k}="?([^"\\n]+)"?`, 'm')) || [])[1] || '';
    return { id: get('ID'), like: get('ID_LIKE'), version: get('VERSION_ID'), codename: get('VERSION_CODENAME') };
  } catch { return { id: '', like: '', version: '' }; }
}

async function sudoOk() {
  const r = await run('sudo', ['-n', 'true'], { timeout: 5000 });
  return r.code === 0;
}

/** Install the .app inside a dmg into /Applications (or ~/Applications when not writable). */
async function installDmg(dmg, appName) {
  const mount = path.join(DL, 'mnt-' + appName.replace(/\W/g, ''));
  await fsp.mkdir(mount, { recursive: true });
  const a = await run('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', mount, dmg], { timeout: 120000 });
  if (a.code !== 0) throw new Error('hdiutil attach failed: ' + a.stderr.trim());
  try {
    const app = (await fsp.readdir(mount)).find((n) => n.endsWith('.app'));
    if (!app) throw new Error(`no .app inside ${path.basename(dmg)}`);
    let target = '/Applications';
    try { await fsp.access(target, fs.constants.W_OK); } catch { target = path.join(HOME, 'Applications'); await fsp.mkdir(target, { recursive: true }); }
    const dest = path.join(target, app);
    await fsp.rm(dest, { recursive: true, force: true });
    const c = await run('ditto', [path.join(mount, app), dest], { timeout: 300000 });
    if (c.code !== 0) throw new Error('copy failed: ' + c.stderr.trim());
    await run('xattr', ['-dr', 'com.apple.quarantine', dest], { timeout: 30000 });
    return dest;
  } finally {
    await run('hdiutil', ['detach', '-quiet', mount], { timeout: 60000 });
  }
}

function credsCommand(sunshineBin) {
  const { sunshineUser, sunshinePass } = config().desktop;
  return [sunshineBin, '--creds', sunshineUser, sunshinePass];
}

// ---------------------------------------------------------------- per OS

async function mac(st) {
  if (!bin('moonlight')) {
    const { assets } = await latestAssets('moonlight-stream/moonlight-qt');
    const dmg = assets.find((a) => /\.dmg$/i.test(a.name) && !/steamlink/i.test(a.name));
    const dest = await installDmg(await download(dmg.url, dmg.name), 'moonlight');
    st.steps.push(`Moonlight → ${dest}`);
  } else st.steps.push('Moonlight already installed');
  if (!bin('sunshine')) {
    const { assets } = await latestAssets('LizardByte/Sunshine');
    const dmg = assets.find((a) => a.name === `Sunshine-macOS-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.dmg`);
    if (!dmg) throw new Error('no Sunshine macOS build for ' + process.arch);
    const dest = await installDmg(await download(dmg.url, dmg.name), 'sunshine');
    st.steps.push(`Sunshine → ${dest}`);
  } else st.steps.push('Sunshine already installed');
  clearWhichCache();
  const s = bin('sunshine');
  if (s) {
    await run(credsCommand(s)[0], credsCommand(s).slice(1), { timeout: 30000 });
    // Run it now and at every login via a LaunchAgent (no Automation permission prompt).
    const plist = path.join(HOME, 'Library', 'LaunchAgents', 'dev.rigs.sunshine.plist');
    await fsp.mkdir(path.dirname(plist), { recursive: true });
    await fsp.writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.rigs.sunshine</string>
  <key>ProgramArguments</key><array><string>${s}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${path.join(RIGS_HOME, 'logs', 'sunshine.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(RIGS_HOME, 'logs', 'sunshine.log')}</string>
</dict></plist>
`);
    const uid = process.getuid?.() ?? 501;
    await run('launchctl', ['bootout', `gui/${uid}/dev.rigs.sunshine`], { timeout: 10000 });
    const b = await run('launchctl', ['bootstrap', `gui/${uid}`, plist], { timeout: 10000 });
    st.steps.push(b.code === 0 ? 'Sunshine started (LaunchAgent dev.rigs.sunshine)' : 'Sunshine LaunchAgent failed: ' + b.stderr.trim());
    st.note = 'Grant Sunshine “Screen Recording” and “Accessibility” in System Settings → Privacy & Security (once). Mac↔Mac can also use Screen Sharing in High Performance mode.';
  }
  return 'done';
}

async function linux(st) {
  const os = osRelease();
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  // Moonlight: AppImage, no root needed.
  if (!bin('moonlight') && !fs.existsSync(path.join(HOME, '.local', 'bin', 'moonlight'))) {
    if (arch !== 'amd64') st.steps.push('Moonlight: no AppImage for arm64 — install from Flathub (com.moonlight_stream.Moonlight)');
    else {
      const { assets } = await latestAssets('moonlight-stream/moonlight-qt');
      const ai = assets.find((a) => /x86_64\.AppImage$/.test(a.name));
      const file = await download(ai.url, ai.name);
      await fsp.mkdir(APPS, { recursive: true });
      const target = path.join(APPS, 'Moonlight.AppImage');
      await fsp.copyFile(file, target);
      await fsp.chmod(target, 0o755);
      const wrapper = path.join(HOME, '.local', 'bin', 'moonlight');
      await fsp.mkdir(path.dirname(wrapper), { recursive: true });
      // Extract-and-run avoids needing libfuse2 on newer Ubuntu.
      await fsp.writeFile(wrapper, `#!/bin/sh\nAPPIMAGE_EXTRACT_AND_RUN=1 exec "${target}" "$@"\n`, { mode: 0o755 });
      const desktop = path.join(HOME, '.local', 'share', 'applications', 'moonlight-rigs.desktop');
      await fsp.mkdir(path.dirname(desktop), { recursive: true });
      await fsp.writeFile(desktop, `[Desktop Entry]\nName=Moonlight\nComment=Hardware-accelerated remote desktop (RIGS)\nExec=${wrapper}\nTerminal=false\nType=Application\nCategories=Network;RemoteAccess;\n`);
      st.steps.push(`Moonlight ${ai.name} → ${wrapper}`);
    }
  } else st.steps.push('Moonlight already installed');

  if (bin('sunshine')) {
    st.steps.push('Sunshine already installed');
    await afterSunshineLinux(st);
    return 'done';
  }
  if (!/ubuntu|debian/.test(`${os.id} ${os.like}`)) {
    st.steps.push(`Sunshine: ${os.id || 'this distro'} isn't automated yet — see github.com/LizardByte/Sunshine/releases (AppImage works everywhere)`);
    return 'unsupported';
  }
  const { assets } = await latestAssets('LizardByte/Sunshine');
  const want = os.id === 'debian' ? `+debian${os.codename}_${arch}.deb` : `+ubuntu${os.version}_${arch}.deb`;
  let deb = assets.find((a) => a.name.endsWith(want));
  if (!deb && os.id === 'ubuntu') {
    // Nearest older Ubuntu build if this exact release has none.
    const cands = assets.filter((a) => a.name.includes('+ubuntu') && a.name.endsWith(`_${arch}.deb`))
      .map((a) => ({ a, v: Number((a.name.match(/\+ubuntu([\d.]+)_/) || [])[1]) })).filter((x) => x.v <= Number(os.version)).sort((x, y) => y.v - x.v);
    deb = cands[0]?.a;
  }
  if (!deb) throw new Error(`no Sunshine .deb for ${os.id} ${os.version} ${arch}`);
  const file = await download(deb.url, deb.name);
  st.steps.push(`Sunshine ${deb.name} downloaded`);
  const { sunshineUser, sunshinePass } = config().desktop;
  const finish = path.join(RIGS_HOME, 'desktop-finish.sh');
  await fsp.writeFile(finish, `#!/bin/sh
# Finishes the Sunshine install for RIGS (written by the RIGS node; safe to re-run).
set -e
echo "Installing Sunshine (hardware-accelerated remote desktop host)…"
sudo apt-get install -y "${file}"
# KMS screen capture on Wayland/X11 without a portal prompt:
sudo setcap cap_sys_admin+p "$(readlink -f "$(command -v sunshine)")"
sudo udevadm control --reload-rules && sudo udevadm trigger || true
sunshine --creds '${sunshineUser}' '${sunshinePass}' >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now app-dev.lizardbyte.app.Sunshine 2>/dev/null || systemctl --user enable --now sunshine 2>/dev/null || true
echo "Sunshine is installed and running. RIGS pairs Moonlight with it automatically."
`, { mode: 0o700 });
  st.command = `sh ${finish}`;
  if (await sudoOk()) {
    const r = await run('sh', [finish], { timeout: 15 * 60 * 1000 });
    st.steps.push(r.code === 0 ? 'Sunshine installed (passwordless sudo)' : `finish script failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    clearWhichCache();
    if (r.code === 0) { st.command = ''; await afterSunshineLinux(st); return 'done'; }
    return 'failed';
  }
  st.steps.push('Root step pending: run the finish command once (sudo password)');
  return 'needs-sudo';
}

async function afterSunshineLinux(st) {
  const s = bin('sunshine');
  if (!s) return;
  const c = credsCommand(s);
  await run(c[0], c.slice(1), { timeout: 30000 });
  await run('systemctl', ['--user', 'enable', '--now', 'app-dev.lizardbyte.app.Sunshine'], { timeout: 20000 });
  st.steps.push('Sunshine credentials set and user service enabled');
}

async function windows(st) {
  const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
  if (!bin('moonlight')) {
    const { assets } = await latestAssets('moonlight-stream/moonlight-qt');
    const zip = assets.find((a) => /^MoonlightPortable-x64-.*\.zip$/i.test(a.name));
    const file = await download(zip.url, zip.name);
    const dest = path.join(local, 'RIGS', 'Moonlight');
    await fsp.mkdir(dest, { recursive: true });
    const r = await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${file}' -DestinationPath '${dest}'`], { timeout: 300000 });
    if (r.code !== 0) throw new Error('unzip Moonlight failed: ' + r.stderr.trim());
    st.steps.push(`Moonlight portable → ${dest}`);
  } else st.steps.push('Moonlight already installed');
  if (bin('sunshine')) { st.steps.push('Sunshine already installed'); return 'done'; }
  const finish = path.join(RIGS_HOME, 'desktop-finish.ps1');
  const { sunshineUser, sunshinePass } = config().desktop;
  await fsp.writeFile(finish, `# Finishes the Sunshine install for RIGS (needs an administrator).
winget install -e --id LizardByte.Sunshine --silent --accept-package-agreements --accept-source-agreements
& "C:\\Program Files\\Sunshine\\sunshine.exe" --creds '${sunshineUser}' '${sunshinePass}'
New-NetFirewallRule -DisplayName 'RIGS Sunshine (tailnet)' -Direction Inbound -Protocol TCP -LocalPort 47984,47989,47990,48010 -RemoteAddress 100.64.0.0/10 -Action Allow -ErrorAction SilentlyContinue | Out-Null
New-NetFirewallRule -DisplayName 'RIGS Sunshine UDP (tailnet)' -Direction Inbound -Protocol UDP -LocalPort 47998-48000,48002,48010 -RemoteAddress 100.64.0.0/10 -Action Allow -ErrorAction SilentlyContinue | Out-Null
`);
  st.command = `Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -File "${finish}"'`;
  st.steps.push('Sunshine needs administrator approval: run the finish command on that PC (UAC prompt)');
  return 'needs-sudo';
}

/** Install whatever is missing. Safe to call repeatedly; runs at most once at a time. */
export function ensure({ force = false } = {}) {
  if (busy) return busy;
  busy = (async () => {
    const prev = await readState();
    if (!force && prev.state === 'done' && bin('sunshine') && (bin('moonlight') || fs.existsSync(path.join(HOME, '.local', 'bin', 'moonlight')))) return prev;
    const st = await writeState({ state: 'installing', steps: [], command: '', note: '' });
    try {
      st.state = isMac ? await mac(st) : isWin ? await windows(st) : await linux(st);
    } catch (e) {
      st.state = 'failed';
      st.steps.push('error: ' + e.message);
    }
    log(`desktop install: ${st.state} — ${st.steps.join('; ')}`);
    return writeState(st);
  })().finally(() => { busy = null; });
  return busy;
}
