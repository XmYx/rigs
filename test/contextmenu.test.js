// Context menus: the pure part — which surfaces are under a pointer (ctx-tag.js) and which items each surface offers,
// with which enabled states (ctx-providers.js). No DOM: elements are plain objects, actions are recorded fakes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ctxTargets, nativeCtx, tagCtx } from '../ui/src/ctx-tag.js';
import { createProviders, galaxyTarget, projectStatus, registerJarvisProviders, resolveMenu } from '../ui/src/ctx-providers.js';

/** A stand-in element: dataset + parentElement is all ctx-tag.js looks at. */
const el = (parent = null) => ({ dataset: {}, parentElement: parent });

function recorder() {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  return { calls, rec };
}

const labels = (entries) => entries.filter((e) => !e.sep && !e.header).map((e) => e.label || e.cmd);
const find = (entries, label) => entries.find((e) => e.label === label);
const cmds = (entries) => entries.filter((e) => e.cmd).map((e) => e.cmd);

function setup(extra = {}) {
  const { calls, rec } = recorder();
  const reg = createProviders();
  const deps = {
    copy: rec('copy'),
    layout: { toggleCollapse: rec('collapse'), isCollapsed: () => false, resetPanel: rec('resetPanel'), removed: () => [] },
    window: { toggleMax: rec('max'), isMax: () => false, closeOthers: rec('closeOthers'), closeAll: rec('closeAll'), count: () => 3 },
    app: { key: (a) => `${a.nodeId}/${a.id}`, isOpen: () => false, status: () => 'up', url: (a) => `http://x/${a.id}`, open: rec('app.open'), openTab: rec('app.tab'), reload: rec('app.reload') },
    session: { transcript: rec('transcript'), attach: rec('attach'), chat: rec('chat'), galaxy: rec('galaxy') },
    project: { open: rec('project.open'), act: rec('project.act'), galaxy: rec('project.galaxy') },
    task: { openSession: rec('task.session'), mark: rec('task.mark') },
    node: { get: (n) => n, status: rec('node.status'), terminal: rec('node.terminal'), files: rec('node.files'), screen: rec('node.screen'), sessions: rec('node.sessions'), control: rec('node.control'), ssh: rec('node.ssh') },
    trace: { open: rec('trace.open') },
    galaxy: { select: rec('gx.select'), fit: rec('gx.fit'), hideType: rec('gx.hide'), typeLabel: (t) => t.toUpperCase() },
    ...extra,
  };
  registerJarvisProviders(reg, deps);
  return { reg, calls, deps };
}

// ------------------------------------------------------------------ finding the surfaces

test('ctxTargets walks up from the pointer, innermost first, and reads the tag', () => {
  const win = tagCtx(el(), 'window', '7', { title: 'Sessions' });
  const row = tagCtx(el(win), 'session', 's1', { s: 1 });
  const cell = el(row);
  const { native, targets } = ctxTargets(cell, 10, 20);
  assert.equal(native, false);
  assert.deepEqual(targets.map((t) => [t.kind, t.id]), [['session', 's1'], ['window', '7']]);
  assert.deepEqual(targets[0].data, { s: 1 });
  assert.equal(targets[1].el, win);
});

test('an untagged page has no targets; data-ctx="native" keeps the browser menu for its subtree only when innermost', () => {
  assert.deepEqual(ctxTargets(el(el()), 0, 0), { native: false, targets: [] });
  const win = tagCtx(el(), 'window', '1', null);
  const text = nativeCtx(el(win));
  assert.equal(ctxTargets(el(text), 0, 0).native, true);
  assert.deepEqual(ctxTargets(el(text), 0, 0).targets, []);
  assert.equal(ctxTargets(win, 0, 0).native, false);
});

test('a canvas surface answers with _ctxAt(x, y): the node under the pointer comes before the surface itself', () => {
  const galaxy = tagCtx(el(), 'galaxy', null, null);
  galaxy._ctxAt = (x) => (x === 5 ? { kind: 'gnode', id: 'n1', data: { name: 'n' } } : null);
  assert.deepEqual(ctxTargets(galaxy, 5, 5).targets.map((t) => t.kind), ['gnode', 'galaxy']);
  assert.deepEqual(ctxTargets(galaxy, 9, 9).targets.map((t) => t.kind), ['galaxy']);
  galaxy._ctxAt = () => { throw new Error('boom'); };
  assert.deepEqual(ctxTargets(galaxy, 1, 1).targets.map((t) => t.kind), ['galaxy']);
});

