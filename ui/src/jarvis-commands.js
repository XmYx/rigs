import { api, h, toast } from './api.js';
import { commands, formatShortcut, isMac } from './commands.js';
import {
  activeDesktop, addDesktop, canAddDesktop, canRemoveDesktop, listDesktops, listWindows, openWindow, removeDesktop, renameDesktop, switchDesktop,
} from './wm.js';
import { isPhone } from './mobile.js';
import { canTileActive, tileActive } from './tiling.js';
import { tileShortcuts, zoneLabel } from './tiling-model.js';
import { desktopShortcuts, targetOf } from './spaces-model.js';
import { isMissionControlOpen, toggleMissionControl } from './mission-control.js';
import { missionShortcuts } from './mission-control-model.js';
import {
  focusPanel, hideOthers, hidePanel, lastFocusedPanel, listPanels, listRemoved, openPanel, removePanel, removed, resetLayout, restorePanel, showAll,
} from './layout-actions.js';
import { isDocking, toggleDocking } from './docking.js';
import { isScaling, toggleScaling } from './scaling.js';

// Every JARVIS command the top menu, context menus and shortcuts use, registered into commands.js. `deps` are the
// actions main.js owns (windows, machines, the brain popover); the layout goes through layout-actions.js.
// Only commands that work are registered: one whose feature is missing on this page is left out (`when`).

export const DOCS_URL = 'https://github.com/XmYx/rigs/blob/main/AGENTS.md';
export const ISSUES_URL = 'https://github.com/XmYx/rigs/issues/new';

const quoted = (s) => `“${s}”`;
function undoLabel(word, step) {
  if (!step) return word;
  return `${word} ${step.op === 'remove' ? 'remove' : 'restore'} ${quoted(step.item.label)}`;
}

/** The text field the user was in before the menu took focus (copy/paste act on it). */
const fieldOf = (ctx) => (ctx.field?.isConnected ? ctx.field : null);
const hasSelection = (f) => !!f && typeof f.selectionStart === 'number' && f.selectionEnd > f.selectionStart;

// Window › Tile: one command per zone (shortcuts from tiling-model.js TILE_KEYS), acting on the focused window, else
// the frontmost one. Phones never tile.
const TILE_ICONS = { left: '◧', right: '◨', top: '⬒', bottom: '⬓', 'top-left': '◰', 'top-right': '◳', 'bottom-left': '◱', 'bottom-right': '◲', fill: '■', restore: '↺' };
const tile = (zone) => ({
  label: zoneLabel(zone), icon: TILE_ICONS[zone], shortcut: tileShortcuts(zone, isMac()),
  when: (ctx) => !ctx.phone, enabled: () => canTileActive(zone), run: () => tileActive(zone),
});

