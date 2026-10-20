// Ad-hoc tools (src/toolbox.js): where tool_register files them (the gitignored tools/local of the checkout), how
// they are tracked (adhocState: unmerged → promoted → merged), promotion into a dev worktree, dropping a merged copy
// into the trash, and the updater's clean-checkout check staying green while they are there. Scratch dirs and git
// repos only; no daemon needed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
process.env.RIGS_HOME = tmp('rigs-adhoc-');
process.env.RIGS_NAME = 'box';
process.env.RIGS_SEED_TOOLS = '';
process.env.RIGS_ADHOC_TOOLS = path.join(process.env.RIGS_HOME, 'adhoc');
const T = await import('../src/toolbox.js');
const { isDirty } = await import('../src/updater.js');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
const notDev = { isDevWorktree: () => false };
const SRC = 'let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => { const a = JSON.parse(s || "{}"); console.log(JSON.stringify({ ok: true, dryRun: !!a.dryRun })); });';
const tool = (id, extra = {}) => ({
  id, name: `Tool ${id}`, language: 'node', entry: 'main.mjs', safety: 'read-only', source: SRC,
  description: `Echoes whether it ran as a dry run; a stand-in for an ad-hoc tool an agent built during a task (${id}).`,
  tags: ['test', 'adhoc', 'echo'], smoke: { args: { dryRun: true }, expect: { ok: true, dryRun: true } },
  origin: { project: 'p1', task: 't1' }, ...extra,
});

/** A scratch RIGS-shaped checkout on a work branch: src/toolbox.js, tools/, and the real .gitignore committed. */
function scratchCheckout({ branch = 'work/box/tools' } = {}) {
  const dir = tmp('rigs-adhoc-wt-');
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'src', 'toolbox.js'), '// stand-in\n');
  fs.writeFileSync(path.join(dir, 'tools', 'applets.json'), '{}\n');
  fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(dir, '.gitignore'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  if (branch !== 'main') git(dir, 'checkout', '-qb', branch);
  return dir;
}

test('store location: ad-hoc root first (tools/local of the checkout by default), then RIGS_HOME/tools, then seeds', () => {
  const saved = { ...process.env };
  try {
    delete process.env.RIGS_ADHOC_TOOLS;
    process.env.RIGS_SEED_TOOLS = path.join(ROOT, 'tools');
    assert.equal(T.adhocRoot(), path.join(ROOT, 'tools', 'local'));
    assert.deepEqual(T.roots(), [path.join(ROOT, 'tools', 'local'), path.join(process.env.RIGS_HOME, 'tools'), path.join(ROOT, 'tools')]);
  } finally { Object.assign(process.env, saved); }
  assert.deepEqual(T.roots(), [process.env.RIGS_ADHOC_TOOLS, path.join(process.env.RIGS_HOME, 'tools')]);
  for (const id of ['local', 'adhoc', 'register', 'promote']) assert.match(T.validateManifest({ ...tool(id) }).errors.join(), /is reserved/, id);
});

test('.gitignore ignores tools/local, and the merge steward refuses a branch that commits into it', () => {
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^tools\/local\/$/m);
  assert.equal(git(ROOT, 'check-ignore', 'tools/local/some-tool/manifest.json').trim(), 'tools/local/some-tool/manifest.json');
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'merge.js'), 'utf8'), /const FORBIDDEN = .*tools\\\/local/);
});

test('registerTool files a new tool in the ad-hoc root as unmerged, and runTool runs it at once', async () => {
  const r = await T.registerTool(tool('quick-check'), { now: 1000 });
  assert.equal(r.created, true);
  assert.equal(r.dir, path.join(process.env.RIGS_ADHOC_TOOLS, 'quick-check'));
  const m = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'));
  assert.equal(m.adhoc.status, 'unmerged');
  assert.deepEqual(m.adhoc.origin, { project: 'p1', task: 't1', node: 'box' });
  assert.equal(m.adhoc.created, 1000);
  assert.equal(m.adhoc.contentHash, T.hashContents({ 'main.mjs': SRC }));
  const run = await T.runTool('quick-check', { args: {}, deps: notDev });
  assert.deepEqual(run.result, { ok: true, dryRun: false });
  assert.equal((await T.getTool('quick-check')).manifest.uses, 1);
  // A caller can't set the adhoc block.
  await T.registerTool({ ...tool('quick-check'), adhoc: { status: 'merged' } }, { now: 2000 });
  assert.equal((await T.getTool('quick-check')).manifest.adhoc.status, 'unmerged');
  assert.equal((await T.getTool('quick-check')).manifest.adhoc.created, 1000);
});

