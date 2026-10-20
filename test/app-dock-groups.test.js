// App dock default groups (ui/src/app-dock-state.js + app-dock-model.js): the toolbar functions as `tool` items seeded
// from one table into named groups, applets grouped by App Cloud category or host machine, rigs into "Machines", new
// ones joining their group by themselves — and never against the user: an item once placed is never pulled into a
// default group again, a dissolved default group is not re-created, and v1 saved docks keep their arrangement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const S = await import('../ui/src/app-dock-state.js');
const M = await import('../ui/src/app-dock-model.js');

const applet = (id, node = 'mac', extra = {}) => ({ node, nodeName: `${node} box`, id, name: id.toUpperCase(), icon: '▣', ...extra });
const rig = (id, online = true) => ({ id, name: `node ${id}`, online, rigs: true });
const A = (id, node = 'mac') => S.itemId('applet', `${node}/${id}`);
const T = (id) => S.itemId('tool', id);
const view = (s) => S.dockView(s).map((v) => (v.type === 'group' ? `[${v.group.name}:${v.items.map((i) => i.id).join(',')}]` : v.item.id));
const groupIds = (s) => s.order.filter((e) => e.type === 'group').map((e) => e.id);
const fresh = (sources = {}) => S.mergeSources(S.emptyState(), { tools: S.TOOLS, ...sources });

/** Same invariant as app-dock-state.test.js: every item placed exactly once, nothing dangling. */
function check(s) {
  const seen = [];
  for (const e of s.order) if (e.type === 'item') { assert.ok(s.items[e.id]); seen.push(e.id); } else assert.ok(s.groups[e.id]);
  for (const g of Object.values(s.groups)) for (const id of g.items) { assert.ok(s.items[id]); seen.push(id); }
  assert.deepEqual([...seen].sort(), Object.keys(s.items).sort());
  return s;
}

test('the table: 3–5 named groups covering every #bar button exactly once, each tool with id, title, icon, action, button', () => {
  assert.ok(S.TOOL_GROUPS.length >= 3 && S.TOOL_GROUPS.length <= 5);
  assert.deepEqual(S.TOOL_GROUPS.map((g) => g.name), ['This machine', 'Work', 'Insight', 'System']);
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const bar = html.slice(html.indexOf('<nav id="bar"'), html.indexOf('</nav>', html.indexOf('<nav id="bar"')));
  const buttons = [...bar.matchAll(/<button id="([\w-]+)"/g)].map((m) => m[1]);
  assert.equal(buttons.length, 15);
  assert.deepEqual(S.TOOLS.map((t) => t.button).sort(), [...buttons].sort(), 'one tool per toolbar button, none missing, none extra');
  assert.equal(new Set(S.TOOLS.map((t) => t.id)).size, S.TOOLS.length, 'tool ids are unique');
  for (const t of S.TOOLS) {
    assert.ok(t.title && t.icon && t.hint, t.id);
    assert.equal(t.action, t.id, 'the action key is the tool id');
    assert.equal(t.button, `btn-${t.id}`);
  }
  const of = (id) => S.TOOL_GROUPS.find((g) => g.tools.some((t) => t.id === id)).name;
  assert.deepEqual(['term', 'files', 'desk'].map(of), ['This machine', 'This machine', 'This machine']);
  assert.deepEqual(['proj', 'work', 'ask', 'agents', 'sess'].map(of), Array(5).fill('Work'));
  assert.deepEqual(['usage', 'traces', 'graphify', 'desktops'].map(of), Array(4).fill('Insight'));
  assert.deepEqual(['apps', 'mesh', 'mute'].map(of), Array(3).fill('System'));
  assert.deepEqual(S.TOOLS.filter((t) => t.badge).map((t) => t.id), ['ask', 'agents']);
  assert.deepEqual(S.TOOLS.filter((t) => t.toggle).map((t) => t.id), ['mute']);
  assert.ok(Object.isFrozen(S.TOOL_GROUPS) && Object.isFrozen(S.TOOLS[0]), 'the table cannot be changed by accident');
});

