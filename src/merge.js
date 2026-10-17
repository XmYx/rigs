import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { bin } from './tools.js';
import { APP_DIR, HOME, isWin, log, readJsonSync, run, truncate, writeJsonAtomic } from './util.js';

/**
 * Change policy for RIGS itself (and any repo the mesh works on):
 *
 *  - Workers never commit to main. `rigs dev <topic>` creates a git worktree on branch
 *    work/<machine>/<topic> from origin/main; the agent works and commits there.
 *  - `rigs propose` hands the branch to the merge steward (one machine with push rights to the
 *    repo). The steward fetches it from the worker as a git bundle over the mesh, so workers need
 *    no GitHub credentials.
 *  - The steward merges ONE request at a time onto the latest origin/main in a scratch worktree:
 *      clean + checks green  → push main, roll the update out to every machine
 *      checks fail           → back to the author with the log (nothing merged)
 *      real conflict          → only then a resolver agent gets a task (Opus, per routing kind
 *                               "merge") with the conflicted files and both sides' intent
 *  Serial merging against the moving main is what keeps one worker from overwriting another.
 */

const DIR = path.join(RIGS_HOME, 'merge');
const QUEUE = path.join(DIR, 'queue.json');
const BRANCH_PREFIX = 'work';
// Never part of a change: dependencies (a worktree's node_modules is a symlink, which a "dir/"
// ignore rule does not match) and build output.
const FORBIDDEN = /^(node_modules|ui\/dist)(\/|$)/;

async function forbiddenPaths(cwd, range) {
  const r = await git(['diff', '--name-only', range], cwd);
  return r.stdout.split('\n').filter((f) => FORBIDDEN.test(f));
}

// OpenRig writes its seat culture/onboarding into the CLAUDE.md / AGENTS.md of every seat's working folder.
// Those blocks belong to that machine's seats, never to the repository.
const MANAGED = /\n*<!-- BEGIN OpenRig MANAGED BLOCK: ([^>]*?) -->[\s\S]*?<!-- END OpenRig MANAGED BLOCK: \1 -->\n?/g;
export const stripManaged = (text) => text.replace(MANAGED, '\n').replace(/\n{3,}$/, '\n').replace(/\n+$/, '\n');

async function managedBlockPaths(cwd, range) {
  const r = await git(['diff', '-U0', range], cwd);
  const out = new Set();
  let file = '';
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('+++ b/')) file = l.slice(6);
    else if (l.startsWith('+') && /(^|\/)(CLAUDE|AGENTS)\.md$/.test(file) && l.includes('<!-- BEGIN OpenRig')) out.add(file);
  }
  return [...out];
}

/**
 * Before RIGS proposes a worktree on an agent team's behalf: take OpenRig's injected blocks back out of the guides
 * (working tree and any commit that carried them), committing the removal.
 */
export async function stripManagedBlocks(dir) {
  const changed = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(dir, f);
    let text;
    try { text = await fsp.readFile(p, 'utf8'); } catch { continue; }
    const clean = stripManaged(text);
    if (clean !== text) { await fsp.writeFile(p, clean); changed.push(f); }
  }
  if (!changed.length) return { changed };
  // Only commit what is ours to commit: the guide files, and only when nothing else is uncommitted in them.
  await git(['add', '--', ...changed], dir);
  const staged = (await git(['diff', '--cached', '--name-only'], dir)).stdout.trim();
  if (staged) await git(['commit', '-m', 'Drop OpenRig managed blocks from the agent guides', '--', ...changed], dir);
  return { changed };
}

function git(args, cwd, timeout = 120000) {
  return run(bin('git') || 'git', args, { cwd, timeout });
}

