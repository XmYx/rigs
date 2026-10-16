import fs from 'node:fs';
import path from 'node:path';
import { HOME, isMac, isWin, run } from './util.js';

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
  const value = {
    home, folders: list, blocked, fullDiskAccess, controlledFolderAccess,
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