test('tool items: kind tool, stable id tool:<name>, title, icon and the action/button in ref', () => {
  const it = S.toItem('tool', S.TOOLS.find((t) => t.id === 'mute'));
  assert.equal(it.id, 'tool:mute');
  assert.equal(it.kind, 'tool');
  assert.equal(it.title, 'Voice');
  assert.equal(it.icon, '🔊');
  assert.deepEqual(it.ref, { action: 'mute', button: 'btn-mute', hint: 'Voice output on/off', toggle: true });
  assert.ok(S.KINDS.includes('tool'));
  assert.equal(S.toItem('tool', { title: 'no id' }), null);
  const s = S.addItem(S.emptyState(), S.toItem('tool', { id: 'term', title: 'Terminal' }));
  assert.ok(s.items['tool:term'], 'addItem takes the tool kind');
  assert.ok(S.deserialize(S.serialize(s)).items['tool:term'], 'and the stored state keeps it');
});

test('a fresh dock: tools seeded into their four groups in table order, then app groups and Machines', () => {
  const s = check(fresh({ applets: [applet('krea'), applet('fuel', 'lin')], rigs: [rig('mac'), rig('lin')] }));
  assert.deepEqual(view(s), [
    '[This machine:tool:term,tool:files,tool:desk]',
    '[Work:tool:ask,tool:agents,tool:proj,tool:work,tool:sess]',
    '[Insight:tool:usage,tool:traces,tool:graphify,tool:desktops]',
    '[System:tool:apps,tool:mesh,tool:mute]',
    `[mac box:${A('krea')}]`,
    `[lin box:${A('fuel', 'lin')}]`,
    '[Machines:rig:mac,rig:lin]',
  ]);
  assert.deepEqual(groupIds(s).slice(0, 4), S.TOOL_GROUPS.map((g) => g.id));
  assert.equal(S.mergeSources(s, { tools: S.TOOLS, applets: [applet('krea'), applet('fuel', 'lin')], rigs: [rig('mac'), rig('lin')] }).order.length, s.order.length, 'a refresh adds nothing');
});

test('applets group by App Cloud category when they have one, else by host machine (named after it)', () => {
  const s = check(fresh({ applets: [applet('krea', 'mac', { category: 'Media' }), applet('flux', 'lin', { category: 'Media' }), applet('notes'), applet('bare', 'x', { nodeName: '' })] }));
  assert.deepEqual(s.groups['g-cat-media'].items, [A('krea'), A('flux', 'lin')], 'same category on two machines → one group');
  assert.equal(s.groups['g-cat-media'].name, 'Media');
  assert.deepEqual(s.groups['g-node-mac'].items, [A('notes')]);
  assert.equal(s.groups['g-node-mac'].name, 'mac box');
  assert.equal(s.groups['g-node-x'].name, 'x', 'no machine name → the node id');
  assert.deepEqual(S.defaultGroupOf(S.toItem('panel', { id: 'chat' })), null, 'panels, windows and terminals have no default group');
});

test('sourcesFromSnapshot carries the category and the machine name the default groups need', () => {
  const src = M.sourcesFromSnapshot([{ node: { id: 'n1', name: 'macbookpro', online: true, rigs: true }, apps: [{ id: 'a', name: 'A', category: 'Media' }, { id: 'b' }] }]);
  assert.deepEqual(src.applets, [
    { node: 'n1', nodeName: 'macbookpro', id: 'a', name: 'A', icon: '', category: 'Media' },
    { node: 'n1', nodeName: 'macbookpro', id: 'b', name: 'b', icon: '' },
  ]);
  const s = S.mergeSources(S.emptyState(), src);
  assert.deepEqual(view(s), [`[Media:applet:n1/a]`, `[macbookpro:applet:n1/b]`, '[Machines:rig:n1]']);
});

test('a new applet or rig joins its default group by itself, at the end of it', () => {
  let s = fresh({ applets: [applet('krea')], rigs: [rig('mac')] });
  s = check(S.mergeSources(s, { applets: [applet('krea'), applet('notes'), applet('fuel', 'lin')], rigs: [rig('mac'), rig('lin')] }));
  assert.deepEqual(s.groups['g-node-mac'].items, [A('krea'), A('notes')]);
  assert.deepEqual(s.groups['g-node-lin'].items, [A('fuel', 'lin')], 'a new machine gets its own app group');
  assert.deepEqual(s.groups['g-machines'].items, ['rig:mac', 'rig:lin']);
  assert.equal(groupIds(s).at(-1), 'g-node-lin', 'a new group goes to the end');
});