test('tools already filed in RIGS_HOME/tools are still read, listed as legacy ad-hoc tools and updated in place', async () => {
  const legacy = path.join(process.env.RIGS_HOME, 'tools', 'old-probe');
  fs.mkdirSync(legacy, { recursive: true });
  const { source, ...manifest } = tool('old-probe');
  fs.writeFileSync(path.join(legacy, 'main.mjs'), source);
  fs.writeFileSync(path.join(legacy, 'manifest.json'), JSON.stringify({ ...manifest, created: 500 }));
  assert.ok((await T.listLocal()).tools.some((t) => t.id === 'old-probe'));
  const l = await T.listAdhoc({ now: 500 + 3 * 86400000 });
  const old = l.tools.find((t) => t.id === 'old-probe');
  assert.equal(old.status, 'unmerged');
  assert.equal(old.legacy, true);
  assert.equal(T.ageText(old.ageMs), '3d');
  await T.registerTool({ ...tool('old-probe'), version: '1.0.1' });
  assert.equal(fs.existsSync(path.join(process.env.RIGS_ADHOC_TOOLS, 'old-probe')), false, 'not copied into the ad-hoc root');
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacy, 'manifest.json'), 'utf8')).version, '1.0.1');
});

test('hashContents: files only, order-free; manifest.json does not count', () => {
  const a = T.hashContents({ 'main.mjs': 'x', 'lib/u.js': 'y' });
  assert.equal(a, T.hashContents({ 'lib/u.js': Buffer.from('y'), 'main.mjs': 'x', 'manifest.json': '{"uses":9}' }));
  assert.notEqual(a, T.hashContents({ 'main.mjs': 'x', 'lib/u.js': 'z' }));
  assert.notEqual(T.hashContents({ ab: 'c' }), T.hashContents({ a: 'bc' }));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('adhocState: unmerged → promoted → merged, and back to unmerged when edited after promotion', () => {
  const t = (adhoc) => ({ id: 'x', name: 'X', uses: 2, created: 100, origin: { project: 'p', task: 't2', session: 's' }, adhoc });
  const promoted = { worktree: '/w', branch: 'work/box/x', at: 200, contentHash: 'h1' };
  const st = (adhoc, seeds = []) => T.adhocState([t(adhoc)], seeds, { now: 1100 })[0];
  const a = st({ status: 'unmerged', contentHash: 'h1', created: 100, origin: { node: 'box' } });
  assert.equal(a.status, 'unmerged');
  assert.deepEqual(a.origin, { project: 'p', task: 't2', node: 'box' });
  assert.equal(a.ageMs, 1000);
  assert.equal(a.uses, 2);
  assert.equal(st({ status: 'promoted', contentHash: 'h1', promoted }).status, 'promoted');
  const edited = st({ status: 'promoted', contentHash: 'h2', promoted });
  assert.equal(edited.status, 'unmerged');
  assert.equal(edited.changedSincePromote, true);
  const merged = st({ status: 'promoted', contentHash: 'h1', promoted }, [{ id: 'x', contentHash: 'h1' }]);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.seed, 'same');
  assert.equal(st({ status: 'unmerged', contentHash: 'h1' }, [{ id: 'x', contentHash: 'h1' }]).status, 'merged', 'identical content on main is merged whoever put it there');
  const differs = st({ status: 'unmerged', contentHash: 'h1' }, [{ id: 'x', contentHash: 'h0' }]);
  assert.equal(differs.status, 'unmerged');
  assert.equal(differs.seed, 'differs');
  assert.equal(T.adhocState([{ id: 'y', name: 'Y' }], []).at(0).status, 'unmerged', 'no adhoc block: unmerged');
  assert.deepEqual(T.filedAdhoc({ adhoc: { status: 'promoted', created: 5, promoted, origin: { node: 'mac' } } }, { project: 'p' }, 'h1', { now: 9, node: 'box' }), { status: 'promoted', origin: { project: 'p', node: 'mac' }, created: 5, contentHash: 'h1', promoted });
  assert.equal(T.filedAdhoc({ adhoc: { status: 'promoted', promoted } }, {}, 'h2', { now: 9 }).status, 'unmerged');
});

test('aggregateAdhoc: tags the node, reports failed and older nodes', () => {
  const r = T.aggregateAdhoc([
    { node: { id: '2', name: 'mac' }, tools: [{ id: 'b', status: 'unmerged' }, { id: 'a', status: 'promoted' }] },
    { node: { id: '1', name: 'win' }, error: 'timeout' },
    { node: { id: '3', name: 'old' }, error: 'HTTP 404' },
  ]);
  assert.deepEqual(r.tools.map((t) => `${t.node}/${t.id}/${t.status}`), ['mac/a/promoted', 'mac/b/unmerged']);
  assert.deepEqual(r.errors, [{ node: 'win', error: 'timeout' }, { node: 'old', error: 'no ad-hoc tracking (older RIGS)' }]);
});

test('seedProblems: what keeps a tool from shipping as a seed', () => {
  const { manifest } = T.validateManifest(tool('ok-tool'));
  assert.deepEqual(T.seedProblems(manifest, { 'main.mjs': SRC }), []);
  const bad = T.validateManifest({ ...tool('bad-tool'), smoke: undefined, language: 'python', entry: 'main.py', tags: ['x'], description: 'Too short to find.' }).manifest;
  const p = T.seedProblems(bad, { 'main.py': 'print(1)\r\n', 'k.txt': 'api_key = "abcdefghijkl"' }).join(' | ');
  for (const re of [/smoke call/, /plain Node/, /3 tags/, /80\+ characters/, /CRLF/, /secret/]) assert.match(p, re);
  const sm = T.seedManifest({ ...manifest, uses: 4, lastUsed: 9, adhoc: { status: 'unmerged' }, origin: { project: 'p', task: 't', session: 's', trace: 'tr' }, created: Date.parse('2026-10-19T08:00:00Z') }, { now: Date.parse('2026-10-20T08:00:00Z') });
  assert.equal(sm.adhoc, undefined);
  assert.equal(sm.uses, undefined);
  assert.deepEqual(sm.origin, { project: 'p', task: 't' });
  assert.equal(sm.created, '2026-10-19T08:00:00Z');
  assert.equal(sm.updated, '2026-10-20T08:00:00Z');
  assert.deepEqual(T.validateManifest(sm).errors, []);
});

test('promoteTools: copies into a dev worktree, smoke-checks there, marks promoted; merged once main has the seed; dropped to the trash', async () => {
  const wt = scratchCheckout();
  const dev = { isDevWorktree: (d) => d === wt };
  await T.registerTool(tool('ship-me'));
  await assert.rejects(T.promoteTools(['ship-me'], { worktree: wt, deps: notDev }), (e) => e.code === 'not-dev-worktree');
  await assert.rejects(T.promoteTools(['ship-me'], {}), (e) => e.code === 'no-worktree');
  const r = await T.promoteTools(['ship-me'], { worktree: wt, deps: dev, now: Date.parse('2026-10-20T08:00:00Z') });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.branch, 'work/box/tools');
  assert.match(r.next, /commit tools\/ship-me .*rigs propose/);
  const dest = path.join(wt, 'tools', 'ship-me');
  assert.equal(fs.readFileSync(path.join(dest, 'main.mjs'), 'utf8'), SRC);
  const shipped = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
  assert.equal(shipped.adhoc, undefined);
  assert.deepEqual(T.validateManifest(shipped).errors, []);
  assert.equal(await T.contentHash(dest), (await T.getTool('ship-me')).manifest.adhoc.contentHash);
  assert.equal(git(wt, 'status', '--porcelain'), '?? tools/ship-me/\n', 'only the new seed folder; nothing committed');
  assert.equal(git(wt, 'log', '--oneline').trim().split('\n').length, 1);
  const local = (await T.getTool('ship-me')).manifest.adhoc;
  assert.equal(local.status, 'promoted');
  assert.equal(local.promoted.worktree, wt);
  assert.equal((await T.listAdhoc()).tools.find((t) => t.id === 'ship-me').status, 'promoted');

  // Main gets the seed (the merged worktree's tools/ stands in for the installed checkout): merged, hidden by default.
  process.env.RIGS_SEED_TOOLS = path.join(wt, 'tools');
  try {
    assert.equal((await T.listAdhoc()).tools.some((t) => t.id === 'ship-me'), false);
    const all = await T.listAdhoc({ all: true });
    assert.equal(all.tools.find((t) => t.id === 'ship-me').status, 'merged');
    assert.equal(all.counts.merged, 1);
    assert.deepEqual((await T.listLocal()).errors, [], 'the seed root is read without errors');
    const unmerged = await T.dropAdhoc(['quick-check']);
    assert.match(unmerged.results[0].problem, /is unmerged/);
    const d = await T.dropAdhoc(['ship-me'], { now: 42 });
    assert.equal(d.results[0].ok, true);
    assert.equal(d.results[0].trashedTo, path.join(process.env.RIGS_HOME, 'trash', '42-tool-ship-me'));
    assert.ok(fs.existsSync(path.join(d.results[0].trashedTo, 'manifest.json')), 'moved, not deleted');
    assert.equal((await T.getTool('ship-me')).manifest.seed, true, 'the seed takes over');
  } finally { process.env.RIGS_SEED_TOOLS = ''; }
});

