// ui_open: the MCP tool that opens the JARVIS file browser at a machine + path (src/ui-open.js, src/mcp.js,
// POST /api/mesh/ui/open, the ui-open push, ui/src/ui-open-model.js), and the routing that sends "open my Downloads
// folder" to it. Pure parts first, then a real node: a push reaches the UI that sent the request, else every UI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { freePort } from './ports.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-ui-open-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: HOME, RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_NAME: 'test-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token', RIGS_NO_SYSTEMD: '1' };
Object.assign(process.env, { RIGS_HOME: HOME, RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node' });

const U = await import('../src/ui-open.js');
const { locate } = await import('../src/files.js');
const { TOOLS } = await import('../src/mcp.js');
const R = await import('../src/router.js');
const Q = await import('../src/quick.js');
const { responderPrompt } = await import('../src/responder.js');
const M = await import('../ui/src/ui-open-model.js');

const NODES = [
  { id: 'n-mac', name: 'macbookpro', platform: 'mac', self: true, online: true, rigs: true },
  { id: 'n-lin', name: 'magix-system', platform: 'linux', online: true, rigs: true },
  { id: 'n-win', name: 'gamer-pc', platform: 'windows', online: false, rigs: true },
];

// ---------------------------------------------------------------- arguments and path resolution (pure)

test('applications is a named place, resolved without a folder lookup', async () => {
  for (const n of ['applications', 'apps', 'programs', 'the applications', 'my installed apps']) assert.equal(U.placePath(n), '@apps', n);
  assert.equal(U.isPathLike('@apps'), false);
  const t = await U.resolveTarget({ node: 'magix-system', path: 'applications' }, { nodes: NODES });
  assert.deepEqual([t.node.name, t.path, t.via], ['magix-system', '@apps', 'place']);
  const a = M.uiOpenAction({ type: 'ui-open', view: 'files', nodeId: 'n-lin', nodeName: 'magix-system', path: '@apps' }, { machines: NODES });
  assert.deepEqual([a.nodeId, a.path, a.play, a.toast], ['n-lin', '@apps', '', '']);
});

test('validateOpen: files is the default view; unknown views and malformed values are a 400', () => {
  assert.deepEqual(U.validateOpen({}), { view: 'files', node: '', path: '' });
  assert.deepEqual(U.validateOpen({ view: 'files', node: ' magix-system ', path: ' ~/rigs-dev ' }), { view: 'files', node: 'magix-system', path: '~/rigs-dev' });
  // A brain that says machine (mesh_workspaces' word) instead of node still reaches that machine.
  assert.deepEqual(U.validateOpen({ machine: 'magix-system', path: '~' }), { view: 'files', node: 'magix-system', path: '~' });
  for (const bad of [{ view: 'terminal' }, { view: 3 }, { path: 42 }, { node: ['a'] }, { path: 'a\0b' }, { path: 'x'.repeat(5000) }, { node: 'n'.repeat(200) }]) {
    assert.throws(() => U.validateOpen(bad), (e) => e.status === 400 && e.code === 'bad-request', JSON.stringify(bad).slice(0, 60));
  }
  assert.throws(() => U.validateOpen(null), /object/);
  assert.throws(() => U.validateOpen([]), /object/);
  assert.deepEqual(U.UI_VIEWS, ['files', 'app', 'url', 'project', 'trace', 'model', 'tool', 'yolo']);
});

test('validateOpen: every view checks its own fields (app id, http(s) or /api url, project and trace ids, a tool name, a file path)', () => {
  const bad = (a, re) => assert.throws(() => U.validateOpen(a), (e) => e.status === 400 && re.test(e.message), JSON.stringify(a));
  assert.deepEqual(U.validateOpen({ view: 'app', app: 'body-matching', path: '/training' }), { view: 'app', node: '', path: '/training', app: 'body-matching' });
  assert.deepEqual(U.validateOpen({ view: 'app', app: 'props-studio', node: 'magix-system', title: 'Props' }), { view: 'app', node: 'magix-system', path: '', title: 'Props', app: 'props-studio' });
  bad({ view: 'app' }, /needs app/); bad({ view: 'app', app: 'Bad App' }, /App Cloud id/); bad({ view: 'app', app: 'x', path: 'training' }, /starts with \//);
  assert.deepEqual(U.validateOpen({ view: 'url', url: ' https://example.com/report ' }), { view: 'url', node: '', path: '', url: 'https://example.com/report' });
  assert.deepEqual(U.validateOpen({ view: 'url', url: '/api/nodes/n/files/raw?path=%2Fx.html' }).url, '/api/nodes/n/files/raw?path=%2Fx.html');
  bad({ view: 'url' }, /needs url/); bad({ view: 'url', url: 'javascript:alert(1)' }, /http/); bad({ view: 'url', url: '/etc/passwd' }, /http/); bad({ view: 'url', url: 'file:///x' }, /http/);
  assert.deepEqual(U.validateOpen({ view: 'project', project: 'pr-abc12' }), { view: 'project', node: '', path: '', project: 'pr-abc12' });
  bad({ view: 'project' }, /needs project/); bad({ view: 'project', project: 'a b' }, /id/);
  assert.deepEqual(U.validateOpen({ view: 'trace', trace: 'tr-20261022-0123456789ab' }), { view: 'trace', node: '', path: '', trace: 'tr-20261022-0123456789ab' });
  bad({ view: 'trace' }, /needs trace/); bad({ view: 'trace', trace: 'tr-x' }, /trace id/);
  assert.deepEqual(U.validateOpen({ view: 'model', path: '@shared/files/3d/chair.glb' }), { view: 'model', node: '', path: '@shared/files/3d/chair.glb' });
  bad({ view: 'model' }, /needs path/);
  assert.deepEqual(U.validateOpen({ view: 'tool', path: '~/out/data.csv', tool: 'CSV' }), { view: 'tool', node: '', path: '~/out/data.csv', tool: 'csv' });
  bad({ view: 'tool', path: '~/x' }, /needs tool/); bad({ view: 'tool', path: '~/x', tool: 'excel' }, /unknown tool/); bad({ view: 'tool', tool: 'csv' }, /needs path/);
  bad({ view: 'files', title: 't'.repeat(300) }, /title/); bad({ view: 'url', url: 5 }, /string/);
  assert.deepEqual(U.FILE_TOOLS, ['text', 'image', 'pdf', 'csv', 'json', 'html', 'model']);
  assert.ok(U.isAllowedUrl('http://localhost:8188/') && U.isAllowedUrl('/api/nodes/x/apps/y/') && !U.isAllowedUrl('/apix') && !U.isAllowedUrl('https://') && !U.isAllowedUrl('ftp://a'));
});

test('uiOpenPush: the push for the other views keeps only the fields given, with the request trace for delivery', () => {
  const p = U.uiOpenPush({ view: 'app', app: 'x', node: 'm', nodeId: 'n-1', path: '', name: undefined, trace: 'tr-20261022-0123456789ab' });
  assert.deepEqual(Object.keys(p).sort(), ['app', 'id', 'node', 'nodeId', 'trace', 'type', 'view']);
  assert.equal(p.type, 'ui-open');
  assert.match(p.id, /^uo-/);
  const t = U.uiOpenPush({ view: 'trace', traceId: 'tr-20261022-0123456789ab' });
  assert.deepEqual([t.view, t.traceId, 'trace' in t], ['trace', 'tr-20261022-0123456789ab', false]);
});

test('placePath / isPathLike: named places become ~ paths, names that are no path are not paths', () => {
  assert.equal(U.placePath('downloads'), '~/Downloads');
  assert.equal(U.placePath('my Downloads folder'), '~/Downloads');
  assert.equal(U.placePath('the home directory'), '~');
  assert.equal(U.placePath('my home'), '~');
  assert.equal(U.placePath('Desktop'), '~/Desktop');
  assert.equal(U.placePath('MadMikeUnity'), null);
  assert.equal(U.placePath('shared'), '@shared');
  assert.equal(U.placePath('the shared folder'), '@shared');
  assert.equal(U.placePath('shared reports'), '@shared/reports');
  assert.equal(U.placePath('constructor'), null, 'no prototype keys');
  for (const p of ['~', '~/x', '/etc', '.', '../up', 'C:\\Users', 'a/b', 'a\\b']) assert.equal(U.isPathLike(p), true, p);
  for (const p of ['rigs-dev', 'MadMikeUnity', 'downloads']) assert.equal(U.isPathLike(p), false, p);
});

test('resolveMachine: self, name, id and phrases like "the linux machine"; unknown or ambiguous → null', () => {
  assert.equal(U.resolveMachine('', NODES).name, 'macbookpro');
  assert.equal(U.resolveMachine('self', NODES).name, 'macbookpro');
  assert.equal(U.resolveMachine('this machine', NODES).name, 'macbookpro');
  assert.equal(U.resolveMachine('Magix-System', NODES).name, 'magix-system');
  assert.equal(U.resolveMachine('n-lin', NODES).name, 'magix-system');
  assert.equal(U.resolveMachine('the linux machine', NODES).name, 'magix-system');
  assert.equal(U.resolveMachine('on magix', NODES).name, 'magix-system');
  assert.equal(U.resolveMachine('my mac', NODES).name, 'macbookpro');
  assert.equal(U.resolveMachine('the windows pc', NODES).name, 'gamer-pc', 'an offline machine still matches when it is the only one');
  assert.equal(U.resolveMachine('the toaster', NODES), null);
  const twoMacs = [...NODES, { id: 'n-mini', name: 'mac-mini', platform: 'mac', online: true, rigs: true }];
  assert.equal(U.resolveMachine('the mac', twoMacs), null, 'two Macs: not guessed');
});

test('resolveTarget: paths stay, places map, nicknames resolve through workspaces (and may move machine)', async () => {
  const findWorkspace = async (name) => (/madmike/i.test(name) ? { node: 'magix-system', path: '/home/mix/MadMaxUnity', name: 'MadMaxUnity' } : null);
  const ctx = { nodes: NODES, findWorkspace };
  let t = await U.resolveTarget({ node: 'magix-system', path: '~/rigs-dev' }, ctx);
  assert.deepEqual([t.node.name, t.path, t.via], ['magix-system', '~/rigs-dev', 'path']);
  t = await U.resolveTarget({ node: '', path: 'downloads' }, ctx);
  assert.deepEqual([t.node.name, t.path, t.via], ['macbookpro', '~/Downloads', 'place']);
  t = await U.resolveTarget({ node: '', path: '' }, ctx);
  assert.deepEqual([t.node.name, t.path, t.via], ['macbookpro', '~', 'default']);
  t = await U.resolveTarget({ node: 'macbookpro', path: 'MadMikeUnity' }, ctx);
  assert.deepEqual([t.node.name, t.path, t.via, t.workspace, t.moved], ['magix-system', '/home/mix/MadMaxUnity', 'workspace', 'MadMaxUnity', 'macbookpro']);
  t = await U.resolveTarget({ node: 'the linux machine', path: 'scratch' }, ctx);
  assert.deepEqual([t.node.name, t.path], ['magix-system', '~/scratch'], 'a bare name that is no workspace is a folder under home');
  await assert.rejects(U.resolveTarget({ node: 'the toaster', path: '~' }, ctx), (e) => e.status === 404);
});

test('nearestExisting: a folder opens itself, a file its folder with it selected, a missing path its nearest parent', () => {
  const fsMap = { '/a': 'dir', '/a/b': 'dir', '/a/b/f.pdf': 'file', '/': 'dir' };
  const kind = (p) => fsMap[p] || null;
  const parent = (p) => path.posix.dirname(p);
  assert.deepEqual(U.nearestExisting('/a/b', kind, parent), { folder: '/a/b', select: '', missing: false });
  assert.deepEqual(U.nearestExisting('/a/b/f.pdf', kind, parent), { folder: '/a/b', select: '/a/b/f.pdf', missing: false });
  assert.deepEqual(U.nearestExisting('/a/b/gone/deeper', kind, parent), { folder: '/a/b', select: '', missing: true });
  assert.deepEqual(U.nearestExisting('/a/b/f.pdf/x', kind, parent), { folder: '/a/b', select: '', missing: true }, 'a path through a file falls back to its folder');
  assert.deepEqual(U.nearestExisting('/zz', () => null, parent), { folder: '', select: '', missing: true });
});

test('files.locate on a real folder: folder, file, missing, ~', () => {
  const dir = path.join(HOME, 'loc', 'sub');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.pdf'), '%PDF-1.4');
  assert.deepEqual([locate(dir).folder, locate(dir).missing], [dir, false]);
  const f = locate(path.join(dir, 'report.pdf'));
  assert.deepEqual([f.folder, f.select, f.missing], [dir, path.join(dir, 'report.pdf'), false]);
  const m = locate(path.join(dir, 'nope', 'deeper'));
  assert.deepEqual([m.folder, m.missing], [dir, true]);
  assert.equal(locate('~').folder, os.homedir());
});

// ---------------------------------------------------------------- the MCP tool, the fast path and the local responder

test('ui_open is an MCP tool with a view/node/path schema that says not to use Finder, xdg-open or mesh_control', () => {
  const t = TOOLS.find((x) => x.name === 'ui_open');
  assert.ok(t, 'ui_open is listed');
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['app', 'node', 'path', 'project', 'title', 'tool', 'trace', 'url', 'view']);
  assert.deepEqual(t.inputSchema.properties.view.enum, U.UI_VIEWS);
  assert.deepEqual(t.inputSchema.properties.tool.enum, U.FILE_TOOLS);
  for (const re of [/view model shows a \.glb\/\.gltf\/\.obj in the 3D viewer/, /view app opens an App Cloud app window/, /view url shows any http\(s\) page/, /view project opens the Projects window/, /view tool opens a file in a specific tool/]) assert.match(t.description, re);
  const n = TOOLS.find((x) => x.name === 'mesh_notify');
  assert.ok(n.inputSchema.properties.open, 'mesh_notify takes open');
  assert.deepEqual(n.inputSchema.properties.open.properties.view.enum, U.UI_VIEWS);
  assert.match(n.description, /open: what the Open button on the notice opens \(same arguments as ui_open\)/);
  assert.match(t.description, /Finder/);
  assert.match(t.description, /xdg-open/);
  assert.match(t.description, /mesh_control/);
  assert.match(TOOLS.find((x) => x.name === 'mesh_list_dir').description, /ui_open/);
});

test('the local responder may use ui_open: in READ_ONLY_TOOLS (8 tools, still config-narrowable) and in its prompt', () => {
  assert.equal(Q.READ_ONLY_TOOLS.length, 8);
  assert.ok(Q.READ_ONLY_TOOLS.includes('ui_open'));
  assert.deepEqual(Q.localSettings({ tools: ['mesh_status', 'mesh_exec'] }).tools, ['mesh_status'], 'still never widened');
  assert.match(responderPrompt({ tools: Q.READ_ONLY_TOOLS }), /- ui_open: opens the JARVIS file browser/);
  assert.match(responderPrompt({ tools: Q.READ_ONLY_TOOLS }), /ui_open is the one action you may take/);
  assert.doesNotMatch(responderPrompt({ tools: ['mesh_status'] }), /ui_open/, 'not mentioned when it is configured away');
  assert.match(Q.quickNote({ model: 'claude-haiku-5-5' }), /ui_open/);
  assert.match(Q.quickNote({ model: 'claude-haiku-5-5' }), /Never Finder/);
});

test('the full brain\'s persona prompt and the operating rules send folder requests to ui_open', async () => {
  const { personaPrompt } = await import('../src/chat.js');
  const p = personaPrompt('', '');
  assert.match(p, /call ui_open/);
  assert.match(p, /Never use Finder, `open`, xdg-open, explorer or mesh_control/);
  assert.match(fs.readFileSync(path.join(ROOT, 'persona', 'AGENTS.md'), 'utf8'), /Folders and files: `ui_open`/);
});

// ---------------------------------------------------------------- routing (pure)

const OPEN = ['open the Downloads folder', 'open ~/rigs-dev on magix-system', 'show me the files in my home folder', 'open my Downloads folder',
  'Open the MadMikeUnity folder on the linux machine', 'Show it in files in Jarvis', 'can you open my downloads folder please', 'Bring up the Romanian training PDF',
  'browse to /var/log on magix-system', 'JARVIS, show me the desktop folder'];

test('router: open-folder phrasings route to answer — by the keyword rules and over a model that said work', () => {
  for (const t of OPEN) {
    assert.equal(R.isBrowseRequest(t), true, t);
    assert.equal(R.heuristicRoute(t, []).route, 'answer', `rules: ${t}`);
    for (const route of ['implement', 'plan']) {
      const d = R.withWork({ route, work: [{ title: 'x', goal: t, workspace: 'rigs', machine: '' }] }, t, { selfNode: 'macbookpro' });
      assert.equal(d.route, 'answer', `model said ${route}: ${t}`);
      assert.equal(d.work, undefined);
    }
    assert.equal(R.withWork({ route: 'answer' }, t, { selfNode: 'macbookpro' }).route, 'answer', `stays answer: ${t}`);
  }
});

test('router: asking to change how folders open is still work, and non-folder asks are untouched', async () => {
  const work = ['Make sure cases like this are handled correctly: it should have opened a file browser inside rigs and nust navigate there',
    'fix the file browser so it opens the downloads folder', 'add a button that opens the downloads folder'];
  for (const t of work) {
    assert.equal(R.isBrowseRequest(t), false, t);
    assert.notEqual(R.withWork({ route: 'implement', work: [] }, t, { selfNode: 'macbookpro' }).route, 'answer', t);
  }
  for (const t of ['open the terminal', 'open the app store', 'go to the dashboard', 'what is in my downloads folder?']) assert.equal(R.isBrowseRequest(t), false, t);
  // The full decision with a model that wanted to file it: the guard still answers.
  const d = await R.route('open my Downloads folder', { threads: [], projects: [], catalog: [], selfNode: 'macbookpro' }, {
    settings: R.routerSettings({ engine: 'claude', fallback: 'rules' }), engines: { claude: async () => ({ route: 'implement', reason: 'x', title: '' }) },
  });
  assert.equal(d.route, 'answer');
});

// ---------------------------------------------------------------- the UI side (pure)

test('uiOpenAction: a push → open the file browser for that machine at that folder, with a toast on a fallback', () => {
  const machines = [{ id: 'n-mac', name: 'macbookpro' }];
  assert.equal(M.uiOpenAction({ type: 'notify' }), null);
  assert.equal(M.uiOpenAction({ type: 'ui-open', view: 'terminal', nodeId: 'n-mac', path: '/x' }), null);
  assert.equal(M.uiOpenAction({ type: 'ui-open', view: 'files', path: '/x' }), null);
  const a = M.uiOpenAction({ type: 'ui-open', id: 'uo-1', view: 'files', nodeId: 'n-mac', nodeName: 'mac', path: '/Users/mix/Downloads', select: '', missing: false, requested: '~/Downloads' }, { machines });
  assert.deepEqual(a, { id: 'uo-1', view: 'files', nodeId: 'n-mac', nodeName: 'macbookpro', path: '/Users/mix/Downloads', select: '', showHidden: false, play: '', tool: '', toast: '' });
  const f = M.uiOpenAction({ type: 'ui-open', view: 'files', nodeId: 'n-x', nodeName: 'magix-system', path: '/home/mix', select: '/home/mix/.bashrc', missing: false }, { machines });
  assert.deepEqual([f.nodeName, f.select, f.showHidden], ['magix-system', '/home/mix/.bashrc', true]);
  const m = M.uiOpenAction({ type: 'ui-open', view: 'files', nodeId: 'n-mac', path: '/Users/mix', missing: true, requested: '~/gone/deep' }, { machines });
  assert.equal(m.toast, "~/gone/deep isn't on macbookpro; opened /Users/mix instead.");
  // A selected .glb / .pdf / .csv / .json opens in its tool as well as in Finder; text, images and a fallback do not.
  const t = (select, missing = false) => M.uiOpenAction({ type: 'ui-open', view: 'files', nodeId: 'n-mac', path: '/d', select, missing }, { machines }).tool;
  assert.deepEqual([t('/d/chair.glb'), t('/d/scene.gltf'), t('/d/m.obj'), t('/d/r.pdf'), t('/d/d.csv'), t('/d/p.json'), t('/d/n.txt'), t('/d/i.png'), t('/d/r.pdf', true), t('')], ['model', 'model', 'model', 'pdf', 'csv', 'json', '', '', '', '']);
  assert.equal(M.uiOpenAction({ type: 'ui-open', view: 'files', nodeId: 'n-mac', path: '/d', select: '/d/song.mp3' }, { machines }).play, '/d/song.mp3');
});

test('uiOpenAction: app, url, project, trace, model and tool pushes become their actions; a push missing its field is ignored', () => {
  const machines = [{ id: 'n-lin', name: 'magix-system' }];
  const a = M.uiOpenAction({ type: 'ui-open', id: 'uo-2', view: 'app', app: 'body-matching', name: 'Body Matching', nodeId: 'n-lin', path: '/training' }, { machines });
  assert.deepEqual(a, { id: 'uo-2', view: 'app', app: 'body-matching', name: 'Body Matching', nodeId: 'n-lin', nodeName: 'magix-system', path: '/training', title: '' });
  assert.equal(M.uiOpenAction({ type: 'ui-open', view: 'app' }), null);
  const u = M.uiOpenAction({ type: 'ui-open', view: 'url', url: 'https://example.com/r' });
  assert.deepEqual([u.view, u.url, u.title], ['url', 'https://example.com/r', 'https://example.com/r']);
  assert.equal(M.uiOpenAction({ type: 'ui-open', view: 'url', url: 'https://x', title: 'Report' }).title, 'Report');
  const p = M.uiOpenAction({ type: 'ui-open', view: 'project', project: 'pr-1', nodeId: 'n-lin' }, { machines });
  assert.deepEqual([p.view, p.project, p.nodeId, p.nodeName], ['project', 'pr-1', 'n-lin', 'magix-system']);
  assert.deepEqual(M.uiOpenAction({ type: 'ui-open', view: 'project', project: 'pr-1' }).nodeId, '');
  assert.deepEqual(M.uiOpenAction({ type: 'ui-open', view: 'trace', traceId: 'tr-20261022-0123456789ab' }).trace, 'tr-20261022-0123456789ab');
  assert.equal(M.uiOpenAction({ type: 'ui-open', view: 'trace' }), null);
  const m = M.uiOpenAction({ type: 'ui-open', view: 'model', nodeId: 'n-lin', path: '/home/mix/RIGS-Shared/files/3d/chair.glb', folder: '/home/mix/RIGS-Shared/files/3d' }, { machines });
  assert.deepEqual([m.view, m.nodeName, m.path, m.name, m.tool], ['model', 'magix-system', '/home/mix/RIGS-Shared/files/3d/chair.glb', 'chair.glb', 'model']);
  const t = M.uiOpenAction({ type: 'ui-open', view: 'tool', nodeId: 'n-lin', path: '/x/data.csv', tool: 'csv' }, { machines });
  assert.deepEqual([t.view, t.tool, t.name], ['tool', 'csv', 'data.csv']);
  assert.equal(M.uiOpenAction({ type: 'ui-open', view: 'tool', nodeId: 'n-lin', path: '/x/data.bin' }), null);
  assert.deepEqual(M.VIEWS, U.UI_VIEWS);
});

test('filesTarget: an open window for that machine is navigated, a closed one or another machine\'s is not', () => {
  const wins = new Map([['n-mac', { closed: false, id: 1 }], ['n-lin', { closed: true }]]);
  assert.equal(M.filesTarget(wins, 'n-mac').id, 1);
  assert.equal(M.filesTarget(wins, 'n-lin'), null);
  assert.equal(M.filesTarget(wins, 'n-win'), null);
  assert.equal(M.filesTarget(undefined, 'n-mac'), null);
});

test('isBrowseAsk: folder and file asks skip the UI\'s by-name shortcuts (graph focus, pinned projects)', () => {
  for (const t of ['open my Downloads folder', "show me what's in ~/Documents", 'show me what’s in MadMikeUnity', 'open the rigs folder on the linux machine',
    'show me /var/log', 'open ~/Projects/gone/notes on this machine', 'show me the files in my home folder', 'show me Downloads']) {
    assert.equal(M.isBrowseAsk(t), true, t);
  }
  for (const t of ['show me magix-system', 'open the MadMikeUnity project', 'go to macbookpro', 'show me the agents', 'focus claude']) {
    assert.equal(M.isBrowseAsk(t), false, t);
  }
});

test('addClaim: trace ids only, no repeats, capped', () => {
  let l = [];
  l = M.addClaim(l, 'tr-20261020-aaaaaaaaaaaa');
  l = M.addClaim(l, 'tr-20261020-aaaaaaaaaaaa');
  l = M.addClaim(l, 'not-a-trace');
  assert.deepEqual(l, ['tr-20261020-aaaaaaaaaaaa']);
  for (let i = 0; i < 30; i++) l = M.addClaim(l, `tr-20261020-${String(i).padStart(12, '0')}`, 5);
  assert.equal(l.length, 5);
  assert.equal(l.at(-1), 'tr-20261020-000000000029');
});

// ---------------------------------------------------------------- a real node: endpoint, push targeting, MCP

let server;
before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/self')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start:\n' + out);
});
after(() => { server?.kill(); fs.rmSync(HOME, { recursive: true, force: true }); });