test('a renamed or re-ordered default group keeps receiving its members; an emptied one too', () => {
  let s = fresh({ rigs: [rig('mac')] });
  s = S.renameGroup(s, 'g-machines', 'My boxes');
  s = S.reorder(s, 'group', 'g-machines', 0);
  s = S.moveItem(s, 'rig:mac', { group: null }); // the user takes the only rig out
  s = check(S.mergeSources(s, { rigs: [rig('mac'), rig('lin')] }));
  assert.equal(s.order[0].id, 'g-machines');
  assert.equal(s.groups['g-machines'].name, 'My boxes');
  assert.deepEqual(s.groups['g-machines'].items, ['rig:lin']);
  assert.equal(s.order.at(-1).id, 'rig:mac', 'the one the user took out stays out');
});

test('never override: moved, ungrouped, hidden or re-grouped items stay where the user put them — even after they vanish and return', () => {
  let s = fresh({ applets: [applet('krea'), applet('notes'), applet('maps')], rigs: [rig('mac'), rig('lin')] });
  s = S.moveItem(s, A('krea'), { group: null, index: 0 }); // taken out to the top level
  s = S.moveItem(s, A('notes'), { group: 'g-tools-work' }); // moved into another group
  s = S.setHidden(s, 'rig:lin');
  s = S.moveItem(s, T('mute'), { group: null }); // a tool taken out
  const arranged = s;
  // a refresh with everything present changes nothing
  assert.equal(JSON.stringify(S.mergeSources(s, { tools: S.TOOLS, applets: [applet('krea'), applet('notes'), applet('maps')], rigs: [rig('mac'), rig('lin')] })), JSON.stringify(s));
  // everything goes away (machine asleep, app stopped) …
  s = S.mergeSources(s, { applets: [], rigs: [] });
  assert.equal(Object.keys(s.items).filter((id) => !id.startsWith('tool:')).length, 0);
  assert.ok(s.groups['g-node-mac'] && s.groups['g-machines'], 'default groups stay, empty');
  // … and comes back (in any order): every item returns to the spot it left — its group or its top-level place — and
  // the hidden one stays hidden
  s = check(S.mergeSources(s, { applets: [applet('maps'), applet('notes'), applet('krea')], rigs: [rig('lin'), rig('mac')] }));
  for (const id of [A('krea'), A('notes'), A('maps'), 'rig:mac', 'rig:lin']) assert.equal(M.groupOf(s, id)?.id ?? null, M.groupOf(arranged, id)?.id ?? null, `${id} is back in the group it left`);
  assert.deepEqual(s.order, arranged.order, 'the top level is as it was');
  for (const [gid, g] of Object.entries(arranged.groups)) assert.deepEqual(s.groups[gid].items, g.items, `${gid} has its members back in order`);
  assert.equal(s.items['rig:lin'].hidden, true, 'hidden before it went → hidden when it returns');
  assert.equal(s.items['rig:mac'].hidden, false);
  assert.equal(M.groupOf(s, T('mute')), null);
  assert.equal(M.groupOf(s, A('notes')).id, 'g-tools-work');
  // a never-seen applet still joins its group
  s = S.mergeSources(s, { applets: [applet('krea'), applet('notes'), applet('maps'), applet('new')] });
  assert.deepEqual(s.groups['g-node-mac'].items, [A('maps'), A('new')], 'after the returning one, at the end of its group');
});