// Spaces (wm.js / spaces.js): Ctrl+←/→ and Ctrl+1…9 (spaces-model.js DESKTOP_KEYS), not while typing or in a terminal;
// the menu bar's desktop indicator and Window › Desktops list them. Phones have one desktop.
const quotedName = (d) => quoted(d?.name || '');
/** The windows on the active desktop, topmost first (File › Close never closes one you can't see). */
const shown = () => listWindows({ desktop: activeDesktop().id });
const spaceGo = (n) => ({
  label: () => listDesktops()[n - 1]?.name || `Desktop ${n}`, shortcut: desktopShortcuts(n, isMac()),
  when: (ctx) => !ctx.phone && listDesktops().length >= n, checked: () => activeDesktop().index === n - 1, run: () => switchDesktop(targetOf(n)),
});
const spaceStep = (dir) => {
  const at = () => activeDesktop().index;
  return {
    label: dir === 'next' ? 'Next desktop' : 'Previous desktop', icon: dir === 'next' ? '→' : '←', shortcut: desktopShortcuts(dir, isMac()),
    when: (ctx) => !ctx.phone, enabled: () => (dir === 'next' ? at() < listDesktops().length - 1 : at() > 0), run: () => switchDesktop(dir),
  };
};
const SPACE_COMMANDS = [
  { id: 'space.prev', ...spaceStep('prev') },
  { id: 'space.next', ...spaceStep('next') },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `space.go${i + 1}`, ...spaceGo(i + 1) })),
  { id: 'space.add', label: 'Add desktop', icon: '+', when: (ctx) => !ctx.phone, enabled: () => canAddDesktop(), run: () => addDesktop({ switchTo: true }) },
  {
    id: 'space.remove', icon: '−', when: (ctx) => !ctx.phone, enabled: () => canRemoveDesktop(),
    label: () => `Remove ${quotedName(activeDesktop())}`, run: () => removeDesktop(activeDesktop().id),
  },
  {
    id: 'space.rename', label: 'Rename desktop…', when: (ctx) => !ctx.phone,
    run: () => {
      const d = activeDesktop();
      const name = globalThis.prompt?.(`Name for ${d.name} (empty: back to its number)`, listDesktops()[d.index]?.named ? d.name : '');
      if (name != null) renameDesktop(d.id, name);
    },
  },
];

/**
 * The desktops menu (the menu bar indicator and Window › Desktops): Mission Control, one row per desktop (the active
 * one checked; the first nine with their Ctrl+n), previous / next, then add, rename and remove.
 */
export function desktopMenu() {
  const ds = listDesktops();
  return [
    { cmd: 'window.missionControl' }, { sep: true },
    ...ds.map((d, i) => (i < 9 ? { cmd: `space.go${i + 1}` } : { label: d.name, checked: d.active, run: () => switchDesktop(d.id) })),
    { sep: true }, { cmd: 'space.prev' }, { cmd: 'space.next' },
    { sep: true }, { cmd: 'space.add' }, { cmd: 'space.rename' }, { cmd: 'space.remove' },
  ];
}