function slug(s) {
  return String(s || 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change';
}

// ---------------------------------------------------------------- worker side

export function devRoot() { return process.env.RIGS_DEV_ROOT ? path.resolve(process.env.RIGS_DEV_ROOT) : path.join(HOME, 'rigs-dev'); }

/** Create a worktree for a change on its own branch, off the latest origin/main. */
export async function startWork(topic, { repo = APP_DIR } = {}) {
  const branch = `${BRANCH_PREFIX}/${slug(config().name)}/${slug(topic)}`;
  const dir = path.join(devRoot(), slug(topic));
  if (fs.existsSync(dir)) return { branch, dir, existing: true };
  const f = await git(['fetch', '--quiet', 'origin'], repo);
  if (f.code !== 0) throw new Error('git fetch failed: ' + f.stderr.trim().slice(-200));
  await fsp.mkdir(devRoot(), { recursive: true });
  const w = await git(['worktree', 'add', '-b', branch, dir, 'origin/main'], repo);
  if (w.code !== 0) throw new Error('git worktree add failed: ' + w.stderr.trim().slice(-300));
  // Share dependencies with the installed checkout so tests run without a fresh npm install.
  const nm = path.join(repo, 'node_modules');
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, 'node_modules'))) await fsp.symlink(nm, path.join(dir, 'node_modules'), isWin ? 'junction' : 'dir').catch(() => {});
  return { branch, dir, existing: false };
}

/** Describe a worker branch ready to propose (must be committed). */
export async function describe(dir) {
  const [b, st, base, logr] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], dir), git(['status', '--porcelain', '--untracked-files=no'], dir),
    git(['merge-base', 'HEAD', 'origin/main'], dir), git(['log', '--format=%h %s', 'origin/main..HEAD'], dir),
  ]);
  const branch = b.stdout.trim();
  if (!branch || branch === 'HEAD') throw new Error(`${dir} is not on a branch`);
  if (branch === 'main') throw new Error('changes go on a work branch, not main — run `rigs dev <topic>` first');
  if (st.stdout.trim()) throw new Error('commit your changes first (git status is not clean)');
  const commits = logr.stdout.trim().split('\n').filter(Boolean);
  if (!commits.length) throw new Error('nothing to propose: no commits ahead of origin/main');
  const managed = await managedBlockPaths(dir, 'origin/main...HEAD');
  if (managed.length) throw new Error(`the branch commits OpenRig's managed blocks into ${managed.join(', ')} (seats inject them into their folder's guide) — run \`rigs propose\` via RIGS, or remove the <!-- BEGIN/END OpenRig MANAGED BLOCK --> sections and commit`);
  const bad = await forbiddenPaths(dir, 'origin/main...HEAD');
  if (bad.length) throw new Error(`the branch commits ${bad.join(', ')} — remove them (git rm -r --cached ${bad[0].split('/')[0]}) and commit again`);
  return { branch, base: base.stdout.trim(), commits };
}

/** Pack the branch (everything not on origin/main) as a git bundle for the steward. */
export async function bundle(dir, branch) {
  const file = path.join(DIR, `out-${slug(branch)}-${Date.now()}.bundle`);
  await fsp.mkdir(DIR, { recursive: true });
  await git(['fetch', '--quiet', 'origin'], dir, 120000);
  let r = await git(['bundle', 'create', file, branch, '^origin/main'], dir);
  if (r.code !== 0) r = await git(['bundle', 'create', file, branch], dir); // branch already on main's history edge
  if (r.code !== 0) throw new Error('git bundle failed: ' + r.stderr.trim().slice(-200));
  return file;
}

/** After a merge: remove the worker's worktree and its (now merged) branch on that machine. */
export async function cleanupWork(dir, branch) {
  if (!dir || !fs.existsSync(dir)) return { removed: false };
  const common = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).stdout.trim();
  const repo = common ? path.dirname(common) : APP_DIR;
  // The shared-deps link is RIGS's own (startWork); anything else untracked is someone's work.
  try { if (fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()) fs.unlinkSync(path.join(dir, 'node_modules')); } catch {}
  const dirty = (await git(['status', '--porcelain'], dir)).stdout.trim();
  if (dirty) return { removed: false, reason: 'worktree has uncommitted changes — left alone' };
  const ahead = (await git(['rev-list', '--count', 'origin/main..HEAD'], dir)).stdout.trim();
  await git(['fetch', '--quiet', 'origin'], repo);
  const merged = (await git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], dir)).code === 0;
  if (!merged && ahead !== '0') return { removed: false, reason: 'branch has commits that are not on main yet — left alone' };
  const w = await git(['worktree', 'remove', dir], repo);
  if (w.code !== 0) return { removed: false, reason: w.stderr.trim().slice(-200) };
  await git(['branch', '-D', branch], repo);
  return { removed: true };
}