test('items that leave together (a machine updating) come back in their own order, whichever returns first', () => {
  let s = fresh({ applets: [applet('krea'), applet('notes'), applet('maps')], rigs: [rig('mac'), rig('lin')] });
  s = S.moveItem(s, 'rig:lin', { group: null, index: 1 });
  s = S.moveItem(s, 'rig:mac', { group: null, index: 2 }); // top level: …, lin, mac, …
  const arranged = s;
  const gone = S.mergeSources(s, { applets: [], rigs: [] });
  for (const back of [[['krea', 'notes', 'maps'], ['lin', 'mac']], [['maps', 'notes', 'krea'], ['mac', 'lin']]]) {
    let t = gone;
    for (let n = 1; n <= back[0].length; n++) t = S.mergeSources(t, { applets: back[0].slice(0, n).map((a) => applet(a)) }); // one by one
    t = S.mergeSources(t, { applets: back[0].map((a) => applet(a)), rigs: [rig(back[1][0])] });
    t = check(S.mergeSources(t, { applets: back[0].map((a) => applet(a)), rigs: [rig('mac'), rig('lin')] }));
    assert.deepEqual(t.order, arranged.order, `top level as it was (back: ${back[1]})`);
    assert.deepEqual(t.groups['g-node-mac'].items, arranged.groups['g-node-mac'].items, `group order as it was (back: ${back[0]})`);
  }
  assert.deepEqual(S.deserialize(S.serialize(gone)).placed, gone.placed, 'the spots survive a reload');
});

test('a default group the user dissolved is not brought back; its new members stay loose', () => {
  let s = fresh({ rigs: [rig('mac')] });
  s = S.ungroup(s, 'g-machines');
  assert.deepEqual(s.dismissed, ['g-machines']);
  s = S.ungroup(s, 'g-tools-insight');
  s = check(S.mergeSources(s, { tools: S.TOOLS, rigs: [rig('mac'), rig('lin')] }));
  assert.ok(!s.groups['g-machines'] && !s.groups['g-tools-insight']);
  assert.deepEqual(s.order.slice(-2), [{ type: 'item', id: 'rig:mac' }, { type: 'item', id: 'rig:lin' }]);
  assert.deepEqual(S.deserialize(S.serialize(s)).dismissed, ['g-machines', 'g-tools-insight'], 'remembered across reloads');
  const g = S.createGroup(S.emptyState(), { name: 'Mine' }).order[0].id;
  assert.deepEqual(S.ungroup(S.createGroup(S.emptyState(), { name: 'Mine' }), g).dismissed, [], 'user groups are not recorded');
});

test('autoGroup off: new tools, applets and rigs are appended loose; it is a stored setting that defaults on', () => {
  assert.equal(S.DEFAULT_SETTINGS.autoGroup, true);
  const off = S.setSettings(S.emptyState(), { autoGroup: false });
  const s = check(S.mergeSources(off, { tools: S.TOOLS.slice(0, 2), applets: [applet('krea')], rigs: [rig('mac')] }));
  assert.deepEqual(view(s), [T('term'), T('files'), A('krea'), 'rig:mac']);
  assert.equal(S.deserialize(S.serialize(s)).settings.autoGroup, false);
  assert.equal(S.deserialize(S.serialize(S.setSettings(s, { autoGroup: 'yes' }))).settings.autoGroup, false, 'non-boolean ignored');
  // turning it on later does not regroup what is already placed
  const on = S.mergeSources(S.setSettings(s, { autoGroup: true }), { applets: [applet('krea')], rigs: [rig('mac')] });
  assert.deepEqual(view(on), view(s));
});

test('applyDefaultGroups (the user asks): loose, visible applets/rigs/tools go into their groups; user groups and hidden items stay', () => {
  let s = S.mergeSources(S.setSettings(S.emptyState(), { autoGroup: false }), { applets: [applet('krea'), applet('notes'), applet('maps')], rigs: [rig('mac'), rig('lin')] });
  s = S.createGroup(s, { id: 'g1', name: 'Mine', items: [A('maps')] });
  s = S.setHidden(s, 'rig:lin');
  s = S.addItem(s, S.toItem('panel', { id: 'chat', title: 'Chat' }));
  s = S.ungroup(S.createGroup(s, { id: 'g-machines', name: 'Machines', items: [] }), 'g-machines'); // dismissed earlier
  const sorted = check(S.applyDefaultGroups(s));
  assert.deepEqual(view(sorted), [`[mac box:${A('krea')},${A('notes')}]`, `[Mine:${A('maps')}]`, '[Machines:rig:mac]', 'panel:chat'],
    'groups take the slot of their first member; the hidden rig stays loose (and out of the view); the panel is left alone');
  assert.equal(M.groupOf(sorted, 'rig:lin'), null);
  assert.deepEqual(sorted.dismissed, []);
  assert.equal(S.applyDefaultGroups(sorted), sorted, 'nothing left to sort → same state');
});

