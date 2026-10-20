// Tool registry tests: manifest validation, argument checks, search ranking, register/get/list on disk, and runs
// (timeout, mutating refusal, git guard, redaction) against a scratch RIGS_HOME. No daemon needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-tools-'));
process.env.RIGS_NAME = 'box';
process.env.RIGS_SEED_TOOLS = ''; // the registry core, without the checkout's seed tools (test/toolbox-seeds.test.js covers those)
process.env.RIGS_ADHOC_TOOLS = path.join(process.env.RIGS_HOME, 'adhoc'); // new tools go to the ad-hoc root, here not the checkout's tools/local
const T = await import('../src/toolbox.js');

const base = { id: 'echo-json', name: 'Echo JSON', description: 'Prints its arguments back as JSON, for tests.', language: 'node', entry: 'main.js', safety: 'read-only' };
const ECHO = 'let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => console.log(JSON.stringify({ got: JSON.parse(s), cwd: process.cwd() })));';
const notDev = { isDevWorktree: () => false };

test('validateManifest: a minimal manifest gets defaults', () => {
  const { manifest, errors } = T.validateManifest({ ...base, id: 'Echo-JSON', tags: ['Demo', 'demo', 'json'] }, { now: 1000 });
  assert.deepEqual(errors, []);
  assert.equal(manifest.id, 'echo-json');
  assert.deepEqual(manifest.tags, ['demo', 'json']);
  assert.deepEqual(manifest.platforms, ['linux', 'darwin', 'windows']);
  assert.deepEqual(manifest.inputs, { type: 'object', properties: {} });
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.created, 1000);
  assert.equal(manifest.uses, 0);
  assert.deepEqual(T.validateManifest({ ...base, language: 'bash', entry: 'run.sh' }).manifest.platforms, ['linux', 'darwin']);
  assert.deepEqual(T.validateManifest({ ...base, language: 'powershell', entry: 'run.ps1' }).manifest.platforms, ['windows']);
});

test('validateManifest: rejects bad manifests with every problem named', () => {
  const bad = (raw) => T.validateManifest(raw).errors.join(' | ');
  assert.match(T.validateManifest(null).errors[0], /must be an object/);
  const all = bad({ id: 'Bad Id', language: 'ruby', entry: '../x.js', safety: 'maybe', version: 'v1', platforms: ['beos'], tags: 'x', timeoutSec: 9999 });
  for (const re of [/id must be/, /name is required/, /description is required/, /language must be one of/, /entry must be a relative file/, /safety must be/, /version must look like/, /platforms must be/, /tags must be/, /timeoutSec must be/]) assert.match(all, re);
  assert.match(bad({ ...base, entry: '/etc/passwd' }), /entry must be a relative/);
  assert.match(bad({ ...base, entry: '.hidden.js' }), /entry must be a relative/);
  assert.match(bad({ ...base, inputs: { type: 'string' } }), /inputs must describe an object/);
  assert.match(bad({ ...base, inputs: { type: 'object', properties: { n: { type: 'float' } } } }), /inputs.properties.n.type "float"/);
  assert.match(bad({ ...base, inputs: { type: 'object', required: 'n' } }), /required must be an array/);
  assert.match(bad({ ...base, origin: 'task t2' }), /origin must be an object/);
  assert.match(bad({ ...base, id: '' }), /^\?: id must be/);
});

test('validateArgs: required, types, enums, nesting', () => {
  const schema = { type: 'object', required: ['url'], properties: { url: { type: 'string' }, width: { type: 'integer' }, mode: { enum: ['fast', 'full'] }, size: { type: 'object', required: ['w'], properties: { w: { type: 'number' } } }, list: { type: 'array', items: { type: 'string' } } } };
  assert.deepEqual(T.validateArgs(schema, { url: 'x', width: 390, mode: 'fast', size: { w: 1.5 }, list: ['a'] }), []);
  assert.deepEqual(T.validateArgs(schema, {}), ['url is required']);
  assert.deepEqual(T.validateArgs(schema, { url: 1 }), ['url must be string']);
  assert.deepEqual(T.validateArgs(schema, { url: 'x', width: 1.5 }), ['width must be integer']);
  assert.deepEqual(T.validateArgs(schema, { url: 'x', mode: 'slow' }), ['mode must be one of "fast", "full"']);
  assert.deepEqual(T.validateArgs(schema, { url: 'x', size: {} }), ['size.w is required']);
  assert.deepEqual(T.validateArgs(schema, { url: 'x', list: [1] }), ['list[0] must be string']);
  assert.deepEqual(T.validateArgs(schema, [1]), ['arguments must be a JSON object']);
});

