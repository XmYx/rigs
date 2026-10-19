import fs from 'node:fs';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { bin } from './tools.js';
import { stripManaged } from './merge.js';
import { APP_DIR, log, readJsonSync, run, writeJsonAtomic } from './util.js';

/**
 * Self-update. Every node is a git checkout of the public repo. Any agent on any node can change
 * the code, push to GitHub, and broadcast `update` — every node fast-forwards, reinstalls if the
 * lockfile moved, rebuilds the UI and restarts (exit code 75 → supervisor restart).
 * A node with local uncommitted edits never auto-updates (someone is working there).
 */

export const RESTART_CODE = 75;

/** Files the running daemon never loads: an update touching only these does not restart it (and the mesh). */
export function needsRestart(changed) {
  return changed.filter(Boolean).some((f) => !/^(docs|test|\.github)\//.test(f) && !/\.md$/i.test(f));
}
const STATE = path.join(RIGS_HOME, 'update.json');
let lastCheck = { at: 0, behind: 0, error: null };
let busy = false;

function git(args, timeout = 60000) {
  return run(bin('git') || 'git', args, { cwd: APP_DIR, timeout });
}

export function isCheckout() {
  return fs.existsSync(path.join(APP_DIR, '.git'));
}

/**
 * An OpenRig seat started in this folder writes its managed blocks into CLAUDE.md / AGENTS.md. That is not anyone's
 * work, but it makes the install look edited and would stop this machine from ever updating: take them back out.
 */
export function cleanInjectedGuides(dir = APP_DIR) {
  const cleaned = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(dir, f);
    try {
      const text = fs.readFileSync(p, 'utf8');
      const clean = stripManaged(text);
      if (clean !== text) { fs.writeFileSync(p, clean); cleaned.push(f); }
    } catch {}
  }
  if (cleaned.length) log(`updater: removed OpenRig managed blocks from ${cleaned.join(', ')} in the install`);
  return cleaned;
}

export async function version() {
  if (!isCheckout()) return { sha: 'dev', short: 'dev', branch: '', dirty: false };
  cleanInjectedGuides();
  const [sha, branch, dirty, subject] = await Promise.all([
    git(['rev-parse', 'HEAD'], 5000), git(['rev-parse', '--abbrev-ref', 'HEAD'], 5000), git(['status', '--porcelain', '--untracked-files=no'], 8000), git(['log', '-1', '--format=%s|%ct'], 5000),
  ]);
  const [msg, ct] = subject.stdout.trim().split('|');
  return { sha: sha.stdout.trim(), short: sha.stdout.trim().slice(0, 7), branch: branch.stdout.trim(), dirty: !!dirty.stdout.trim(), subject: msg, committedAt: Number(ct) * 1000 };
}

export async function check() {
  if (!isCheckout()) return { ...lastCheck, error: 'not a git checkout' };
  const { remote, branch } = config().update;
  const f = await git(['fetch', '--quiet', remote, branch], 60000);
  if (f.code !== 0) { lastCheck = { at: Date.now(), behind: 0, error: f.stderr.trim().slice(0, 200) }; return lastCheck; }
  const c = await git(['rev-list', '--count', `HEAD..${remote}/${branch}`], 5000);
  const a = await git(['rev-list', '--count', `${remote}/${branch}..HEAD`], 5000);
  const remoteUrl = (await git(['remote', 'get-url', remote], 5000)).stdout.trim();
  lastCheck = { at: Date.now(), behind: Number(c.stdout.trim()) || 0, ahead: Number(a.stdout.trim()) || 0, error: null, remote: remoteUrl };
  return lastCheck;
}

export function lastCheckResult() { return lastCheck; }

async function npm(args, timeout = 600000) {
  const npmBin = bin('npm') || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return run(npmBin, args, { cwd: APP_DIR, timeout });
}