/** A UI socket that collects the ui-open pushes it gets. */
async function uiSocket() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const got = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'ui-open') got.push(m); });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return { ws, got };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(body, headers = {}) {
  const r = await fetch(`${BASE}/api/mesh/ui/open`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('POST /api/mesh/ui/open: the UI that sent the request gets it; without one every UI does; folders, files, fallbacks', async () => {
  const dir = path.join(HOME, 'proj', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.pdf'), '%PDF-1.4');
  const A = await uiSocket();
  const B = await uiSocket();
  const trace = 'tr-20261020-0123456789ab';
  A.ws.send(JSON.stringify({ type: 'claim-trace', traceId: trace }));
  await wait(150);

  let r = await open({ view: 'files', node: 'self', path: path.join(dir, 'report.pdf'), trace });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ok, r.body.node, r.body.path, r.body.select, r.body.missing, r.body.shownOn, r.body.delivered], [true, 'test-node', dir, path.join(dir, 'report.pdf'), false, 'requester', 1]);
  await wait(150);
  assert.equal(A.got.length, 1);
  assert.equal(B.got.length, 0, 'the other UI is left alone');
  assert.deepEqual([A.got[0].view, A.got[0].nodeName, A.got[0].path, A.got[0].select, A.got[0].trace], ['files', 'test-node', dir, path.join(dir, 'report.pdf'), trace]);

  // The trace rides in the x-rigs-trace header too (that is how the rigs MCP sends it).
  r = await open({ path: dir }, { 'x-rigs-trace': `${trace}:sp-0123456789ab` });
  assert.equal(r.body.shownOn, 'requester');
  await wait(150);
  assert.deepEqual([A.got.length, B.got.length], [2, 0]);

  // A trace no open UI sent (that tab was closed): every UI on the mesh.
  r = await open({ path: path.join(dir, 'gone', 'deeper'), trace: 'tr-20261020-ffffffffffff' });
  assert.deepEqual([r.body.shownOn, r.body.delivered, r.body.path, r.body.missing], ['all', 2, dir, true]);
  await wait(150);
  assert.deepEqual([A.got.length, B.got.length], [3, 1]);
  assert.equal(B.got[0].missing, true);
  assert.equal(B.got[0].requested, path.join(dir, 'gone', 'deeper'));

  // Bad arguments and unknown machines are refused before anything is pushed.
  assert.equal((await open({ view: 'terminal' })).status, 400);
  assert.equal((await open({ node: 'the toaster', path: '~' })).status, 404);
  await wait(100);
  assert.deepEqual([A.got.length, B.got.length], [3, 1]);
  A.ws.close(); B.ws.close();
});

test('POST /api/mesh/ui/open: the url, trace, project, tool and model views push their own events; a model needs a file; an unknown app is a 404', async () => {
  const dir = path.join(HOME, 'proj', 'out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(dir, 'chair.glb'), 'glTF');
  const A = await uiSocket();
  let r = await open({ view: 'url', url: 'https://example.com/report', title: 'Report' });
  assert.deepEqual([r.status, r.body.ok, r.body.view, r.body.url, r.body.title, r.body.delivered], [200, true, 'url', 'https://example.com/report', 'Report', 1], JSON.stringify(r.body));
  r = await open({ view: 'trace', trace: 'tr-20261022-0123456789ab' });
  assert.deepEqual([r.status, r.body.view, r.body.traceId], [200, 'trace', 'tr-20261022-0123456789ab']);
  r = await open({ view: 'project', project: 'pr-42', node: 'self' });
  assert.deepEqual([r.status, r.body.view, r.body.project, r.body.node], [200, 'project', 'pr-42', 'test-node']);
  r = await open({ view: 'tool', path: path.join(dir, 'data.csv'), tool: 'csv' });
  assert.deepEqual([r.status, r.body.view, r.body.path, r.body.folder, r.body.tool, r.body.node], [200, 'tool', path.join(dir, 'data.csv'), dir, 'csv', 'test-node'], JSON.stringify(r.body));
  r = await open({ view: 'model', path: path.join(dir, 'chair.glb') });
  assert.deepEqual([r.status, r.body.view, r.body.path], [200, 'model', path.join(dir, 'chair.glb')]);
  r = await open({ view: 'model', path: dir });
  assert.equal(r.status, 404, 'a folder is not a model file');
  r = await open({ view: 'model', path: path.join(dir, 'nope.glb') });
  assert.equal(r.status, 404);
  r = await open({ view: 'app', app: 'no-such-app' });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /no app "no-such-app"/);
  r = await open({ view: 'project', project: 'pr-1', node: 'the toaster' });
  assert.equal(r.status, 404);
  await wait(150);
  assert.deepEqual(A.got.map((e) => e.view), ['url', 'trace', 'project', 'tool', 'model']);
  assert.deepEqual([A.got[0].url, A.got[1].traceId, A.got[2].nodeName, A.got[3].tool, A.got[4].folder], ['https://example.com/report', 'tr-20261022-0123456789ab', 'test-node', 'csv', dir]);
  A.ws.close();
});

test('POST /api/mesh/notify with open: the notice carries action { type: "open", open: <ui-open push> }; a bad target is refused', async () => {
  const dir = path.join(HOME, 'proj', 'out');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'chair.glb'), 'glTF');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const got = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'notify') got.push(m); });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const post = async (body) => { const r = await fetch(`${BASE}/api/mesh/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  let r = await post({ text: 'The chair is ready.', speak: false, from: 'test agent', open: { view: 'model', path: path.join(dir, 'chair.glb'), label: 'Show it' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await wait(150);
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].text, got[0].action.type, got[0].action.label, got[0].action.open.view, got[0].action.open.path, got[0].action.open.type], ['The chair is ready.', 'open', 'Show it', 'model', path.join(dir, 'chair.glb'), 'ui-open']);
  assert.equal('open' in got[0], false, 'the raw open arguments do not travel');
  r = await post({ text: 'x', speak: false, open: { view: 'nope' } });
  assert.equal(r.status, 400);
  r = await post({ text: 'x', speak: false, open: { view: 'model', path: path.join(dir, 'missing.glb') } });
  assert.equal(r.status, 404);
  await wait(100);
  assert.equal(got.length, 1, 'a refused notice is not shown');
  ws.close();
});

test('ui_open through `rigs mcp` (RIGS_TRACE set, as a JARVIS brain has it) opens on the requesting UI', async () => {
  const A = await uiSocket();
  const B = await uiSocket();
  const trace = 'tr-20261020-abcdefabcdef';
  A.ws.send(JSON.stringify({ type: 'claim-trace', traceId: trace }));
  await wait(150);
  const mcp = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'mcp'], { env: { ...env, RIGS_TRACE: `${trace}:sp-abcdefabcdef` }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: mcp.stdout });
  const replies = new Map();
  lines.on('line', (l) => { try { const m = JSON.parse(l); if (m.id !== undefined) replies.set(m.id, m); } catch {} });
  const call = async (id, method, params) => {
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 100 && !replies.has(id); i++) await wait(100);
    return replies.get(id);
  };
  try {
    await call(1, 'initialize', { protocolVersion: '2025-06-18' });
    const list = await call(2, 'tools/list', {});
    assert.ok(list.result.tools.some((t) => t.name === 'ui_open'));
    const res = await call(3, 'tools/call', { name: 'ui_open', arguments: { view: 'files', node: 'self', path: HOME } });
    assert.ok(!res.result.isError, res.result.content[0].text);
    const out = JSON.parse(res.result.content[0].text);
    assert.deepEqual([out.ok, out.path, out.shownOn], [true, HOME, 'requester']);
    await wait(150);
    assert.deepEqual([A.got.length, B.got.length], [1, 0]);
    const bad = await call(4, 'tools/call', { name: 'ui_open', arguments: { view: 'nope' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /unknown view/);
  } finally { mcp.kill(); A.ws.close(); B.ws.close(); }
});

test('C5: this node keeps the last 50 notices it showed (GET /api/local/notify/history) with their Open action; agent-session pop-ups are not kept', async () => {
  const post = (b) => fetch(`${BASE}/api/local/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  for (let i = 0; i < 55; i++) await post({ text: `notice ${i}`, from: 'test', action: i === 54 ? { type: 'open', label: 'Open', open: { type: 'ui-open', view: 'url', url: 'https://example.com/r' } } : null });
  await post({ text: 'a session', session: { id: 's1', kind: 'claude', nodeId: 'n', nodeName: 'test-node' } });
  const r = await fetch(`${BASE}/api/local/notify/history`);
  const rows = await r.json();
  assert.equal(rows.length, 50);
  assert.equal(rows[0].text, 'notice 5');
  assert.equal(rows.at(-1).text, 'notice 54');
  assert.equal(rows.at(-1).action.open.url, 'https://example.com/r');
  assert.ok(rows.every((n) => typeof n.at === 'number' && !n.session));
});
