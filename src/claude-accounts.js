// Several Claude accounts on one machine (rig), and which one a new Claude run uses.
//
// Each extra account is its own Claude Code config folder (CLAUDE_CONFIG_DIR), logged in once by Sir:
// `rigs claude add <id>` creates ~/.rigs/claude-accounts/<id> and prints the login command. The machine's normal
// ~/.claude is always the account "default". config.claude = { accounts: [{ id, label, dir }], mode, limits }:
//  - mode 'auto' (default): every new Claude run (a JARVIS fast-path or YOLO turn, a planning call, a directly started
//    task agent) goes to the account with the most room — under both the 5-hour and the weekly threshold
//    (limits.session, default 90 %; limits.week, default 95 %), the lowest weekly use first, then the lowest 5-hour use.
//    When every account is over, the one whose 5-hour window resets first. Usage is Claude Code's own get_usage per
//    account (usage.js), cached for a few minutes.
//  - mode '<id>': always that account.
// A Claude session lives in the config folder of the account that started it, so a resumed session (the JARVIS
// thread) stays on its account until that account is over its limits; then the thread starts a fresh session on
// another account from its summary (chat.js). OpenRig seats run under the OpenRig daemon's own login.
// `pickAccount` is pure; tests in test/claude-accounts.test.js.
import fs from 'node:fs';
import path from 'node:path';
import { config, loadConfig, saveConfig, RIGS_HOME } from './config.js';
import { HOME, expandHome } from './util.js';

export const DEFAULT_ID = 'default';
export const DEFAULT_LIMITS = Object.freeze({ session: 90, week: 95 });
export const ACCOUNTS_DIR = path.join(RIGS_HOME, 'claude-accounts');
const TTL = 180000;

const cfg = (c = config()) => c.claude || {};
const validId = (id) => /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(String(id || ''));

/** Every account of this machine, the default first: [{ id, label, dir }] (dir '' = ~/.claude). */
export function accounts(c = config()) {
  const extra = (cfg(c).accounts || []).filter((a) => a && validId(a.id) && a.id !== DEFAULT_ID && a.dir)
    .map((a) => ({ id: a.id, label: a.label || a.id, dir: path.resolve(expandHome(a.dir)) }));
  return [{ id: DEFAULT_ID, label: cfg(c).defaultLabel || 'Default (~/.claude)', dir: '' }, ...extra];
}

export const settings = (c = config()) => ({ mode: cfg(c).mode || 'auto', limits: { ...DEFAULT_LIMITS, ...(cfg(c).limits || {}) } });

/** The environment a Claude process needs to run as this account. */
export const accountEnv = (a) => (a?.dir ? { CLAUDE_CONFIG_DIR: a.dir } : {});

/** The Claude projects folders of every account (where session transcripts live). */
export function projectDirs(c = config()) {
  return accounts(c).map((a) => path.join(a.dir || path.join(HOME, '.claude'), 'projects'));
}

/** The account whose config folder holds this transcript file (…/<configDir>/projects/<project>/<id>.jsonl). */
export function accountOfFile(file, c = config()) {
  const conf = path.dirname(path.dirname(path.dirname(file)));
  return accounts(c).find((a) => a.dir && path.resolve(a.dir) === path.resolve(conf)) || accounts(c)[0];
}

const over = (l, limits) => !!l && ((l.session?.pct ?? 0) >= limits.session || (l.week?.pct ?? 0) >= limits.week);
const resetMs = (w) => (w?.resetsAt ? Date.parse(w.resetsAt) || Infinity : Infinity);

/**
 * Which account a new run uses. `limits` = { [id]: { session: { pct, resetsAt }, week: { pct, resetsAt }, error } }.
 * An account whose usage could not be read (not logged in, offline) is only used when nothing else can be. Pure.
 * → { account, why }.
 */
export function pickAccount(list, limits = {}, { mode = 'auto', thresholds = DEFAULT_LIMITS, prefer = '' } = {}) {
  if (!list?.length) return { account: null, why: 'no account' };
  if (mode !== 'auto') {
    const fixed = list.find((a) => a.id === mode);
    if (fixed) return { account: fixed, why: `fixed to ${fixed.id}` };
  }
  if (list.length === 1) return { account: list[0], why: 'only account' };
  const known = list.filter((a) => limits[a.id] && !limits[a.id].error && (limits[a.id].session || limits[a.id].week));
  const free = known.filter((a) => !over(limits[a.id], thresholds));
  const pinned = prefer && free.find((a) => a.id === prefer);
  if (pinned) return { account: pinned, why: `${pinned.id} still has room` };
  if (free.length) {
    const pct = (a, k) => limits[a.id][k]?.pct ?? 0;
    const best = [...free].sort((a, b) => pct(a, 'week') - pct(b, 'week') || pct(a, 'session') - pct(b, 'session'))[0];
    return { account: best, why: `${best.id}: ${Math.round(pct(best, 'session'))} % of 5 h, ${Math.round(pct(best, 'week'))} % of the week` };
  }
  if (known.length) {
    const soonest = [...known].sort((a, b) => resetMs(limits[a.id].session) - resetMs(limits[b.id].session))[0];
    return { account: soonest, why: `every account is over its limits; ${soonest.id} resets first` };
  }
  const fallback = list.find((a) => a.id === prefer) || list[0];
  return { account: fallback, why: 'no usage known yet' };
}