// ---------------------------------------------------------------- steward side

function loadQueue() { return readJsonSync(QUEUE, { requests: [] }); }
async function saveQueue(q) { await writeJsonAtomic(QUEUE, q); }

export function queue() {
  return loadQueue().requests.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

async function update(id, patch) {
  const q = loadQueue();
  const r = q.requests.find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, patch, { updatedAt: Date.now() });
  if (patch.event) { (r.log ||= []).push({ ts: Date.now(), text: patch.event }); delete r.event; }
  await saveQueue(q);
  return r;
}

/** A worker proposes a branch. Re-proposing the same branch replaces it (e.g. after fixes). */
export async function enqueue({ node, dir, branch, title, summary, commits, session }) {
  const q = loadQueue();
  let r = q.requests.find((x) => x.branch === branch && x.node === node && !['merged', 'dropped'].includes(x.status));
  if (r) Object.assign(r, { status: 'queued', title: title || r.title, summary: summary || r.summary, commits, dir, updatedAt: Date.now() });
  else {
    r = { id: crypto.randomBytes(4).toString('hex'), node, dir, branch, title: title || branch, summary: summary || '', commits, session: session || null, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), log: [] };
    q.requests.push(r);
  }
  (r.log ||= []).push({ ts: Date.now(), text: `proposed by ${node} (${commits?.length || 0} commit${commits?.length === 1 ? '' : 's'})` });
  await saveQueue(q);
  return r;
}

let running = false;

/**
 * Process the queue, one request at a time. ctx: { fetchBundle(req) → local file, rollout(),
 * notify(text, level), resolve(req) → starts a resolver agent task }.
 */
let recovered = false;

export async function processQueue(ctx, repo = APP_DIR) {
  if (running) return;
  running = true;
  try {
    if (!recovered) {
      // A merge in flight when the steward restarted (update, crash, reboot) starts over from its branch.
      recovered = true;
      for (const r of loadQueue().requests.filter((x) => ['fetching', 'checking', 'merging'].includes(x.status))) {
        await update(r.id, { status: 'queued', event: `the steward restarted while ${r.status} — starting this merge over` });
      }
    }
    for (;;) {
      const next = loadQueue().requests.filter((x) => x.status === 'queued' || x.status === 'resolved').sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!next) break;
      await mergeOne(next, ctx, repo).catch(async (e) => { await update(next.id, { status: 'error', error: e.message, event: 'error: ' + e.message }); ctx.notify?.(`Merge of ${next.branch} hit an error: ${e.message}`, 'error'); });
    }
  } finally { running = false; }
}