// ------------------------------------------------------------------ sessions

test('session: items follow its kind and liveness; a row inside a window adds the window group under headers', () => {
  const { reg, calls } = setup();
  const n = { id: 'n1', name: 'ubuntu', sshAlias: 'ub' };
  const live = { id: 'abc', kind: 'claude', live: true, cwd: '/w' };
  const menu = resolveMenu(reg, [{ kind: 'session', id: 'abc', data: { node: n, s: live } }, { kind: 'window', id: '3', data: { title: 'Sessions' } }]);
  assert.deepEqual(menu.filter((e) => e.header).map((e) => e.header), ['Session', 'Window']);
  assert.deepEqual(labels(menu).slice(0, 5), ['Open transcript', 'Attach terminal', 'Send message…', 'Show in galaxy', 'Copy session id']);
  assert.ok(find(menu, 'Copy ssh resume command'));
  find(menu, 'Copy ssh resume command').run();
  assert.deepEqual(calls.at(-1), ['copy', 'ssh ub -t "cd /w && claude --resume abc"', 'Resume command']);
  find(menu, 'Attach terminal').run();
  assert.deepEqual(calls.at(-1).slice(0, 2), ['attach', n]);

  const idle = resolveMenu(reg, [{ kind: 'session', id: 'x', data: { node: n, s: { id: 'x', kind: 'tmux', live: false } } }]);
  assert.ok(find(idle, 'Resume in terminal'));
  assert.equal(find(idle, 'Copy ssh resume command'), undefined, 'only Claude and Codex sessions have a resume command');
  const chat = resolveMenu(reg, [{ kind: 'session', id: 'c', data: { node: n, s: { id: 'c', kind: 'chat' } } }]);
  assert.ok(find(chat, 'Continue with JARVIS'));
  assert.equal(find(chat, 'Send message…'), undefined);
});

// ------------------------------------------------------------------ panels, windows, apps

test('panel: hide / hide others / remove are the shared commands with the panel as argument; Dock only when the engine has it', () => {
  const { reg, calls } = setup();
  const panel = { kind: 'panel', id: 'usage', data: { id: 'usage', title: 'Tokens & time' } };
  const menu = resolveMenu(reg, [panel]);
  assert.deepEqual(labels(menu), ['Collapse', 'Reset position and size', 'Hide', 'Hide other panels', 'Remove (undoable)']);
  assert.deepEqual(cmds(menu), ['window.hide', 'window.hideOthers', 'window.remove']);
  const remove = menu.find((e) => e.cmd === 'window.remove');
  assert.deepEqual(remove.args, { kind: 'panel', id: 'usage', title: 'Tokens & time', open: true });
  assert.match(remove.label, /undoable/);
  find(menu, 'Collapse').run();
  assert.deepEqual(calls.at(-1), ['collapse', 'usage']);

  const docking = setup({ layout: { canDock: () => true, isDocked: () => true, float: () => {}, dock: () => {}, isCollapsed: () => true, toggleCollapse: () => {}, resetPanel: () => {} } });
  const m2 = resolveMenu(docking.reg, [panel]);
  assert.ok(find(m2, 'Float') && !find(m2, 'Dock'));
  assert.ok(find(m2, 'Expand'));
});

test('window: Close others / Close all are disabled when there is nothing else to close', () => {
  const many = resolveMenu(setup().reg, [{ kind: 'window', id: '2', data: { title: 'Files' } }]);
  assert.equal(find(many, 'Close other windows').disabled, false);
  const lone = resolveMenu(setup({ window: { count: () => 1, closeOthers: () => {}, closeAll: () => {}, toggleMax: () => {}, isMax: () => true } }).reg, [{ kind: 'window', id: '2', data: {} }]);
  assert.equal(find(lone, 'Close other windows').disabled, true);
  assert.ok(find(lone, 'Restore size'), 'a maximized window offers Restore size');
  assert.deepEqual(cmds(lone), ['window.open', 'window.hide']);
});

