import { api, h, toast } from './api.js';
import { commands, formatShortcut } from './commands.js';
import { openWindow, listWindows } from './wm.js';
import {
  focusPanel, hideOthers, hidePanel, lastFocusedPanel, listPanels, listRemoved, openPanel, removePanel, removed, resetLayout, restorePanel, showAll,
} from './layout-actions.js';

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

export function registerJarvisCommands(deps) {
  const machine = () => deps.machine?.() || null;
  const list = [
    // ------------------------------------------------------------ File
    { id: 'file.newProject', label: 'New project / task…', icon: '📋', run: () => deps.projects() },
    { id: 'file.openApp', label: 'Open app…', icon: '▦', run: () => deps.openApps() },
    { id: 'file.openFile', label: 'Open file…', icon: '📁', enabled: () => !!machine(), run: () => deps.files(machine()) },
    { id: 'file.openSession', label: 'Open session…', icon: '💬', run: () => deps.sessions() },
    {
      id: 'file.close', icon: '✕', shortcut: 'Alt+W',
      label: () => (listWindows().length ? `Close window ${quoted(listWindows()[0].title)}` : lastFocusedPanel() ? 'Close panel' : 'Close window or panel'),
      enabled: () => listWindows().length > 0 || !!lastFocusedPanel(),
      run: () => { const w = listWindows()[0]; if (w) w.close(); else hidePanel(lastFocusedPanel()); },
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
    { id: 'edit.settings', label: 'Settings — mesh, updates…', icon: '⚙', shortcut: 'Mod+,', run: () => deps.mesh() },
    { id: 'edit.display', label: 'Display & theme…', icon: '🎨', run: () => deps.display() },

    // ------------------------------------------------------------ Window (per item: args = { kind, id, title, open })
    { id: 'window.toggle', label: (c, a) => a?.title || a?.id, checked: (c, a) => !!a?.open, run: (c, a) => (a.open && a.kind === 'panel' ? hidePanel(a) : focusPanel(a)) },
    { id: 'window.open', label: (c, a) => (a?.kind === 'app' ? 'Open' : a?.open ? 'Focus' : 'Show'), run: (c, a) => (a.kind === 'app' ? openPanel(a) : focusPanel(a)) },
    { id: 'window.hide', label: (c, a) => (a?.kind === 'panel' ? 'Hide' : 'Close'), enabled: (c, a) => !!a?.open, run: (c, a) => hidePanel(a) },
    { id: 'window.hideOthers', label: (c, a) => (a ? 'Hide others' : 'Hide other panels'), run: (c, a) => hideOthers(a?.id ?? lastFocusedPanel()) },
    { id: 'window.remove', label: 'Remove', when: (c, a) => a?.kind === 'panel' || a?.kind === 'app', run: (c, a) => removePanel(a) },
    { id: 'window.showAll', label: 'Show all panels', run: () => showAll() },
    { id: 'window.reset', label: 'Reset layout', run: () => resetLayout() },
    { id: 'window.restore', label: (c, a) => `Restore ${a?.icon ? a.icon + ' ' : ''}${a?.label || a?.id}`, run: (c, a) => restorePanel(a) },
    { id: 'window.restoreAll', label: 'Restore all', enabled: () => removed.size > 0, run: () => removed.restoreAll() },
    {
      id: 'view.menubar', shortcut: 'Mod+Shift+M', global: true, when: (ctx) => !ctx.phone, checked: (ctx) => !ctx.menubarHidden,
      label: (ctx) => (ctx.menubarHidden ? 'Show menu bar' : 'Hide menu bar'), run: () => deps.menubar.toggle(),
    },
    { id: 'view.menubarFocus', label: 'Go to the menu bar', shortcut: 'F10', global: true, when: (ctx) => !ctx.phone, run: () => deps.menubar.focus() },

    // ------------------------------------------------------------ Tools
    { id: 'tools.appStore', label: 'App Store', icon: '🛍', run: () => deps.openAppStore() },
    { id: 'tools.registry', label: 'Tool registry…', icon: '🧰', run: () => openToolRegistry() },
    { id: 'tools.traces', label: 'Request traces', icon: '🧭', run: () => focusPanel('traces') },
    { id: 'tools.usage', label: 'Tokens & time', icon: '⏱', run: () => focusPanel('usage') },
    { id: 'tools.preroute', label: 'Pre-routing & brain…', icon: '◆', run: () => deps.brainMenu() },
    { id: 'tools.mesh', label: 'Mesh status', icon: '⚙', run: () => deps.mesh() },
    { id: 'tools.terminal', label: () => `Terminal on ${machine()?.name || 'this machine'}`, icon: '⌨', enabled: () => !!machine(), run: () => deps.terminal(machine()) },
    { id: 'tools.control', label: () => `Screen control on ${machine()?.name || 'this machine'}…`, icon: '🛡', enabled: () => !!machine(), run: () => deps.control(machine()) },
    { id: 'tools.desktops', label: 'Desktops (live screens)', icon: '🖼', run: () => focusPanel('desktops') },

    // ------------------------------------------------------------ Help
    { id: 'help.shortcuts', label: 'Keyboard shortcuts', icon: '⌨', shortcut: '?', run: (ctx) => openShortcuts(ctx) },
    { id: 'help.docs', label: 'Documentation (AGENTS.md)', icon: '📖', run: () => window.open(DOCS_URL, '_blank', 'noopener') },
    { id: 'help.about', label: 'About RIGS', icon: 'ⓘ', run: () => openAbout(deps) },
    { id: 'help.issue', label: 'Report an issue…', icon: '🐞', run: () => window.open(issueUrl(deps), '_blank', 'noopener') },
  ];
  commands.registerAll(list);
  return commands;
}

/** The menus, built from the registry each time one opens (so lists and labels are current). */
export function menuModel() {
  const items = listPanels();
  const panels = items.filter((x) => x.kind === 'panel');
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
    { id: 'file', label: 'File', items: () => [
      { cmd: 'file.newProject' }, { cmd: 'file.openApp' }, { cmd: 'file.openFile' }, { cmd: 'file.openSession' },
      { sep: true }, { cmd: 'file.close' }, { cmd: 'file.reload' },
    ] },
    { id: 'edit', label: 'Edit', items: () => [
      { cmd: 'edit.undo' }, { cmd: 'edit.redo' }, { sep: true }, { cmd: 'edit.copy' }, { cmd: 'edit.paste' },
      { sep: true }, { cmd: 'edit.find' }, { cmd: 'edit.settings' }, { cmd: 'edit.display' },
    ] },
    { id: 'window', label: 'Window', items: () => [
      { header: 'Panels' }, ...panels.map(perItem),
      ...(apps.length ? [{ sep: true }, { header: 'Apps' }, ...apps.map(perItem)] : []),
      ...(wins.length ? [{ sep: true }, { header: 'Open windows' }, ...wins.map(perItem)] : []),
      { sep: true },
      { cmd: 'window.hideOthers' }, { cmd: 'window.showAll' }, { cmd: 'window.reset' },
      { id: 'removed', label: `Removed items${gone.length ? ` (${gone.length})` : ''}`, submenu: () => (gone.length
        ? [...gone.map((g) => ({ cmd: 'window.restore', args: g })), { sep: true }, { cmd: 'window.restoreAll' }]
        : [{ label: 'Nothing removed', disabled: true }]) },
      { sep: true }, { cmd: 'view.menubar' },
    ] },
    { id: 'tools', label: 'Tools', items: () => [
      { cmd: 'tools.appStore' }, { cmd: 'tools.registry' }, { sep: true }, { cmd: 'tools.traces' }, { cmd: 'tools.usage' }, { cmd: 'tools.preroute' },
      { sep: true }, { cmd: 'tools.mesh' }, { cmd: 'tools.terminal' }, { cmd: 'tools.control' }, { cmd: 'tools.desktops' },
    ] },
    { id: 'help', label: 'Help', items: () => [
      { cmd: 'help.shortcuts' }, { cmd: 'help.docs' }, { sep: true }, { cmd: 'help.about' }, { cmd: 'help.issue' },
    ] },
  ];
}

// ------------------------------------------------------------------ small windows behind Help / Tools

function openShortcuts(ctx) {
  const rows = commands.list().filter((c) => (c.shortcut || c.hint) && commands.isVisible(c.id, ctx))
    .map((c) => h('tr', {}, h('td', {}, h('kbd', {}, formatShortcut(c.shortcut || c.hint, ctx.mac))), h('td', {}, commands.label(c.id, ctx))));
  rows.push(h('tr', {}, h('td', {}, h('kbd', {}, formatShortcut('Mod+K', ctx.mac))), h('td', {}, 'Ask JARVIS (focus the ask field)')));
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
  const w = openWindow({ title: 'About RIGS', icon: 'ⓘ', width: 420, height: 320 });
  w.body.append(h('div', { class: 'about' },
    h('h3', {}, 'RIGS OS · JARVIS'),
    h('p', { class: 'muted' }, 'A control plane for your mesh of machines and agents.'),
    h('dl', { class: 'about-dl' },
      h('dt', {}, 'Version'), h('dd', {}, me.version),
      h('dt', {}, 'This node'), h('dd', {}, me.name),
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