export function registerJarvisCommands(deps) {
  const machine = () => deps.machine?.() || null;
  const list = [
    // ------------------------------------------------------------ JARVIS (the menu at the far left, like the Apple menu)
    { id: 'jarvis.prefs', label: 'System Preferences…', icon: '⚙', shortcut: 'Mod+,', when: () => !!deps.preferences, run: () => deps.preferences() },
    { id: 'jarvis.rescan', label: 'Rescan the mesh', icon: '↻', when: () => !!deps.rescan, run: () => deps.rescan() },
    {
      id: 'jarvis.mute', icon: '🔇', when: () => !!deps.voice, checked: () => !!deps.voice?.muted(),
      label: () => (deps.voice?.muted() ? 'Muted — JARVIS stands down' : 'Stand down — mute JARVIS'), run: () => deps.voice.setMuted(!deps.voice.muted()),
    },

    // ------------------------------------------------------------ File
    { id: 'file.newProject', label: 'New project / task…', icon: '📋', run: () => deps.projects() },
    { id: 'file.openApp', label: 'Open app…', icon: '▦', run: () => deps.openApps() },
    { id: 'file.openFile', label: 'Open file…', icon: '📁', enabled: () => !!machine(), run: () => deps.files(machine()) },
    { id: 'file.openSession', label: 'Open session…', icon: '💬', run: () => deps.sessions() },
    {
      id: 'file.close', icon: '✕', shortcut: 'Alt+W',
      label: () => (shown().length ? `Close window ${quoted(shown()[0].title)}` : lastFocusedPanel() ? 'Close panel' : 'Close window or panel'),
      enabled: () => shown().length > 0 || !!lastFocusedPanel(),
      run: () => { const w = shown()[0]; if (w) w.close(); else hidePanel(lastFocusedPanel()); },
    },
    { id: 'file.reload', label: 'Reload JARVIS', icon: '↻', run: () => location.reload() },

    // ------------------------------------------------------------ Edit
    { id: 'edit.undo', icon: '↶', shortcut: 'Mod+Z', label: () => undoLabel('Undo', removed.peekUndo()), enabled: () => removed.canUndo(), run: () => removed.undo() },
    { id: 'edit.redo', icon: '↷', shortcut: ['Mod+Shift+Z', 'Mod+Y'], label: () => undoLabel('Redo', removed.peekRedo()), enabled: () => removed.canRedo(), run: () => removed.redo() },
    {
      id: 'edit.copy', label: 'Copy', icon: '⧉', hint: 'Mod+C', enabled: (ctx) => hasSelection(fieldOf(ctx)),
      run: async (ctx) => {
        const f = fieldOf(ctx);
        const text = f.value.slice(f.selectionStart, f.selectionEnd);
        f.focus({ preventScroll: true });
        try { await navigator.clipboard.writeText(text); } catch { document.execCommand('copy'); }
      },
    },
    {
      id: 'edit.paste', label: 'Paste', icon: '📋', hint: 'Mod+V',
      when: () => !!globalThis.navigator?.clipboard?.readText, // needs https or localhost
      enabled: (ctx) => { const f = fieldOf(ctx); return !!f && !f.readOnly && !f.disabled && 'setRangeText' in f; },
      run: async (ctx) => {
        const f = fieldOf(ctx);
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch { toast('The browser did not allow reading the clipboard — use Ctrl/⌘+V in the field.', 'error'); return; }
        f.focus({ preventScroll: true });
        f.setRangeText(text, f.selectionStart ?? f.value.length, f.selectionEnd ?? f.value.length, 'end');
        f.dispatchEvent(new Event('input', { bubbles: true }));
      },
    },
    { id: 'edit.find', label: 'Find in mesh…', icon: '⌕', shortcut: '/', run: () => deps.find() },
    { id: 'edit.settings', label: 'Settings — mesh, updates…', icon: '⚙', run: () => deps.mesh() },
    { id: 'edit.display', label: 'Display & theme…', icon: '🎨', run: () => deps.display() },

    // ------------------------------------------------------------ Window (per item: args = { kind, id, title, open })
    { id: 'window.toggle', label: (c, a) => `${a?.title || a?.id}${a?.minimized ? ' (minimized)' : ''}`, checked: (c, a) => !!a?.open, run: (c, a) => (a.open && a.kind === 'panel' && !a.minimized ? hidePanel(a) : focusPanel(a)) }, // a minimized panel is restored, not closed
    { id: 'window.open', label: (c, a) => (a?.kind === 'app' ? 'Open' : a?.minimized ? 'Restore' : a?.open ? 'Focus' : 'Show'), run: (c, a) => (a.kind === 'app' ? openPanel(a) : focusPanel(a)) },
    { id: 'window.hide', label: 'Close', enabled: (c, a) => !!a?.open, run: (c, a) => hidePanel(a) },
    { id: 'window.hideOthers', label: (c, a) => (a ? 'Close others' : 'Close other panels'), run: (c, a) => hideOthers(a?.id ?? lastFocusedPanel()) },
    { id: 'window.remove', label: 'Remove', when: (c, a) => a?.kind === 'panel' || a?.kind === 'app', run: (c, a) => removePanel(a) },
    { id: 'window.showAll', label: 'Show all panels', run: () => showAll() },
    { id: 'panels.docking', label: 'Docking layout', checked: () => isDocking(), when: (ctx) => !ctx.phone, run: () => toggleDocking() },
    { id: 'panels.scaling', label: 'Smart scaling', checked: () => isScaling(), when: (ctx) => !ctx.phone, run: () => toggleScaling() },
    { id: 'window.reset', label: 'Reset layout', run: () => resetLayout() },
    { id: 'window.restore', label: (c, a) => `Restore ${a?.icon ? a.icon + ' ' : ''}${a?.label || a?.id}`, run: (c, a) => restorePanel(a) },
    { id: 'window.restoreAll', label: 'Restore all', enabled: () => removed.size > 0, run: () => removed.restoreAll() },
    // Ask JARVIS (ask-panel.js): its own panel, or docked into the top menu bar
    { id: 'window.ask', label: 'Ask JARVIS', icon: '◆', shortcut: 'Mod+K', global: true, when: () => !!deps.ask, run: () => deps.ask.focus() },
    {
      id: 'window.askTopbar', label: 'Dock Ask JARVIS to top bar', when: (ctx) => !!deps.ask && !ctx.phone,
      checked: () => deps.ask.mode() === 'topbar', run: () => deps.ask.topbar(),
    },
    {
      id: 'window.askFloat', label: 'Float Ask JARVIS', when: (ctx) => !!deps.ask && !ctx.phone,
      checked: () => deps.ask.mode() === 'floating', run: () => deps.ask.float(),
    },
    { id: 'window.askHide', label: 'Hide Ask JARVIS', when: (ctx) => !!deps.ask && !ctx.phone, enabled: () => deps.ask.mode() !== 'hidden', run: () => deps.ask.hide() },
    {
      id: 'view.menubar', shortcut: 'Mod+Shift+M', global: true, when: (ctx) => !ctx.phone, checked: (ctx) => !ctx.menubarHidden,
      label: (ctx) => (ctx.menubarHidden ? 'Show menu bar' : 'Hide menu bar'), run: () => deps.menubar.toggle(),
    },
    {
      id: 'view.cloud', label: 'Show cloud — the 3D mesh galaxy', icon: '☁', when: () => !!deps.cloud,
      checked: () => !!deps.cloud?.visible(), run: () => deps.cloud.toggle(),
    },
    { id: 'window.tileLeft', ...tile('left') },
    { id: 'window.tileRight', ...tile('right') },
    { id: 'window.tileTop', ...tile('top') },
    { id: 'window.tileBottom', ...tile('bottom') },
    { id: 'window.tileTopLeft', ...tile('top-left') },
    { id: 'window.tileTopRight', ...tile('top-right') },
    { id: 'window.tileBottomLeft', ...tile('bottom-left') },
    { id: 'window.tileBottomRight', ...tile('bottom-right') },
    { id: 'window.tileFill', ...tile('fill') },
    { id: 'window.tileRestore', ...tile('restore') },
    ...SPACE_COMMANDS,
    // Mission Control (mission-control.js): every window of the desktop and every desktop at a glance. Ctrl+↑ / F3 (not
    // while typing or in a terminal), Window › Mission Control, the desktops menu, the app dock, and JARVIS ("show me
    // all my windows", main.js). The shortcut or the menu again closes it.
    {
      id: 'window.missionControl', label: 'Mission Control', icon: '⊞', shortcut: missionShortcuts(isMac()),
      checked: () => isMissionControlOpen(), run: () => toggleMissionControl(),
    },
    { id: 'view.menubarFocus', label: 'Go to the menu bar', shortcut: 'F10', global: true, when: (ctx) => !ctx.phone, run: () => deps.menubar.focus() },

    // ------------------------------------------------------------ Tools
    { id: 'tools.appStore', label: 'App Store', icon: '🛍', run: () => deps.openAppStore() },
    { id: 'tools.registry', label: 'Tool registry…', icon: '🧰', run: () => openToolRegistry() },
    { id: 'tools.graphify', label: 'Graphify — mesh graph', icon: '🕸', run: () => focusPanel('graphify') },
    { id: 'tools.traces', label: 'Request traces', icon: '🧭', run: () => focusPanel('traces') },
    { id: 'tools.usage', label: 'Tokens & time', icon: '⏱', run: () => focusPanel('usage') },
    { id: 'tools.preroute', label: 'Pre-routing & brain…', icon: '◆', run: () => deps.brainMenu() },
    { id: 'tools.mesh', label: 'Mesh status', icon: '⚙', run: () => deps.mesh() },
    { id: 'tools.terminal', label: () => `Terminal on ${machine()?.name || 'this machine'}`, icon: '⌨', enabled: () => !!machine(), run: () => deps.terminal(machine()) },
    { id: 'tools.control', label: () => `Screen control on ${machine()?.name || 'this machine'}…`, icon: '🛡', enabled: () => !!machine(), run: () => deps.control(machine()) },
    { id: 'tools.desktops', label: 'Desktops (live screens)', icon: '🖼', run: () => focusPanel('desktops') },
    { id: 'tools.player', label: 'Media player', icon: '▶', run: () => deps.player() },
    { id: 'tools.notifications', label: 'Notifications — the last notices', icon: '🔔', when: () => !!deps.notifications, run: () => deps.notifications() },

    // ------------------------------------------------------------ Experimental
    {
      id: 'experimental.exhibits', label: 'Exhibits — a live illustrated story of the work', icon: '🎞', when: () => !!deps.exhibits,
      checked: () => !!deps.exhibits?.enabled(), run: () => deps.exhibits.toggle(),
    },
    { id: 'experimental.exhibitWindow', label: 'Open the Exhibit window', icon: '🎞', when: () => !!deps.exhibits, run: () => deps.exhibits.open() },
    {
      id: 'experimental.starnet', label: 'Space station view — StarNet in place of the galaxy', icon: '🛰', when: () => !!deps.starnet,
      checked: () => !!deps.starnet?.enabled(), run: () => deps.starnet.toggle(),
    },

    // ------------------------------------------------------------ Help
    { id: 'help.shortcuts', label: 'Keyboard shortcuts', icon: '⌨', shortcut: '?', run: (ctx) => openShortcuts(ctx) },
    { id: 'help.docs', label: 'Documentation (AGENTS.md)', icon: '📖', run: () => window.open(DOCS_URL, '_blank', 'noopener') },
    { id: 'help.about', label: 'About RIGS OS', icon: 'ⓘ', run: () => openAbout(deps) },
    { id: 'help.issue', label: 'Report an issue…', icon: '🐞', run: () => window.open(issueUrl(deps), '_blank', 'noopener') },
  ];
  commands.registerAll(list);
  return commands;
}