test('app: Reload needs an open window; Remove is the reversible command; Open turns into Start & open for an app that is down', () => {
  const app = { id: 'krea', name: 'Krea', node: 'ubuntu', nodeId: 'n1', health: { status: 'up' } };
  const closed = resolveMenu(setup().reg, [{ kind: 'app', id: 'n1/krea', data: { app } }]);
  assert.equal(find(closed, 'Reload').disabled, true);
  assert.ok(find(closed, 'Open'));
  const remove = closed.find((e) => e.cmd === 'window.remove');
  assert.deepEqual(remove.args, { kind: 'app', id: 'n1/krea', title: 'Krea', icon: undefined, node: 'ubuntu', open: false });
  assert.match(remove.label, /undoable/);

  const opened = setup({ app: { key: (a) => `${a.nodeId}/${a.id}`, isOpen: () => true, status: () => 'down', open() {}, reload() {}, openTab() {}, url: () => 'u' } });
  const m = resolveMenu(opened.reg, [{ kind: 'app', id: 'n1/krea', data: { app } }]);
  assert.equal(find(m, 'Reload').disabled, false);
  assert.ok(find(m, 'Focus'));
  const down = resolveMenu(setup({ app: { key: (a) => a.id, isOpen: () => false, status: () => 'down', open() {} } }).reg, [{ kind: 'app', id: 'k', data: { app } }]);
  assert.ok(find(down, 'Start & open'));
  assert.equal(find(down, 'Copy URL'), undefined, 'no URL dependency, no item');
});

test('a row inside its own window opens things in place instead of through the global opener', () => {
  const { reg, calls } = setup();
  const n = { id: 'n1', name: 'ubuntu' };
  const inWindow = resolveMenu(reg, [{ kind: 'session', id: 'a', data: { node: n, s: { id: 'a', kind: 'tmux' }, transcript: () => calls.push(['in-window']) } }]);
  find(inWindow, 'Open transcript').run();
  assert.deepEqual(calls.at(-1), ['in-window']);
  const project = resolveMenu(reg, [{ kind: 'project', id: 'p', data: { id: 'p', status: 'running', open: () => calls.push(['project-in-window']) } }]);
  find(project, 'Open').run();
  assert.deepEqual(calls.at(-1), ['project-in-window']);
  const task = resolveMenu(reg, [{ kind: 'task', id: 'p/t', data: { task: { id: 't', status: 'todo' }, project: { id: 'p' }, openProject: () => calls.push(['raise']) } }]);
  find(task, 'Open project').run();
  assert.deepEqual(calls.at(-1), ['raise']);
});

test('app store card: install, update, uninstall follow the install state', () => {
  const a = { id: 'comfy', name: 'ComfyUI' };
  const run = (data) => resolveMenu(setup().reg, [{ kind: 'storeapp', id: a.id, data: { app: a, actions: { open() {}, install() {}, cancel() {}, uninstall() {} }, ...data } }]);
  assert.deepEqual(labels(run({ state: 'not-installed' })), ['Install', 'Copy app id']);
  assert.equal(find(run({ state: 'not-installed', fits: false }), 'Install').disabled, true);
  assert.deepEqual(labels(run({ state: 'installed', updateAvailable: true })), ['Open', 'Update', 'Uninstall…', 'Copy app id']);
  assert.equal(find(run({ state: 'installed' }), 'Uninstall…').danger, true);
  assert.deepEqual(labels(run({ state: 'busy' })), ['Cancel install', 'Copy app id']);
  assert.ok(find(run({ state: 'failed' }), 'Retry install'));
});

// ------------------------------------------------------------------ projects, tasks, machines