test('promoteTools: a tool that is not ready or fails its smoke call is left out and the worktree put back', async () => {
  const wt = scratchCheckout();
  const dev = { isDevWorktree: () => true };
  // An older version of the seed is already in the worktree.
  fs.mkdirSync(path.join(wt, 'tools', 'flaky'));
  fs.writeFileSync(path.join(wt, 'tools', 'flaky', 'main.mjs'), 'old');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'old flaky');
  await T.registerTool(tool('flaky', { source: 'process.exit(3)' }));
  await T.registerTool(tool('no-smoke', { smoke: undefined }));
  const r = await T.promoteTools(['flaky', 'no-smoke', 'nope'], { worktree: wt, deps: dev });
  assert.equal(r.ok, false);
  assert.equal(r.next, undefined);
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.match(by.flaky.problem, /smoke call failed.*exit 3/);
  assert.match(by['no-smoke'].problem, /not ready to ship as a seed: declare a smoke call/);
  assert.match(by.nope.problem, /no ad-hoc tool "nope"/);
  assert.equal(git(wt, 'status', '--porcelain'), '', 'worktree as it was');
  assert.equal(fs.readFileSync(path.join(wt, 'tools', 'flaky', 'main.mjs'), 'utf8'), 'old');
  assert.equal((await T.getTool('flaky')).manifest.adhoc.status, 'unmerged');
  await assert.rejects(T.promoteTools(['flaky'], { worktree: scratchCheckout({ branch: 'main' }), deps: dev }), (e) => e.code === 'bad-branch');
});

test('the updater stays clean with ad-hoc tools in the checkout, and a rollback keeps them', async () => {
  const repo = scratchCheckout({ branch: 'main' });
  const saved = process.env.RIGS_ADHOC_TOOLS;
  process.env.RIGS_ADHOC_TOOLS = path.join(repo, 'tools', 'local');
  try {
    const r = await T.registerTool(tool('in-checkout'));
    assert.equal(r.dir, path.join(repo, 'tools', 'local', 'in-checkout'));
    assert.equal((await T.runTool('in-checkout', { deps: notDev })).ok, true);
    assert.equal(git(repo, 'status', '--porcelain'), '', 'git status --porcelain stays empty');
    assert.equal(await isDirty(repo), false, "the updater's clean-checkout check is green");
    git(repo, 'reset', '--hard', 'HEAD');
    assert.ok(fs.existsSync(path.join(r.dir, 'manifest.json')), 'git reset --hard (rollback) leaves the ad-hoc tools alone');
    fs.appendFileSync(path.join(repo, 'src', 'toolbox.js'), '// edit\n');
    assert.equal(await isDirty(repo), true, 'a tracked edit still stops auto-update');
  } finally { process.env.RIGS_ADHOC_TOOLS = saved; }
});