test('searchCatalog: id/name beat tags beat description; every word must hit; ties go to the most used', () => {
  const entries = [
    { id: 'shot-check', name: 'Screenshot check', tags: ['ui', 'verify'], description: 'Headless browser screenshot at desktop and phone width.', uses: 2 },
    { id: 'publish-app', name: 'Publish applet', tags: ['systemd', 'screenshot'], description: 'Writes a systemd unit and registers the app.', uses: 9 },
    { id: 'log-parse', name: 'Transcript parser', tags: ['usage'], description: 'Parses transcripts; can take a screenshot of nothing.', uses: 50 },
    T.appletEntry({ id: 'krea-studio', name: 'Krea Studio', node: 'box', health: { status: 'up' } }),
  ];
  const ids = (r) => r.map((x) => x.id);
  assert.deepEqual(ids(T.searchCatalog(entries, { q: 'screenshot' })), ['shot-check', 'publish-app', 'log-parse']);
  assert.deepEqual(ids(T.searchCatalog(entries, { q: 'publish-app' })), ['publish-app']);
  assert.deepEqual(ids(T.searchCatalog(entries, { q: 'screenshot phone' })), ['shot-check']);
  const krea = T.searchCatalog(entries, { q: 'krea' });
  assert.deepEqual(ids(krea), ['krea-studio']);
  assert.equal(krea[0].kind, 'applet');
  assert.equal(krea[0].path, '/api/nodes/box/apps/krea-studio/');
  assert.deepEqual(ids(T.searchCatalog(entries, { tag: 'applet' })), ['krea-studio']);
  assert.deepEqual(ids(T.searchCatalog(entries, { kind: 'tool', limit: 2 })), ['log-parse', 'publish-app']); // no query: most used first
  assert.deepEqual(T.searchCatalog(entries, { q: 'nothing-like-this' }), []);
  assert.equal(T.scoreEntry(entries[0], 'Shot-Check'), 160); // exact id + two id words
});

test('aggregateTools: tags node, reports failed and older nodes', () => {
  const r = T.aggregateTools([
    { node: { id: '2', name: 'mac' }, tools: [{ id: 'b' }, { id: 'a' }] },
    { node: { id: '1', name: 'win' }, error: 'timeout' },
    { node: { id: '3', name: 'old' }, tools: undefined },
  ]);
  assert.deepEqual(r.tools.map((t) => `${t.node}/${t.id}/${t.kind}`), ['mac/a/tool', 'mac/b/tool']);
  assert.deepEqual(r.errors, [{ node: 'win', error: 'timeout' }, { node: 'old', error: 'no tool registry (older RIGS)' }]);
});

test('registerTool: invalid manifests and missing entries are rejected; a valid tool is listed and readable', async () => {
  await assert.rejects(T.registerTool({ ...base, safety: 'whatever', source: ECHO }), (e) => e.status === 400 && /invalid tool manifest: echo-json: safety must be/.test(e.message));
  await assert.rejects(T.registerTool({ ...base }), /entry file "main.js" is missing/);
  await assert.rejects(T.registerTool({ ...base, files: { '../evil.js': 'x' }, source: ECHO }), /must be relative/);
  assert.equal(fs.existsSync(path.join(process.env.RIGS_ADHOC_TOOLS, 'echo-json')), false, 'nothing written for a rejected tool');
  const r = await T.registerTool({ ...base, tags: ['demo'], source: ECHO, files: { 'lib/util.js': 'export {}' }, origin: { project: 'p1', task: 't2', session: 's' }, uses: 99 }, { now: 5 });
  assert.equal(r.created, true);
  assert.equal(r.node, 'box');
  assert.equal(r.tool.uses, 0); // a caller can't set usage counts
  const again = await T.registerTool({ ...base, version: '1.1.0', description: 'Prints its arguments back as JSON, v1.1.' }, { now: 9 });
  assert.equal(again.created, false);
  const got = await T.getTool('ECHO-JSON');
  assert.equal(got.manifest.version, '1.1.0');
  assert.equal(got.manifest.created, 5);
  assert.equal(got.manifest.updated, 9);
  assert.deepEqual(got.manifest.origin, { project: 'p1', task: 't2', session: 's' }); // kept by an update without origin
  assert.deepEqual(Object.keys(got.files).sort(), ['lib/util.js', 'main.js']);
  assert.equal(got.files['main.js'], ECHO);
  fs.mkdirSync(path.join(process.env.RIGS_ADHOC_TOOLS, 'broken'));
  const list = await T.listLocal();
  assert.deepEqual(list.tools.map((t) => t.id), ['echo-json']);
  assert.deepEqual(list.errors, [{ id: 'broken', error: 'no manifest.json' }]);
  assert.equal(list.tools[0].files, undefined);
  await assert.rejects(T.getTool('nope'), (e) => e.status === 404 && e.code === 'not-found');
});