test('project: Pause for a running one, Resume for a paused one, Dispatch off when done or paused; acts then refreshes its window', async () => {
  const { reg, calls } = setup();
  let refreshed = 0;
  const base = { id: 'p1', name: 'Menus', ownerId: 'n1', refresh: () => { refreshed++; } };
  const run = (status) => resolveMenu(reg, [{ kind: 'project', id: 'p1', data: { ...base, status } }]);
  assert.equal(find(run('running'), 'Pause').disabled, false);
  assert.equal(find(run('done'), 'Pause').disabled, true);
  assert.equal(find(run('done'), 'Dispatch ready tasks').disabled, true);
  const paused = run('paused');
  assert.equal(find(paused, 'Pause'), undefined);
  assert.equal(find(paused, 'Dispatch ready tasks').disabled, true);
  await find(paused, 'Resume').run();
  assert.equal(calls.at(-1)[0], 'project.act');
  assert.equal(calls.at(-1)[2], 'resume');
  assert.equal(refreshed, 1);
  assert.equal(projectStatus({ running: [1] }), 'running');
  assert.equal(projectStatus({ blocked: true, running: [1] }), 'blocked');
  assert.equal(projectStatus({}), 'planned');
  assert.equal(projectStatus({ status: 'paused' }), 'paused');
});

test('task: Open agent session needs a run; Mark done is off for a done task; Back to todo only for finished or stuck ones', async () => {
  const { reg, calls } = setup();
  const project = { id: 'p1', name: 'Menus', status: 'running', ownerId: 'n1' };
  const menu = (task) => resolveMenu(reg, [{ kind: 'task', id: `p1/${task.id}`, data: { task, project } }]);
  const todo = menu({ id: 't1', status: 'todo' });
  assert.equal(find(todo, 'Open agent session').disabled, true);
  assert.equal(find(todo, 'Back to todo (re-run)').disabled, true);
  assert.equal(find(todo, 'Mark done').disabled, false);
  const failed = menu({ id: 't2', status: 'failed', run: { session: { kind: 'tmux', id: 'x' } } });
  assert.equal(find(failed, 'Open agent session').disabled, false);
  assert.equal(find(failed, 'Back to todo (re-run)').disabled, false);
  assert.equal(find(menu({ id: 't3', status: 'done' }), 'Mark done').disabled, true);
  await find(failed, 'Back to todo (re-run)').run();
  assert.equal(calls.at(-1)[0], 'task.mark');
  assert.equal(calls.at(-1)[3], 'todo');
});

test('machine: actions need it online; a partial desktops-tile node is completed through node.get', () => {
  const full = { id: 'n1', name: 'ubuntu', online: true, rigs: true };
  const up = resolveMenu(setup().reg, [{ kind: 'node', id: 'n1', data: { node: full } }]);
  assert.ok(['Open terminal', 'Files', 'Screen (live desktop)', 'Sessions', 'Access & control…'].every((l) => find(up, l).disabled === false));
  const down = resolveMenu(setup().reg, [{ kind: 'node', id: 'n1', data: { node: { ...full, online: false } } }]);
  assert.ok(['Open terminal', 'Files', 'Screen (live desktop)'].every((l) => find(down, l).disabled === true));
  assert.equal(find(down, 'Show status').disabled, undefined);
  const tile = setup({ node: { get: () => ({ ...full, online: false }), terminal() {} } });
  assert.equal(find(resolveMenu(tile.reg, [{ kind: 'node', id: 'n1', data: { node: { id: 'n1', name: 'ubuntu' } } }]), 'Open terminal').disabled, true);
});