/** The menus, built from the registry each time one opens (so lists and labels are current). */
export function menuModel() {
  const items = listPanels();
  const panels = items.filter((x) => x.kind === 'panel' && x.id !== 'ask'); // Ask JARVIS has its own group
  const apps = items.filter((x) => x.kind === 'app');
  const wins = items.filter((x) => x.kind === 'window');
  const gone = listRemoved();
  const perItem = (x) => ({
    cmd: 'window.toggle', args: x, label: `${x.icon ? x.icon + ' ' : ''}${x.title}${x.node ? ` · ${x.node}` : ''}`,
    submenu: () => [
      { cmd: 'window.open', args: x },
      { cmd: 'window.hide', args: x },
      ...(x.kind === 'panel' ? [{ cmd: 'window.hideOthers', args: x }] : []),
      ...(x.kind !== 'window' ? [{ sep: true }, { cmd: 'window.remove', args: x }] : []),
    ],
  });
  return [
    { id: 'jarvis', label: '◆ JARVIS', items: () => [
      { cmd: 'help.about' }, { sep: true },
      { cmd: 'jarvis.prefs' }, { cmd: 'tools.appStore' }, { sep: true },
      { cmd: 'jarvis.rescan' }, { cmd: 'jarvis.mute' }, { sep: true },
      { cmd: 'file.reload' },
    ], brand: true },
    { id: 'file', label: 'File', items: () => [
      { cmd: 'file.newProject' }, { cmd: 'file.openApp' }, { cmd: 'file.openFile' }, { cmd: 'file.openSession' },
      { sep: true }, { cmd: 'file.close' }, { cmd: 'file.reload' },
    ] },
    { id: 'edit', label: 'Edit', items: () => [
      { cmd: 'edit.undo' }, { cmd: 'edit.redo' }, { sep: true }, { cmd: 'edit.copy' }, { cmd: 'edit.paste' },
      { sep: true }, { cmd: 'edit.find' }, { cmd: 'edit.settings' }, { cmd: 'edit.display' },
    ] },
    { id: 'panels', label: 'Panels', items: () => [
      { cmd: 'panels.docking' }, { cmd: 'panels.scaling' }, { sep: true },
      ...panels.map(perItem),
      { sep: true }, { cmd: 'window.hideOthers' }, { cmd: 'window.showAll' }, { cmd: 'window.reset' },
    ] },
    { id: 'window', label: 'Window', items: () => [
      { cmd: 'window.missionControl' },
      ...(isPhone() ? [] : [{ id: 'tile', label: 'Tile', icon: '◫', submenu: () => [
        { cmd: 'window.tileLeft' }, { cmd: 'window.tileRight' }, { cmd: 'window.tileTop' }, { cmd: 'window.tileBottom' }, { sep: true },
        { cmd: 'window.tileTopLeft' }, { cmd: 'window.tileTopRight' }, { cmd: 'window.tileBottomLeft' }, { cmd: 'window.tileBottomRight' }, { sep: true },
        { cmd: 'window.tileFill' }, { cmd: 'window.tileRestore' },
      ] }, { id: 'desktops', label: 'Desktops', icon: '▭', submenu: () => desktopMenu() }, { sep: true }]),
      ...(apps.length ? [{ header: 'Apps' }, ...apps.map(perItem), { sep: true }] : []),
      ...(wins.length ? [{ header: 'Open windows' }, ...wins.map(perItem), { sep: true }] : []),
      { header: 'Ask JARVIS' }, { cmd: 'window.ask' }, { cmd: 'window.askTopbar' }, { cmd: 'window.askFloat' }, { cmd: 'window.askHide' },
      { sep: true },
      { id: 'removed', label: `Removed items${gone.length ? ` (${gone.length})` : ''}`, submenu: () => (gone.length
        ? [...gone.map((g) => ({ cmd: 'window.restore', args: g })), { sep: true }, { cmd: 'window.restoreAll' }]
        : [{ label: 'Nothing removed', disabled: true }]) },
      { sep: true }, { cmd: 'view.cloud' }, { cmd: 'view.menubar' },
    ] },
    { id: 'tools', label: 'Tools', items: () => [
      { cmd: 'tools.appStore' }, { cmd: 'tools.registry' }, { sep: true }, { cmd: 'tools.graphify' }, { cmd: 'tools.traces' }, { cmd: 'tools.usage' }, { cmd: 'tools.preroute' },
      { sep: true }, { cmd: 'tools.mesh' }, { cmd: 'tools.terminal' }, { cmd: 'tools.control' }, { cmd: 'tools.desktops' }, { cmd: 'tools.player' },
      { sep: true }, { cmd: 'tools.notifications' },
    ] },
    { id: 'experimental', label: 'Experimental', items: () => [{ cmd: 'experimental.exhibits' }, { cmd: 'experimental.exhibitWindow' }, { sep: true }, { cmd: 'experimental.starnet' }] },
    { id: 'help', label: 'Help', items: () => [
      { cmd: 'help.shortcuts' }, { cmd: 'help.docs' }, { sep: true }, { cmd: 'help.about' }, { cmd: 'help.issue' },
    ] },
  ];
}