// ---------------------------------------------------------------- live usage per account (cached)
const cache = new Map(); // id → { at, data, pending }

/** Usage of one account: usage.planLimits-shaped, { error } when it cannot be read. */
export async function limitsFor(a, { force = false, read } = {}) {
  const hit = cache.get(a.id);
  if (!force && hit?.data && Date.now() - hit.at < TTL) return hit.data;
  if (hit?.pending) return hit.pending;
  const reader = read || (async (acc) => {
    const usage = await import('./usage.js');
    return usage.parseUsage(await usage.runGetUsage({ env: accountEnv(acc) }));
  });
  const pending = reader(a).then((data) => data, (e) => ({ session: null, week: null, error: e.message }))
    .then((data) => { cache.set(a.id, { at: Date.now(), data }); return data; });
  cache.set(a.id, { ...(hit || {}), pending });
  return pending;
}

export async function allLimits(opts = {}) {
  const list = accounts();
  const out = {};
  await Promise.all(list.map(async (a) => { out[a.id] = await limitsFor(a, opts); }));
  return out;
}

/**
 * The account for the next Claude run on this machine. Only one account → no usage lookup at all. `prefer` keeps a
 * resumable session on its own account while that account has room.
 */
export async function chooseAccount({ prefer = '' } = {}) {
  const list = accounts();
  const s = settings();
  if (list.length === 1 || s.mode !== 'auto') return pickAccount(list, {}, { mode: s.mode }).account;
  return pickAccount(list, await allLimits(), { mode: s.mode, thresholds: s.limits, prefer }).account;
}

export function resetAccountsCache() { cache.clear(); }

// ---------------------------------------------------------------- managing accounts
/** Add an account: its config folder under ~/.rigs/claude-accounts/<id>, and the command that logs it in. */
export function addAccount({ id, label = '', dir = '' } = {}) {
  if (!validId(id) || id === DEFAULT_ID) throw Object.assign(new Error('account id: letters, digits, - and _ (not "default")'), { status: 400 });
  const folder = path.resolve(expandHome(dir || path.join(ACCOUNTS_DIR, id)));
  fs.mkdirSync(folder, { recursive: true });
  const c = loadConfig();
  c.claude = { ...(c.claude || {}) };
  c.claude.accounts = [...(c.claude.accounts || []).filter((a) => a.id !== id), { id, label: label || id, dir: folder }];
  saveConfig(c);
  cache.delete(id);
  return { id, label: label || id, dir: folder, login: loginCommand(folder) };
}

export function removeAccount(id) {
  const c = loadConfig();
  const before = (c.claude?.accounts || []).length;
  c.claude = { ...(c.claude || {}), accounts: (c.claude?.accounts || []).filter((a) => a.id !== id) };
  if (c.claude.mode === id) c.claude.mode = 'auto';
  saveConfig(c);
  cache.delete(id);
  return { removed: before !== c.claude.accounts.length }; // the folder (and its login) is left on disk
}

export function setMode(mode) {
  if (mode !== 'auto' && !accounts().some((a) => a.id === mode)) throw Object.assign(new Error(`unknown account ${mode}`), { status: 400 });
  const c = loadConfig();
  c.claude = { ...(c.claude || {}), mode };
  saveConfig(c);
  return settings();
}

export const loginCommand = (dir) => (process.platform === 'win32' ? `set CLAUDE_CONFIG_DIR=${dir} && claude /login` : `CLAUDE_CONFIG_DIR='${dir}' claude /login`);

/** The status the UI / CLI / MCP show: every account with its usage and which one auto mode picks now. */
export async function status({ force = false } = {}) {
  const list = accounts();
  const s = settings();
  const limits = list.length > 1 ? await allLimits({ force }) : { [DEFAULT_ID]: await limitsFor(list[0], { force }) };
  const pick = pickAccount(list, limits, { mode: s.mode, thresholds: s.limits });
  return { ...s, next: pick.account?.id || null, why: pick.why, accounts: list.map((a) => ({ ...a, limits: limits[a.id] || null, login: a.dir ? loginCommand(a.dir) : 'claude /login' })) };
}