test('creating agents: a machine offers New agent (and by kind), a session its folder, an agent node its kind, a project its folder', async () => {
  const { reg, calls } = setup({
    node: { get: (n) => n, status() {}, newAgent: (m, k) => calls.push(['newAgent', m.id, k]) },
    session: { transcript() {}, newHere: (n, s) => calls.push(['newHere', n.id, s.cwd]) },
    galaxy: { select() {}, newSession: (n) => calls.push(['newSession', n.agent]), newInProject: (n) => calls.push(['newInProject', n.id]) },
  });
  const m = { id: 'n1', name: 'mac', online: true, rigs: true, tools: { claude: '2.1', codex: '0.9' } };
  const menu = resolveMenu(reg, [{ kind: 'node', id: 'n1', data: { node: m } }]);
  assert.equal(find(menu, 'New agent…').disabled, false);
  await find(menu, 'New agent…').run();
  assert.deepEqual(calls.at(-1), ['newAgent', 'n1', undefined]);
  const kinds = find(menu, 'New agent of kind').submenu();
  assert.deepEqual(labels(kinds), ['Claude Code…', 'Codex…'], 'only the agents the machine has');
  await kinds[1].run();
  assert.deepEqual(calls.at(-1), ['newAgent', 'n1', 'codex']);
  const down = resolveMenu(reg, [{ kind: 'node', id: 'n1', data: { node: { ...m, online: false } } }]);
  assert.equal(find(down, 'New agent…').disabled, true);
  assert.equal(find(down, 'New agent of kind'), undefined);
  assert.equal(find(resolveMenu(setup().reg, [{ kind: 'node', id: 'n1', data: { node: m } }]), 'New agent…'), undefined, 'left out without the dep');

  const sm = resolveMenu(reg, [{ kind: 'session', id: 'x', data: { node: m, s: { kind: 'tmux', id: 'x', cwd: '/w/app' } } }]);
  await find(sm, 'New agent in this folder…').run();
  assert.deepEqual(calls.at(-1), ['newHere', 'n1', '/w/app']);
  assert.equal(find(resolveMenu(reg, [{ kind: 'session', id: 'c', data: { node: m, s: { kind: 'chat', id: 'c' } } }]), 'New agent in this folder…'), undefined, 'a JARVIS chat has no folder');

  await find(resolveMenu(reg, [{ kind: 'gnode', id: 'a:n1:codex', data: { id: 'a:n1:codex', type: 'agent', agent: 'codex', name: 'Codex' } }]), 'New Codex session…').run();
  assert.deepEqual(calls.at(-1), ['newSession', 'codex']);
  await find(resolveMenu(reg, [{ kind: 'gnode', id: 'p:app', data: { id: 'p:app', type: 'project', name: 'app' } }]), 'New agent in this project…').run();
  assert.deepEqual(calls.at(-1), ['newInProject', 'p:app']);
});

test('station: a node gets its off-floor things by type and Show the whole station; empty floor gets the background menu', async () => {
  const { reg, calls } = setup({ station: { select: (id) => calls.push(['st.select', id]), fit: () => calls.push(['st.fit']) } });
  const more = [{ label: 'Models', items: [{ id: 'o:n1:llama', name: 'llama' }] }, { label: 'Apps', items: [] }];
  const m = { id: 'n1', name: 'mac', online: true, rigs: true };
  const menu = resolveMenu(reg, [{ kind: 'node', id: 'n1', data: { node: m } }, { kind: 'station', id: 'm:n1', data: { node: { id: 'm:n1' }, more } }]);
  assert.ok(menu.some((e) => e.header === 'Machine') && menu.some((e) => e.header === 'Station'), 'two titled groups');
  assert.equal(find(menu, 'Apps (0)'), undefined, 'an empty group is left out');
  const models = find(menu, 'Models (1)').submenu();
  await models[0].run();
  assert.deepEqual(calls.at(-1), ['st.select', 'o:n1:llama']);
  await find(menu, 'Show the whole station').run();
  assert.deepEqual(calls.at(-1), ['st.fit']);
  const bg = resolveMenu(reg, [{ kind: 'station', id: null, data: { node: null } }]);
  assert.equal(labels(bg)[0], 'Show the whole station');
  assert.ok(cmds(bg).includes('window.showAll'), 'then the usual background items');
});

// ------------------------------------------------------------------ files and traces