// ------------------------------------------------------------------ small windows behind Help / Tools

function openShortcuts(ctx) {
  const rows = commands.list().filter((c) => (c.shortcut || c.hint) && commands.isVisible(c.id, ctx))
    .map((c) => h('tr', {}, h('td', {}, h('kbd', {}, formatShortcut(c.shortcut || c.hint, ctx.mac))), h('td', {}, commands.label(c.id, ctx))));
  rows.push(h('tr', {}, h('td', {}, h('kbd', {}, '↑ / ↓')), h('td', {}, 'In the Ask field: earlier requests')));
  rows.push(h('tr', {}, h('td', {}, h('kbd', {}, 'Esc')), h('td', {}, 'Close a menu, window or selection')));
  const w = openWindow({ title: 'Keyboard shortcuts', icon: '⌨', width: 460, height: 480 });
  w.body.append(h('table', { class: 'kbd-table' }, h('tbody', {}, ...rows)),
    h('p', { class: 'muted small' }, 'Menu bar: ←/→ switch menus, ↑/↓ move, Enter runs, → opens a submenu, Esc closes. Hover the top edge to reveal a hidden menu bar. Undo/redo act on JARVIS only while you are not typing in a field.'));
}

function selfInfo(deps) {
  const m = deps.self?.() || {};
  return { name: m.name || location.hostname, version: m.version || '?' };
}