async function mergeOne(req, ctx, repo) {
  const work = path.join(DIR, 'wt-' + req.id);
  const ref = `refs/rigs/merge/${req.id}`;
  if (req.status === 'queued') {
    await update(req.id, { status: 'fetching', event: 'fetching branch from ' + req.node });
    const file = await ctx.fetchBundle(req);
    const f = await git(['fetch', file, `${req.branch}:${ref}`, '--force'], repo);
    if (f.code !== 0) throw new Error('fetch from bundle failed: ' + f.stderr.trim().slice(-200));
    await fsp.rm(file, { force: true });
  }
  await git(['fetch', '--quiet', 'origin'], repo);

  // A resolver already produced the merge commit in the worktree; otherwise do a trial merge now.
  if (req.status !== 'resolved' || !fs.existsSync(work)) {
    if (req.status === 'resolved') throw new Error('resolved worktree is gone — retry the request');
    await git(['worktree', 'remove', '--force', work], repo).catch(() => {});
    await fsp.rm(work, { recursive: true, force: true });
    const w = await git(['worktree', 'add', '--detach', work, 'origin/main'], repo);
    if (w.code !== 0) throw new Error('scratch worktree failed: ' + w.stderr.trim().slice(-200));
    await update(req.id, { status: 'merging', event: 'trial merge onto ' + (await git(['rev-parse', '--short', 'origin/main'], repo)).stdout.trim() });
    const m = await git(['-c', 'user.name=RIGS merge steward', '-c', `user.email=rigs@${config().name}`, 'merge', '--no-ff', '-m', `Merge ${req.branch} (${req.node}): ${req.title}`, ref], work);
    if (m.code !== 0) {
      const files = (await git(['diff', '--name-only', '--diff-filter=U'], work)).stdout.trim().split('\n').filter(Boolean);
      if (files.length) {
        // Real conflict: leave the worktree mid-merge for the resolver and step in.
        await update(req.id, { status: 'conflict', conflicts: files, worktree: work, event: `conflicts in ${files.join(', ')} — handing to a resolver` });
        ctx.notify?.(`${req.branch} from ${req.node} conflicts with main in ${files.length} file${files.length > 1 ? 's' : ''} — a resolver agent is on it.`, 'info');
        const t = await ctx.resolve({ ...req, conflicts: files, worktree: work }).catch((e) => ({ error: e.message }));
        await update(req.id, { resolver: t, event: t?.error ? 'could not start resolver: ' + t.error : `resolver: ${t.provider || ''} ${t.model || ''} on ${t.node || ''}`.trim() });
        return;
      }
      throw new Error('merge failed: ' + (m.stderr || m.stdout).trim().slice(-300));
    }
  }

  // Policy gate: the change must not carry dependencies or build output (they break every machine).
  const bad = (await git(['ls-files', 'node_modules', 'ui/dist'], work)).stdout.trim().split('\n').filter(Boolean);
  if (bad.length) return failChecks(req, ctx, 'policy', { stdout: `The merged tree tracks ${bad.join(', ')}. Dependencies and build output must never be committed.`, stderr: '' });

  // Checks: the same gate CI runs (build + tests), on the merged tree.
  await update(req.id, { status: 'checking', event: 'running build + tests on the merged tree' });
  const nm = path.join(repo, 'node_modules');
  if (!fs.existsSync(path.join(work, 'node_modules')) && fs.existsSync(nm)) await fsp.symlink(nm, path.join(work, 'node_modules'), isWin ? 'junction' : 'dir').catch(() => {});
  const changedDeps = (await git(['diff', '--name-only', 'origin/main', 'HEAD'], work)).stdout.split('\n').some((f) => f === 'package.json' || f === 'package-lock.json');
  const npm = bin('npm') || (isWin ? 'npm.cmd' : 'npm');
  if (changedDeps) { await fsp.rm(path.join(work, 'node_modules'), { force: true, recursive: false }).catch(() => {}); const i = await run(npm, ['ci', '--no-audit', '--no-fund'], { cwd: work, timeout: 900000 }); if (i.code !== 0) return failChecks(req, ctx, 'npm ci', i); }
  const b = await run(npm, ['run', 'build'], { cwd: work, timeout: 300000 });
  if (b.code !== 0) return failChecks(req, ctx, 'build', b);
  const t = await run(npm, ['test'], { cwd: work, timeout: 900000, env: { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1' } });
  if (t.code !== 0) return failChecks(req, ctx, 'tests', t);

  // Push. If main moved meanwhile, fold the new main in and check again (resolver only on conflict).
  const p = await git(['push', 'origin', 'HEAD:main'], work, 120000);
  if (p.code !== 0) {
    if (!/non-fast-forward|fetch first|rejected/i.test(p.stderr)) throw new Error('push failed: ' + p.stderr.trim().slice(-200));
    await git(['fetch', '--quiet', 'origin'], repo);
    const again = await git(['-c', 'user.name=RIGS merge steward', '-c', `user.email=rigs@${config().name}`, 'merge', '--no-ff', '-m', 'Merge origin/main', 'origin/main'], work);
    if (again.code !== 0) {
      const files = (await git(['diff', '--name-only', '--diff-filter=U'], work)).stdout.trim().split('\n').filter(Boolean);
      await update(req.id, { status: 'conflict', conflicts: files, worktree: work, event: `main moved and now conflicts in ${files.join(', ')}` });
      const t = await ctx.resolve({ ...req, conflicts: files, worktree: work }).catch((e) => ({ error: e.message }));
      await update(req.id, { resolver: t });
      return;
    }
    await update(req.id, { status: 'resolved', worktree: work, event: 'main moved while checking — folded it in, re-checking' });
    return;
  }
  const sha = (await git(['rev-parse', '--short', 'HEAD'], work)).stdout.trim();
  await git(['worktree', 'remove', '--force', work], repo);
  await git(['update-ref', '-d', ref], repo);
  await update(req.id, { status: 'merged', sha, worktree: null, event: `merged to main as ${sha}` });
  ctx.notify?.(`Merged ${req.branch} from ${req.node} → main ${sha}. Rolling out to every machine.`, 'ok');
  await ctx.rollout?.();
  const c = await ctx.cleanup?.(req).catch((e) => ({ removed: false, reason: e.message }));
  if (c) await update(req.id, { event: c.removed ? `removed the worktree on ${req.node}` : `kept the worktree on ${req.node}: ${c.reason || 'unknown'}` });
}

async function failChecks(req, ctx, stage, r) {
  const out = truncate((r.stdout + '\n' + r.stderr).trim().split('\n').slice(-40).join('\n'), 4000);
  await update(req.id, { status: 'checks-failed', failedStage: stage, output: out, event: `${stage} failed — sent back to ${req.node}` });
  ctx.notify?.(`${req.branch} from ${req.node} was not merged: ${stage} failed on the merged tree. Details in ⚙ → Changes.`, 'error');
  ctx.bounce?.(req, stage, out);
}

/** Called by the resolver (or a person) when the conflicted merge in the worktree is committed. */
export async function markResolved(id) {
  const q = loadQueue();
  const r = q.requests.find((x) => x.id === id);
  if (!r) throw new Error('unknown merge request');
  if (!r.worktree || !fs.existsSync(r.worktree)) throw new Error('no conflict worktree for this request');
  const unmerged = (await git(['diff', '--name-only', '--diff-filter=U'], r.worktree)).stdout.trim();
  if (unmerged) throw new Error('still unresolved: ' + unmerged.split('\n').join(', '));
  const midMerge = fs.existsSync(path.join((await git(['rev-parse', '--git-dir'], r.worktree)).stdout.trim(), 'MERGE_HEAD'));
  if (midMerge) {
    const c = await git(['-c', 'user.name=RIGS merge steward', '-c', `user.email=rigs@${config().name}`, 'commit', '--no-edit'], r.worktree);
    if (c.code !== 0) throw new Error('commit failed: ' + c.stderr.trim().slice(-200));
  }
  return update(id, { status: 'resolved', event: 'conflicts resolved — re-checking' });
}

export async function retry(id) { return update(id, { status: 'queued', event: 'retry requested' }); }
export async function drop(id) {
  const r = loadQueue().requests.find((x) => x.id === id);
  if (r?.worktree) await git(['worktree', 'remove', '--force', r.worktree], APP_DIR).catch(() => {});
  return update(id, { status: 'dropped', event: 'dropped' });
}

/** Can this machine push to the repo's origin? (gh signed in with push rights) */
let pushCache = { at: 0, value: false };
export async function canPush(repo = APP_DIR) {
  if (Date.now() - pushCache.at < 10 * 60 * 1000) return pushCache.value;
  let value = false;
  const url = (await git(['remote', 'get-url', 'origin'], repo, 5000)).stdout.trim();
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (m && bin('gh')) {
    const r = await run(bin('gh'), ['api', `repos/${m[1]}`, '--jq', '.permissions.push'], { timeout: 15000 });
    value = r.stdout.trim() === 'true';
  }
  pushCache = { at: Date.now(), value };
  return value;
}

/** Steward = configured machine, else the first online machine (by name) that can push. */
export function electSteward(nodes) {
  const pinned = config().merge?.steward;
  if (pinned) return nodes.find((n) => n.name === pinned && n.online && n.rigs) || null;
  return nodes.filter((n) => n.online && n.rigs && n.canPush).sort((a, b) => a.name.localeCompare(b.name))[0] || null;
}