test('file: a folder opens, a file previews and downloads; trash is flagged dangerous; Copy to machine is a submenu', () => {
  const { reg, calls } = setup();
  const actions = { open() {}, download() {}, rename() {}, trash() {}, copyTo: (e, m) => calls.push(['copyTo', e.name, m.name]), terminalHere: (p) => calls.push(['term', p]) };
  const machines = [{ id: 'n2', name: 'mac' }];
  const menuOf = (data) => resolveMenu(reg, [{ kind: 'file', id: data.entry.path, data }]);
  const file = menuOf({ entry: { type: 'file', name: 'a.txt', path: '/home/u/a.txt' }, actions, machines });
  assert.deepEqual(labels(file), ['Preview', 'Download', 'Copy path', 'Terminal here', 'Copy to machine', 'Rename…', 'Move to trash…']);
  assert.equal(find(file, 'Move to trash…').danger, true);
  find(file, 'Terminal here').run();
  assert.deepEqual(calls.at(-1), ['term', '/home/u'], 'a file opens its folder in the terminal');
  find(file, 'Copy to machine').submenu()[0].run();
  assert.deepEqual(calls.at(-1), ['copyTo', 'a.txt', 'mac']);
  const dir = menuOf({ entry: { type: 'dir', name: 'src', path: '/home/u/src' }, actions, machines });
  assert.deepEqual(labels(dir), ['Open folder', 'Copy path', 'Terminal here', 'Rename…', 'Move to trash…']);
});

test('folder background and traces', () => {
  const { reg, calls } = setup();
  let hidden = false;
  const folder = resolveMenu(reg, [{ kind: 'folder', id: 'n1', data: { path: '/home/u', actions: { newFolder() {}, upload() {}, refresh() {}, terminalHere() {}, toggleHidden: () => { hidden = !hidden; }, showHidden: () => hidden } } }]);
  assert.deepEqual(labels(folder), ['New folder…', 'Upload files here…', 'Refresh', 'Terminal here', 'Show hidden files', 'Copy folder path']);
  assert.equal(find(folder, 'Show hidden files').checked, false);
  const trace = resolveMenu(reg, [{ kind: 'trace', id: 'tr-1', data: { traceId: 'tr-1', summary: { request: 'dark mode' } } }]);
  assert.deepEqual(labels(trace), ['Open request', 'Copy trace id', 'Copy request text']);
  find(trace, 'Copy trace id').run();
  assert.deepEqual(calls.at(-1), ['copy', 'tr-1', 'Trace id']);
});

// ------------------------------------------------------------------ background, galaxy, selection

test('the empty background (no target) shows the desktop menu; removed items become a Restore submenu', () => {
  const none = resolveMenu(setup().reg, []);
  assert.deepEqual(cmds(none), ['file.openApp', 'file.newProject', 'file.openSession', 'window.showAll', 'window.reset', 'view.menubar', 'edit.settings', 'edit.display']);
  const removedItem = { kind: 'app', id: 'n1/krea', label: 'Krea', icon: '▦' };
  const withGone = resolveMenu(setup({ layout: { removed: () => [removedItem] } }).reg, []);
  const sub = find(withGone, 'Removed items (1)').submenu();
  assert.deepEqual(sub.filter((e) => e.cmd).map((e) => [e.cmd, e.args?.id]), [['window.restore', 'n1/krea'], ['window.restoreAll', undefined]]);
  assert.equal(find(none, 'Removed items').submenu()[0].disabled, true);
});

test('galaxy: empty space gets Reset view + the desktop menu; a node gets its own menu and not the desktop one', () => {
  const { reg, calls } = setup();
  const galaxy = { kind: 'galaxy', id: null, data: null };
  const bg = resolveMenu(reg, [galaxy]);
  assert.equal(bg[0].label, 'Reset galaxy view');
  assert.ok(cmds(bg).includes('window.showAll'));
  find(bg, 'Reset galaxy view').run();
  assert.deepEqual(calls.at(-1), ['gx.fit']);

  const node = resolveMenu(reg, [{ kind: 'gnode', id: 'tool:1', data: { id: 'tool:1', type: 'tool', name: 'ComfyUI' } }, galaxy]);
  assert.deepEqual(labels(node), ['Focus', 'Hide all “TOOL” nodes', 'Copy name']);
  assert.equal(cmds(node).length, 0, 'the galaxy provider yields to a node under the pointer');
});