function openAbout(deps) {
  const me = selfInfo(deps);
  const w = openWindow({ title: 'About RIGS OS', icon: 'ⓘ', width: 420, height: 340 });
  w.body.append(h('div', { class: 'about' },
    h('h3', {}, 'RIGS OS · JARVIS'),
    h('p', { class: 'muted' }, 'A control plane for your mesh of machines and agents.'),
    h('dl', { class: 'about-dl' },
      h('dt', {}, 'Version'), h('dd', {}, me.version),
      h('dt', {}, 'This node'), h('dd', {}, me.name),
      h('dt', {}, 'Brain'), h('dd', {}, deps.brain?.() || '—'),
      h('dt', {}, 'Machines online'), h('dd', {}, String(deps.machines?.().length ?? '?'))),
    h('p', {}, h('a', { href: DOCS_URL, target: '_blank', rel: 'noopener' }, 'Documentation'), ' · ', h('a', { href: issueUrl(deps), target: '_blank', rel: 'noopener' }, 'Report an issue'))));
}

export function issueUrl(deps) {
  const me = selfInfo(deps);
  const body = `**What happened**\n\n\n**What I expected**\n\n\n---\nRIGS ${me.version} · node ${me.name} · ${globalThis.navigator?.userAgent || ''}`;
  return `${ISSUES_URL}?body=${encodeURIComponent(body)}`;
}