test('badge and toggle state: set on tools only, unchanged → same state, never stored, kept across merges', () => {
  let s = fresh();
  s = S.setToolState(s, T('ask'), { badge: 3 });
  s = S.setToolState(s, T('mute'), { pressed: true });
  assert.equal(s.items[T('ask')].badge, 3);
  assert.equal(s.items[T('mute')].pressed, true);
  assert.equal(S.setToolState(s, T('ask'), { badge: 3 }), s);
  assert.equal(S.setToolState(s, T('ask'), {}), s);
  assert.equal(S.setToolState(S.setToolState(s, T('ask'), { badge: 0 }), T('ask'), {}).items[T('ask')].badge, null, '0 clears');
  assert.equal(S.setToolState(s, T('agents'), { badge: '!' }).items[T('agents')].badge, '!');
  const withApp = S.mergeSources(s, { applets: [applet('krea')] });
  assert.equal(S.setToolState(withApp, A('krea'), { badge: 2 }), withApp, 'not a tool → ignored');
  assert.equal(S.setToolState(s, 'tool:nope', { badge: 2 }), s);
  assert.equal(S.mergeSources(s, { tools: S.TOOLS }).items[T('ask')].badge, 3, 'a refresh keeps the live badge');
  const stored = JSON.parse(S.serialize(s));
  assert.ok(!('badge' in stored.items[T('ask')]) && !('pressed' in stored.items[T('mute')]), 'live state is not written to localStorage');
  assert.equal(S.serialize(s), S.serialize(fresh()), 'so a badge change never makes the dock re-save');
});

test('groupBadge sums the visible numeric badges in a stack; text badges show as a dot', () => {
  let s = fresh();
  assert.equal(M.groupBadge(s, 'g-tools-work'), null);
  s = S.setToolState(S.setToolState(s, T('ask'), { badge: 2 }), T('agents'), { badge: 5 });
  assert.equal(M.groupBadge(s, 'g-tools-work'), 7);
  assert.equal(M.groupBadge(S.setHidden(s, T('agents')), 'g-tools-work'), 2, 'a hidden item does not count');
  assert.equal(M.groupBadge(S.setToolState(fresh(), T('ask'), { badge: 'new' }), 'g-tools-work'), '•');
  assert.equal(M.groupBadge(s, 'nope'), null);
});