test('galaxyTarget maps node types onto the shared surfaces', () => {
  const machine = { id: 'n1', name: 'ubuntu' };
  const byId = (id) => (id === 'n1' ? machine : undefined);
  assert.deepEqual(galaxyTarget({ type: 'machine', machine: 'n1', data: machine }), { kind: 'node', id: 'n1', data: { node: machine } });
  assert.equal(galaxyTarget({ type: 'app', app: { id: 'k', nodeId: 'n1' } }).id, 'n1/k');
  const s = galaxyTarget({ type: 'live', id: 's:1', machine: 'n1', session: { id: 'abc', kind: 'claude' } }, { machineById: byId });
  assert.equal(s.kind, 'session');
  assert.equal(s.data.node, machine);
  assert.equal(galaxyTarget({ type: 'session', id: 's:2', machine: 'gone', session: { id: 'z' } }, { machineById: byId }).kind, 'gnode', 'a session on an unknown machine falls back to the generic node menu');
  assert.deepEqual(galaxyTarget({ type: 'plan', owner: 'n1', plan: { id: 'p1', name: 'Menus', status: 'running' } }).data, { id: 'p1', name: 'Menus', status: 'running', ownerId: 'n1' });
  const task = galaxyTarget({ type: 'task', owner: 'n1', task: { id: 't1' }, plan: { id: 'p1', name: 'Menus' } });
  assert.equal(task.kind, 'task');
  assert.equal(task.data.project.ownerId, 'n1');
  assert.equal(galaxyTarget({ type: 'skill', id: 'skill:rea', name: 'REA' }).kind, 'gnode');
  assert.equal(galaxyTarget(null), null);
});

test('a selection under the pointer puts Copy on top', () => {
  const { calls, reg } = setup();
  const copy = (...a) => calls.push(['sel', ...a]);
  const menu = resolveMenu(reg, [], { selection: 'the quick brown fox jumps over the lazy dog', copy });
  assert.match(menu[0].label, /^Copy “the quick brown fox jumps o…”$/);
  assert.equal(menu[1].sep, true);
  menu[0].run();
  assert.deepEqual(calls.at(-1), ['sel', 'the quick brown fox jumps over the lazy dog', 'Selection']);
});

// ------------------------------------------------------------------ robustness

test('unknown kinds, throwing providers and missing actions never break the menu', () => {
  const reg = createProviders();
  reg.register('boom', () => { throw new Error('x'); });
  reg.register('empty', () => [null, { sep: true }]);
  reg.register('ok', () => [{ label: 'Fine', run() {} }]);
  assert.deepEqual(labels(resolveMenu(reg, [{ kind: 'nope' }, { kind: 'boom' }, { kind: 'empty' }, { kind: 'ok', id: 1 }])), ['Fine']);
  assert.deepEqual(resolveMenu(reg, [{ kind: 'nope' }]), [], 'nothing to show and no desktop provider: an empty menu (the listener then leaves the native one)');
  const bare = createProviders();
  registerJarvisProviders(bare, {});
  const m = resolveMenu(bare, [{ kind: 'session', id: 'a', data: { node: { id: 'n', name: 'x' }, s: { id: 'a', kind: 'tmux' } } }]);
  assert.ok(!m.some((e) => e.label === 'Open transcript'), 'no action wired, no session item');
  assert.ok(cmds(m).includes('file.openApp'), 'the empty session group falls back to the desktop menu');
});

test('every command a provider references exists in jarvis-commands.js', () => {
  const src = fs.readFileSync(new URL('../ui/src/jarvis-commands.js', import.meta.url), 'utf8');
  const known = new Set([...src.matchAll(/id: '([\w.]+)'/g)].map((m) => m[1]));
  const { reg } = setup({ layout: { removed: () => [{ kind: 'panel', id: 'x', label: 'x' }], canDock: () => true, dock() {}, float() {}, toggleCollapse() {}, resetPanel() {} } });
  const used = new Set();
  const collect = (entries) => { for (const e of entries) { if (e.cmd) used.add(e.cmd); if (e.submenu) collect(e.submenu()); } };
  const app = { id: 'a', name: 'A', nodeId: 'n' };
  for (const t of [
    { kind: 'desktop' }, { kind: 'panel', id: 'p', data: { id: 'p' } }, { kind: 'window', id: '1', data: {} }, { kind: 'app', id: 'n/a', data: { app } },
    { kind: 'galaxy' },
  ]) collect(resolveMenu(reg, [t]));
  assert.ok(used.size >= 8);
  for (const c of used) assert.ok(known.has(c), `${c} is not a registered command`);
});