function openToolRegistry() {
  const w = openWindow({ title: 'Tool registry', icon: '🧰', width: 640, height: 520 });
  const q = h('input', { class: 'path-input', type: 'search', placeholder: 'Search tools and applets…', 'aria-label': 'Search tools' });
  const out = h('div', { class: 'tool-list' }, h('div', { class: 'muted small' }, 'Loading…'));
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    try {
      const r = await api(`/api/tools?q=${encodeURIComponent(q.value.trim())}`);
      if (my !== seq) return;
      const tools = r.results || [];
      out.replaceChildren(...(tools.length ? tools.map((t) => h('div', { class: 'tool-row' },
        h('div', {}, h('b', {}, t.name || t.id), h('span', { class: 'muted small' }, ` ${t.kind === 'applet' ? 'applet' : 'tool'} · ${t.node || ''}${t.safety ? ' · ' + t.safety : ''}`)),
        h('div', { class: 'small' }, t.description || ''))) : [h('div', { class: 'muted small' }, 'No tools match.')]));
    } catch (e) { if (my === seq) out.replaceChildren(h('div', { class: 'muted small' }, `Could not load the registry: ${e.message}`)); }
  };
  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  w.body.append(h('div', { class: 'actions' }, q), out,
    h('p', { class: 'muted small' }, 'Scripts agents filed for reuse (tool_register) and App Cloud applets, across the mesh. Agents run them with tool_run.'));
  load();
}