test('runTool: JSON args in, parsed JSON out, cwd, usage count, argument check', async () => {
  const r = await T.runTool('echo-json', { args: { hello: 'world' }, cwd: os.tmpdir(), deps: notDev });
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.result.got, { hello: 'world' });
  assert.equal(fs.realpathSync(r.result.cwd), fs.realpathSync(os.tmpdir()));
  assert.equal((await T.getTool('echo-json')).manifest.uses, 1);
  await T.registerTool({ id: 'needs-n', name: 'Needs n', description: 'Requires an integer argument n.', language: 'node', entry: 'main.js', safety: 'read-only', inputs: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }, source: ECHO });
  await assert.rejects(T.runTool('needs-n', { args: {}, deps: notDev }), (e) => e.code === 'bad-args' && /n is required/.test(e.message));
});

test('runTool: a tool that runs too long is killed at its timeout', async () => {
  await T.registerTool({ ...base, id: 'sleepy', name: 'Sleepy', timeoutSec: 30, source: 'setTimeout(() => console.log("late"), 20000);' });
  const t0 = Date.now();
  const r = await T.runTool('sleepy', { timeoutSec: 1, deps: notDev });
  assert.ok(Date.now() - t0 < 10000, 'returned soon after the timeout');
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out after 1s/);
});

test('runTool: mutating tools are refused unless allowMutating is true', async () => {
  const out = path.join(process.env.RIGS_HOME, 'touched.txt');
  await T.registerTool({ ...base, id: 'toucher', name: 'Toucher', description: 'Writes a file to prove it ran.', safety: 'mutating', source: `require('fs').writeFileSync(${JSON.stringify(out)}, 'x'); console.log('{"wrote":true}');` });
  for (const allowMutating of [undefined, false, 'true', 1]) {
    await assert.rejects(T.runTool('toucher', { allowMutating, deps: notDev }), (e) => e.status === 403 && e.code === 'mutating' && /allowMutating: true/.test(e.message));
  }
  assert.equal(fs.existsSync(out), false, 'a refused tool never ran');
  const r = await T.runTool('toucher', { allowMutating: true, deps: notDev });
  assert.deepEqual(r.result, { wrote: true });
  assert.equal(fs.existsSync(out), true);
});

test('runTool: the git guard and redaction apply', async () => {
  await T.registerTool({ ...base, id: 'pusher', name: 'Pusher', description: 'Would push a branch, which is never allowed.', safety: 'mutating', source: 'require("child_process").execSync("git push origin HEAD")' });
  await assert.rejects(T.runTool('pusher', { allowMutating: true, deps: notDev }), (e) => e.code === 'git-guard' && /git push/.test(e.message));
  await assert.rejects(T.runTool('pusher', { allowMutating: true, deps: { isDevWorktree: () => true } }), (e) => e.code === 'git-guard' && /even in a RIGS dev worktree/.test(e.message));
  await T.registerTool({ ...base, id: 'committer', name: 'Committer', description: 'Echoes the command it is given, for the guard test.', safety: 'mutating', source: ECHO });
  await assert.rejects(T.runTool('committer', { args: { cmd: 'git commit -am x' }, allowMutating: true, deps: notDev }), (e) => e.code === 'git-guard');
  assert.equal((await T.runTool('committer', { args: { cmd: 'git commit -am x' }, allowMutating: true, deps: { isDevWorktree: () => true } })).ok, true); // committing is fine in a dev worktree
  await T.registerTool({ ...base, id: 'leaky', name: 'Leaky', description: 'Prints a secret-looking token on both streams.', source: 'console.log("key sk-ant-abcdefghijklmnop123"); console.error("Bearer abc.def.ghi")' });
  const r = await T.runTool('leaky', { deps: notDev });
  assert.equal(r.result, 'key sk-ant-***');
  assert.match(r.stderr, /Bearer \*\*\*/);
});

test('refusal and interpreter: platform, read-only git, lookups', () => {
  const { manifest } = T.validateManifest({ ...base, language: 'bash', entry: 'run.sh' });
  assert.equal(T.refusal(manifest, {}, { platform: 'windows' }).code, 'platform');
  assert.equal(T.refusal(manifest, {}, { platform: 'linux', sources: ['git status && git log'] }), null);
  assert.equal(T.refusal(manifest, {}, { platform: 'linux', sources: ['echo hi\ngit checkout main'] }).code, 'git-guard');
  assert.deepEqual(T.interpreter('python', { lookup: (n) => (n === 'python3' ? '/usr/bin/python3' : null), win: false }), ['/usr/bin/python3']);
  assert.equal(T.interpreter('bash', { lookup: () => null }), null);
});