/**
 * Pull + install + build. Resolves with { updated, restart } — the caller exits with RESTART_CODE
 * after responding so the supervisor brings up the new version.
 */
export async function apply({ force = false } = {}) {
  if (busy) return { updated: false, message: 'update already running' };
  if (!isCheckout()) return { updated: false, message: 'not a git checkout' };
  busy = true;
  try {
    const before = await version();
    if (before.dirty && !force) return { updated: false, message: 'local uncommitted changes — commit/push them (or force)' };
    const { remote, branch } = config().update;
    const st = await check();
    if (st.error) return { updated: false, message: st.error };
    if (!st.behind) return { updated: false, message: 'already up to date', version: before.short };
    // A version that crash-looped here (and was rolled back) is not re-applied until main moves on.
    const target = (await git(['rev-parse', `${remote}/${branch}`], 5000)).stdout.trim();
    const bad = readJsonSync(STATE, {})?.bad;
    if (!force && bad && bad === target) return { updated: false, message: `${target.slice(0, 7)} crash-looped on this machine before — waiting for a newer commit on main` };
    const changed = (await git(['diff', '--name-only', `HEAD..${remote}/${branch}`])).stdout.split('\n');
    const pull = await git(['merge', '--ff-only', `${remote}/${branch}`]);
    if (pull.code !== 0) return { updated: false, message: 'cannot fast-forward: ' + pull.stderr.trim().slice(0, 200) };
    if (changed.some((f) => f === 'package.json' || f === 'package-lock.json')) {
      const i = await npm(['install', '--no-audit', '--no-fund']);
      if (i.code !== 0) {
        await git(['reset', '--hard', before.sha]);
        return { updated: false, message: 'npm install failed, rolled back: ' + i.stderr.slice(-300) };
      }
    } else if (changed.some((f) => f.startsWith('ui/'))) {
      await npm(['run', 'build']);
    }
    const after = await version();
    await writeJsonAtomic(STATE, { previous: before.sha, current: after.sha, at: Date.now() });
    const restart = needsRestart(changed);
    log(`updated ${before.short} → ${after.short}${restart ? '' : ' (docs/tests only — no restart)'}`);
    return { updated: true, restart, from: before.short, to: after.short };
  } finally {
    busy = false;
  }
}

/** Rollback target if the new version crash-loops (used by the supervisor). */
export function previousSha() {
  return readJsonSync(STATE, {})?.previous || null;
}

/** Remember a version that crash-looped so auto-update doesn't re-apply it. */
export async function markBad(sha) {
  const s = readJsonSync(STATE, {}) || {};
  await writeJsonAtomic(STATE, { ...s, bad: sha, badAt: Date.now() });
}

/**
 * Make sure dependencies load before starting the server: a missing/broken node_modules (deleted,
 * or replaced by a dangling symlink) is reinstalled instead of crash-looping into a rollback.
 */
export async function ensureDependencies() {
  const nm = path.join(APP_DIR, 'node_modules');
  let ok = false;
  try {
    const st = fs.lstatSync(nm);
    ok = st.isDirectory() && fs.existsSync(path.join(nm, 'ws', 'package.json'));
    if (st.isSymbolicLink()) fs.unlinkSync(nm);
  } catch {}
  if (ok) return { ok: true };
  log('dependencies missing or broken — running npm install');
  const r = await npm(['install', '--no-audit', '--no-fund']);
  return { ok: r.code === 0, healed: true, error: r.code === 0 ? null : r.stderr.slice(-300) };
}

export function startAutoUpdate(onUpdated) {
  const tick = async () => {
    const u = config().update;
    if (!u.auto) return;
    const r = await apply().catch((e) => ({ updated: false, message: e.message }));
    if (r.updated) onUpdated(r);
  };
  const ms = Math.max(2, config().update.intervalMin || 10) * 60 * 1000;
  setTimeout(tick, 60 * 1000).unref?.();
  setInterval(tick, ms).unref?.();
}