test('v1 → v2: user groups, pins, hidden flags, order and settings carry over exactly; only never-seen items are seeded', () => {
  const v1 = {
    v: 1, nextGroup: 3,
    settings: { position: 'left', autoHide: true, magnification: false, magnifyStrength: 0.3, autoDock: true, autoTabTerminals: false },
    items: {
      [A('krea')]: { id: A('krea'), kind: 'applet', title: 'Krea', icon: '🎨', ref: { node: 'mac', id: 'krea' }, pinned: true, hidden: false, live: true },
      [A('notes')]: { id: A('notes'), kind: 'applet', title: 'Notes', icon: '', ref: { node: 'mac', id: 'notes' }, pinned: false, hidden: true, live: true },
      [A('maps')]: { id: A('maps'), kind: 'applet', title: 'Maps', icon: '', ref: { node: 'mac', id: 'maps' }, pinned: false, hidden: false, live: true },
      'rig:mac': { id: 'rig:mac', kind: 'rig', title: 'mac', icon: '◈', ref: { nodeId: 'mac' }, pinned: false, hidden: false, live: true },
      'rig:lin': { id: 'rig:lin', kind: 'rig', title: 'lin', icon: '◈', ref: { nodeId: 'lin' }, pinned: true, hidden: false, live: false },
      'panel:chat': { id: 'panel:chat', kind: 'panel', title: 'Chat', icon: '', ref: { id: 'chat' }, pinned: true, hidden: false, live: true },
    },
    groups: { g2: { id: 'g2', name: 'Favourites', collapsed: true, items: ['rig:mac', A('krea')] } },
    order: [{ type: 'item', id: 'rig:lin' }, { type: 'group', id: 'g2' }, { type: 'item', id: A('maps') }, { type: 'item', id: A('notes') }, { type: 'item', id: 'panel:chat' }],
  };
  const s = check(S.deserialize(JSON.stringify(v1)));
  assert.equal(s.v, 2);
  assert.equal(S.VERSION, 2);
  assert.deepEqual(s.order, v1.order, 'order unchanged');
  assert.deepEqual(s.groups, v1.groups, 'user groups unchanged (name, collapsed, members and their order)');
  assert.deepEqual(s.settings, { ...v1.settings, autoGroup: true });
  assert.equal(s.nextGroup, 3);
  for (const [id, it] of Object.entries(v1.items)) {
    assert.equal(s.items[id].pinned, it.pinned, `${id} pinned`);
    assert.equal(s.items[id].hidden, it.hidden, `${id} hidden`);
    assert.equal(s.items[id].title, it.title);
  }
  assert.deepEqual(Object.keys(s.placed).sort(), [A('krea'), A('maps'), A('notes'), 'rig:lin', 'rig:mac'], 'everything already docked counts as placed');
  // the first refresh after the upgrade: tools arrive in their groups at the end, existing items do not move,
  // a new applet and a new rig join their default groups
  const live = { tools: S.TOOLS, applets: [applet('krea'), applet('notes'), applet('maps'), applet('fresh')], rigs: [rig('mac'), rig('lin'), rig('new')] };
  const next = check(S.mergeSources(s, live));
  assert.deepEqual(next.order.slice(0, 5), v1.order, 'the user arrangement keeps its place, first');
  assert.deepEqual(next.groups.g2, v1.groups.g2);
  assert.deepEqual(groupIds(next).slice(1), [...S.TOOL_GROUPS.map((g) => g.id), 'g-node-mac', 'g-machines']);
  assert.deepEqual(next.groups['g-node-mac'].items, [A('fresh')]);
  assert.deepEqual(next.groups['g-machines'].items, ['rig:new']);
  assert.equal(next.items[A('notes')].hidden, true);
  assert.equal(next.items['rig:lin'].live, true);
  assert.deepEqual(S.deserialize(S.serialize(next)), next, 'v2 round-trips');
});

test('stored v2 state is repaired like the rest: bad placed/dismissed entries are dropped, docked items count as placed', () => {
  const s = S.deserialize(JSON.stringify({
    v: 2, items: { 'tool:term': { title: 'Terminal' }, 'panel:x': {} },
    placed: { 'applet:mac/gone': 'hidden', 'bogus': true, 'rig:a': 'maybe', __proto__: { x: 1 } }, dismissed: ['g-machines', 'g1', 'g-machines', 7],
  }));
  assert.deepEqual(s.placed, { 'applet:mac/gone': 'hidden', 'tool:term': true });
  assert.deepEqual(s.dismissed, ['g-machines']);
  assert.deepEqual(S.deserialize(null).placed, {});
  assert.deepEqual(S.deserialize(null).dismissed, []);
});

test('menus: "Group new apps and machines" toggles autoGroup; "Sort into default groups" applies them', () => {
  let s = S.mergeSources(S.setSettings(S.emptyState(), { autoGroup: false }), { rigs: [rig('mac')] });
  const act = (fn) => { s = fn(s); return s; };
  const find = (label) => M.settingsEntries(s, act).find((e) => e.label === label);
  assert.equal(find('Group new apps and machines').checked, false);
  find('Group new apps and machines').run();
  assert.equal(s.settings.autoGroup, true);
  find('Sort into default groups').run();
  assert.deepEqual(view(s), ['[Machines:rig:mac]']);
  assert.equal(M.groupNameFor({ kind: 'tool' }, { kind: 'tool' }), 'Tools');
  assert.ok(M.canOpen(fresh().items[T('term')]));
});

test('the new operations never mutate their input (deep-frozen states)', () => {
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const s = deepFreeze(fresh({ applets: [applet('krea')], rigs: [rig('mac')] }));
  for (const f of [
    (x) => S.mergeSources(x, { tools: S.TOOLS, applets: [applet('new', 'lin')], rigs: [] }), (x) => S.ungroup(x, 'g-machines'),
    (x) => S.applyDefaultGroups(S.moveItem(x, 'rig:mac', { group: null })), (x) => S.setToolState(x, T('ask'), { badge: 4, pressed: true }),
  ]) assert.doesNotThrow(() => check(f(s)));
});
