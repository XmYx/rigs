// Context-menu providers: target → menu entries. Pure (no DOM, no imports): every action a menu runs is injected as
// `deps`, so "which items does a session / app / file / project show, and which are disabled" is unit-tested in Node
// (test/contextmenu.test.js) and a new case needs one provider entry here plus a tagCtx() where it is rendered.
//
// A provider is (target, ctx) => entries | null, with target = { kind, id, data, el } from ctx-tag.js and ctx =
// { kinds, selection?, phone?, … }. Entries are the menubar's: { cmd, args } runs a command from commands.js (so the
// label, enabled rule and shortcut are the same as in the top menu), { label, run, icon?, hint?, disabled?, danger?,
// checked?, submenu? } runs inline, { sep: true } separates. Items whose action dep is missing are left out.
//
// deps (all optional; main.js wires them): copy(text, what), layout{toggleCollapse,isCollapsed,resetPanel,canDock,
// isDocked,dock,float,removed}, window{minimize,isMin,toggleMax,isMax,closeOthers,closeAll,count}, app{key,isOpen,status,url,open,
// openTab,reload}, session{transcript,attach,chat,galaxy,newHere}, project{open,act,galaxy}, task{openSession,mark},
// node{get,status,terminal,files,screen,sessions,control,ssh,sshCommand,newAgent}, trace{open}, galaxy{select,fit,
// hideType,typeLabel,talkToModel,useAsBrain,newSession,newInProject}, station{select,fit}.

const MAX_GROUPS = 2; // the surface under the pointer plus the container it sits in (a session row in its window)

const TITLES = {
  panel: 'Panel', window: 'Window', app: 'App', session: 'Session', project: 'Project', task: 'Task', node: 'Machine',
  file: 'File', folder: 'Folder', trace: 'Request', storeapp: 'App Store', gnode: 'Galaxy', station: 'Station',
};
/** The agents a machine can start (agents/start), in the order the New agent dialog lists them. */
const AGENT_KINDS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['ollama', 'Ollama'], ['rig', 'OpenRig']];

export function createProviders() {
  const map = new Map(); // kind → { fn, title }
  const reg = {
    register(kind, fn, { title } = {}) { map.set(kind, { fn, title: title ?? TITLES[kind] ?? '' }); return reg; },
    has: (kind) => map.has(kind),
    kinds: () => [...map.keys()],
    /** One target's group: { title, items } or null (unknown kind, throwing provider, nothing to show). */
    run(target, ctx = {}) {
      const p = map.get(target?.kind);
      if (!p) return null;
      let items;
      try { items = p.fn(target, ctx); } catch { return null; }
      items = tidy([].concat(items || []));
      return items.length ? { title: p.title, items } : null;
    },
  };
  return reg;
}

/** Drop missing items, leading/trailing/double separators. */
export function tidy(entries) {
  const out = [];
  for (const e of entries) {
    if (!e) continue;
    if (e.sep) { if (out.length && !out.at(-1).sep) out.push(e); continue; }
    out.push(e);
  }
  while (out.length && out.at(-1).sep) out.pop();
  return out;
}

/**
 * The menu for what is under the pointer. `targets` is ctxTargets().targets (innermost first). Up to MAX_GROUPS
 * groups, titled when there are two; no group at all means the empty background, so the `desktop` provider answers.
 * A text selection under the pointer adds Copy on top.
 */
export function resolveMenu(reg, targets = [], ctx = {}) {
  const c = { ...ctx, kinds: targets.map((t) => t.kind) };
  const groups = [];
  const seen = new Set();
  for (const t of targets) {
    const key = `${t.kind}:${t.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const g = reg.run(t, c);
    if (g) groups.push(g);
    if (groups.length >= MAX_GROUPS) break;
  }
  if (!groups.length) { const g = reg.run({ kind: 'desktop', id: null, data: null }, c); if (g) groups.push(g); }
  const out = [];
  if (ctx.selection && ctx.copy) {
    const text = String(ctx.selection);
    const short = text.replace(/\s+/g, ' ').trim();
    out.push({ label: `Copy “${short.length > 28 ? short.slice(0, 27).trimEnd() + '…' : short}”`, icon: '⧉', run: () => ctx.copy(text, 'Selection'), hint: 'Mod+C' }, { sep: true });
  }
  groups.forEach((g, i) => {
    if (i) out.push({ sep: true });
    if (groups.length > 1 && g.title) out.push({ header: g.title });
    out.push(...g.items);
  });
  return tidy(out);
}

/** A galaxy node (graph.js) as a context target: machines, apps, sessions, projects and tasks reuse the same menus. */
export function galaxyTarget(n, { machineById } = {}) {
  if (!n) return null;
  switch (n.type) {
    case 'machine': case 'offline': return n.data ? { kind: 'node', id: n.machine, data: { node: n.data } } : null;
    case 'app': return n.app ? { kind: 'app', id: `${n.app.nodeId || n.app.node}/${n.app.id}`, data: { app: n.app } } : null;
    case 'session': case 'live': case 'chat': {
      const node = machineById?.(n.machine);
      return node && n.session ? { kind: 'session', id: n.session.id, data: { node, s: n.session } } : { kind: 'gnode', id: n.id, data: n };
    }
    case 'plan': return n.plan ? { kind: 'project', id: n.plan.id, data: { id: n.plan.id, name: n.plan.name, status: n.plan.status, ownerId: n.owner } } : null;
    case 'task': return n.task && n.plan
      ? { kind: 'task', id: `${n.plan.id}/${n.task.id}`, data: { task: n.task, project: { id: n.plan.id, name: n.plan.name, status: n.plan.status, ownerId: n.owner } } }
      : { kind: 'gnode', id: n.id, data: n };
    default: return { kind: 'gnode', id: n.id, data: n };
  }
}

/** The project's status from a row that only knows its progress (the Active projects panel). */
export function projectStatus(p) {
  if (p.status) return p.status;
  return p.blocked ? 'blocked' : p.running?.length ? 'running' : 'planned';
}

const SEP = { sep: true };

export function registerJarvisProviders(reg, deps = {}) {
  const d = (k) => deps[k] || {};
  const copy = (text, what) => (typeof deps.copy === 'function' && text != null ? () => deps.copy(text, what) : null);
  /** An inline item that runs `fn`; left out when `fn` is missing. */
  const it = (label, fn, o = {}) => (typeof fn === 'function' ? { label, run: fn, ...o } : null);
  const bind = (obj, name, ...args) => (typeof obj[name] === 'function' ? () => obj[name](...args) : null);
  /** Like bind, then data.refresh() so the window the row lives in shows the new state. */
  const bindThen = (refresh, obj, name, ...args) => (typeof obj[name] === 'function' ? async () => { await obj[name](...args); await refresh?.(); } : null);

  // ------------------------------------------------------------ the empty background
  const desktopItems = () => {
    const gone = d('layout').removed?.() || [];
    return [
      { cmd: 'file.openApp' }, { cmd: 'file.newProject' }, { cmd: 'file.openSession' },
      SEP,
      { cmd: 'window.showAll' }, { cmd: 'window.reset' },
      { label: `Removed items${gone.length ? ` (${gone.length})` : ''}`, submenu: () => (gone.length
        ? [...gone.map((g) => ({ cmd: 'window.restore', args: g })), SEP, { cmd: 'window.restoreAll' }]
        : [{ label: 'Nothing removed', disabled: true }]) },
      SEP,
      { cmd: 'view.menubar' }, { cmd: 'edit.settings' }, { cmd: 'edit.display' },
    ];
  };
  reg.register('desktop', () => desktopItems(), { title: 'JARVIS' });
  reg.register('galaxy', (t, ctx) => (ctx.kinds[0] === 'galaxy'
    ? [it('Reset galaxy view', bind(d('galaxy'), 'fit'), { icon: '⤢' }), SEP, ...desktopItems()] : null), { title: 'JARVIS' });
  reg.register('gnode', (t) => {
    const n = t.data || {};
    const G = d('galaxy');
    const label = G.typeLabel?.(n.type) || n.type;
    return [
      it('Focus', bind(G, 'select', n.id), { icon: '◎' }),
      n.type === 'agent' ? it(`New ${n.name} session…`, bind(G, 'newSession', n), { icon: '▶' }) : null,
      n.type === 'project' ? it('New agent in this project…', bind(G, 'newInProject', n), { icon: '✳' }) : null,
      n.type === 'model' ? it('Talk to this model', bind(G, 'talkToModel', n), { icon: '◆' }) : null,
      n.type === 'agent' && n.agent !== 'rig' ? it('Use as brain', bind(G, 'useAsBrain', n), { icon: '◆' }) : null,
      it(`Hide all “${label}” nodes`, bind(G, 'hideType', n.type)),
      SEP,
      it('Copy name', copy(n.name, 'Name'), { icon: '⧉' }),
    ];
  });

  // The space-station view's own group (ui/src/starnet/): what a room or desk holds that the floor does not draw, by
  // type (each selects it in the inspector, where its actions are), and framing the whole station. On empty floor
  // (no node) it stands in for the galaxy background menu.
  reg.register('station', (t) => {
    const S = d('station');
    const { node: n, more = [] } = t.data || {};
    const fit = it('Show the whole station', bind(S, 'fit'), { icon: '⤢' });
    if (!n) return [fit, SEP, ...desktopItems()];
    return [
      ...(typeof S.select === 'function' ? more : []).filter((g) => g.items?.length).map((g) => ({
        label: `${g.label} (${g.items.length})`, icon: '☰',
        submenu: () => g.items.map((x) => it(x.name || x.id, bind(S, 'select', x.id))),
      })),
      fit,
    ];
  });

  // ------------------------------------------------------------ panels and windows
  reg.register('panel', (t) => {
    const id = t.data?.id ?? t.id;
    const ref = { kind: 'panel', id, title: t.data?.title || id, open: true };
    const L = d('layout');
    const collapsed = !!L.isCollapsed?.(id);
    const docked = !!L.isDocked?.(id);
    return [
      it(collapsed ? 'Expand' : 'Collapse', bind(L, 'toggleCollapse', id), { icon: collapsed ? '▸' : '▾' }),
      it('Reset position and size', bind(L, 'resetPanel', id), { icon: '↺' }),
      L.canDock?.(id) ? it(docked ? 'Float' : 'Dock', bind(L, docked ? 'float' : 'dock', id)) : null,
      SEP,
      { cmd: 'window.hide', args: ref, label: 'Hide' },
      { cmd: 'window.hideOthers', args: ref, label: 'Hide other panels' },
      SEP,
      { cmd: 'window.remove', args: ref, label: 'Remove (undoable)' },
    ];
  });
  reg.register('window', (t) => {
    const id = t.id;
    const W = d('window');
    const ref = { kind: 'window', id, title: t.data?.title || id, open: true };
    const min = !!W.isMin?.(id);
    const max = !!W.isMax?.(id);
    return [ // the title bar's own three buttons, in the same order: minimize, maximize / restore, close
      { cmd: 'window.open', args: ref, label: min ? 'Restore' : 'Bring to front' },
      SEP,
      it('Minimize', bind(W, 'minimize', id), { icon: '–', disabled: min }),
      it(max ? 'Restore size' : 'Maximize', bind(W, 'toggleMax', id), { icon: max ? '❐' : '□' }),
      { cmd: 'window.hide', args: ref, label: 'Close', icon: '✕' },
      SEP,
      it('Close other windows', bind(W, 'closeOthers', id), { disabled: (W.count?.() ?? 2) < 2 }),
      it('Close all windows', bind(W, 'closeAll'), { disabled: (W.count?.() ?? 1) < 1 }),
    ];
  });

  // ------------------------------------------------------------ apps
  reg.register('app', (t) => {
    const a = t.data?.app;
    if (!a) return null;
    const A = d('app');
    const key = A.key ? A.key(a) : `${a.nodeId || a.node}/${a.id}`;
    const st = A.status?.(a) || a.health?.status || 'unknown';
    const open = !!A.isOpen?.(a);
    const ref = { kind: 'app', id: key, title: a.name, icon: a.icon, node: a.node, open };
    return [
      it(open ? 'Focus' : st === 'up' ? 'Open' : 'Start & open', bind(A, 'open', a), { icon: '▦' }),
      it('Open in a browser tab', bind(A, 'openTab', a), { icon: '↗' }),
      it('Reload', bind(A, 'reload', a), { icon: '↻', disabled: !open }),
      SEP,
      { cmd: 'window.hide', args: ref, label: 'Hide window' },
      { cmd: 'window.remove', args: ref, label: 'Remove from list (undoable)' },
      SEP,
      it('Copy URL', A.url ? copy(A.url(a), 'App URL') : null, { icon: '⧉' }),
    ];
  });
  reg.register('storeapp', (t) => {
    const { app: a, state = 'not-installed', fits = true, updateAvailable = false, actions: X = {} } = t.data || {};
    if (!a) return null;
    const installed = state === 'installed' || state === 'external';
    return [
      installed ? it('Open', bind(X, 'open', a), { icon: '▦' }) : null,
      !installed && state !== 'busy' ? it(state === 'failed' ? 'Retry install' : state === 'partial' ? 'Finish install' : 'Install', bind(X, 'install', a), { icon: '⇩', disabled: !fits }) : null,
      installed && updateAvailable ? it('Update', bind(X, 'install', a), { icon: '⟳' }) : null,
      state === 'busy' ? it('Cancel install', bind(X, 'cancel', a), { icon: '✕' }) : null,
      SEP,
      state === 'installed' || state === 'partial' ? it('Uninstall…', bind(X, 'uninstall', a), { danger: true }) : null,
      it('Copy app id', copy(a.id, 'App id'), { icon: '⧉' }),
    ];
  });

  // ------------------------------------------------------------ sessions, projects, tasks
  reg.register('session', (t) => {
    const { node: n, s, transcript } = t.data || {}; // `transcript`: a row inside the Sessions window shows it there instead of opening another
    if (!n || !s) return null;
    const S = d('session');
    const attach = s.kind === 'pty' ? 'Open terminal' : s.kind === 'chat' ? 'Continue with JARVIS' : s.live ? 'Attach terminal' : 'Resume in terminal';
    const resume = (s.kind === 'claude' || s.kind === 'codex')
      ? copy(`ssh ${n.sshAlias || n.name} -t "cd ${s.cwd || '~'} && ${s.kind === 'claude' ? 'claude --resume' : 'codex resume'} ${s.id}"`, 'Resume command') : null;
    return [
      it('Open transcript', typeof transcript === 'function' ? transcript : bind(S, 'transcript', n, s), { icon: '📜' }),
      it(attach, bind(S, 'attach', n, s), { icon: '⌨' }),
      s.kind === 'chat' ? null : it('Send message…', bind(S, 'chat', n, s), { icon: '💬' }),
      it('Show in galaxy', bind(S, 'galaxy', n, s), { icon: '◎' }),
      s.kind !== 'chat' && s.cwd ? it('New agent in this folder…', bind(S, 'newHere', n, s), { icon: '✳', disabled: n.online === false }) : null,
      SEP,
      it('Copy session id', copy(s.id, 'Session id'), { icon: '⧉' }),
      it('Copy ssh resume command', resume),
    ];
  });
  reg.register('project', (t) => {
    const p = t.data;
    if (!p?.id) return null;
    const P = d('project');
    const st = projectStatus(p);
    return [
      it('Open', typeof p.open === 'function' ? p.open : bind(P, 'open', p), { icon: '📋' }), // p.open: a row in the Projects window opens it in place
      st === 'paused' ? it('Resume', bindThen(p.refresh, P, 'act', p, 'resume'), { icon: '▶' })
        : it('Pause', bindThen(p.refresh, P, 'act', p, 'stop'), { icon: '❚❚', disabled: !['running', 'blocked', 'planned'].includes(st) }),
      it('Dispatch ready tasks', bindThen(p.refresh, P, 'act', p, 'dispatch'), { icon: '➤', disabled: st === 'done' || st === 'paused' }),
      it('Show in galaxy', bind(P, 'galaxy', p), { icon: '◎' }),
      SEP,
      it('Copy project id', copy(p.id, 'Project id'), { icon: '⧉' }),
    ];
  });
  reg.register('task', (t) => {
    const { task, project, refresh, openProject } = t.data || {};
    if (!task || !project) return null;
    const P = d('project');
    const T = d('task');
    return [
      it('Open project', typeof openProject === 'function' ? openProject : bind(P, 'open', project), { icon: '📋' }),
      it('Open agent session', bind(T, 'openSession', project, task), { icon: '⌨', disabled: !task.run?.session }),
      SEP,
      it('Mark done', bindThen(refresh, T, 'mark', project, task, 'done'), { icon: '✓', disabled: task.status === 'done' }),
      it('Back to todo (re-run)', bindThen(refresh, T, 'mark', project, task, 'todo'), { icon: '↺', disabled: !['failed', 'review', 'blocked', 'done'].includes(task.status) }),
      it('Dispatch ready tasks', bindThen(refresh, P, 'act', project, 'dispatch'), { icon: '➤', disabled: project.status === 'done' || project.status === 'paused' }),
      SEP,
      it('Copy task id', copy(task.id, 'Task id'), { icon: '⧉' }),
    ];
  });

  // ------------------------------------------------------------ machines
  reg.register('node', (t) => {
    const raw = t.data?.node;
    if (!raw) return null;
    const N = d('node');
    const m = N.get?.(raw) || raw;
    const up = m.online !== false && m.rigs !== false;
    const ssh = N.sshCommand?.(m) || `ssh ${m.sshAlias || m.name}`;
    const kinds = AGENT_KINDS.filter(([k]) => m.tools?.[k]);
    return [
      it('Show status', bind(N, 'status', m), { icon: '◎' }),
      it('New agent…', bind(N, 'newAgent', m), { icon: '✳', disabled: !up }),
      typeof N.newAgent === 'function' && up && kinds.length > 1
        ? { label: 'New agent of kind', submenu: () => kinds.map(([k, label]) => it(`${label}…`, () => N.newAgent(m, k))) } : null,
      it('Open terminal', bind(N, 'terminal', m), { icon: '⌨', disabled: !up }),
      it('Files', bind(N, 'files', m), { icon: '📁', disabled: !up }),
      it('Screen (live desktop)', bind(N, 'screen', m), { icon: '🖼', disabled: !up }),
      it('Sessions', bind(N, 'sessions', m), { icon: '💬', disabled: !up }),
      it('Access & control…', bind(N, 'control', m), { icon: '🛡', disabled: !up }),
      SEP,
      it('SSH in', bind(N, 'ssh', m), { icon: '🔐' }),
      it('Copy ssh command', copy(ssh, 'ssh command'), { icon: '⧉' }),
    ];
  });

  // ------------------------------------------------------------ files and traces
  reg.register('file', (t) => {
    const { entry: e, actions: X = {}, machines = [] } = t.data || {};
    if (!e) return null;
    const dir = e.type === 'dir';
    return [
      it(dir ? 'Open folder' : 'Preview', bind(X, 'open', e), { icon: dir ? '📁' : '👁' }),
      dir ? null : it('Download', bind(X, 'download', e), { icon: '⇩' }),
      it('Copy path', copy(e.path, 'Path'), { icon: '⧉' }),
      it('Terminal here', bind(X, 'terminalHere', dir ? e.path : e.path.replace(/[\\/][^\\/]*$/, '') || '/'), { icon: '⌨' }),
      !dir && machines.length && typeof X.copyTo === 'function'
        ? { label: 'Copy to machine', icon: '⇪', submenu: () => machines.map((m) => ({ label: m.name, run: () => X.copyTo(e, m) })) } : null,
      SEP,
      it('Rename…', bind(X, 'rename', e), { icon: '✎' }),
      it('Move to trash…', bind(X, 'trash', e), { icon: '🗑', danger: true }),
    ];
  });
  reg.register('folder', (t) => {
    const { path, actions: X = {} } = t.data || {};
    return [
      it('New folder…', bind(X, 'newFolder'), { icon: '＋' }),
      it('Upload files here…', bind(X, 'upload'), { icon: '⇪' }),
      it('Refresh', bind(X, 'refresh'), { icon: '↻' }),
      it('Terminal here', bind(X, 'terminalHere', path), { icon: '⌨' }),
      typeof X.toggleHidden === 'function' ? { label: 'Show hidden files', checked: !!X.showHidden?.(), run: X.toggleHidden } : null,
      SEP,
      it('Copy folder path', copy(path, 'Path'), { icon: '⧉' }),
    ];
  });
  reg.register('trace', (t) => {
    const { traceId, summary } = t.data || {};
    if (!traceId) return null;
    const T = d('trace');
    return [
      it('Open request', bind(T, 'open', traceId, summary), { icon: '🧭' }),
      SEP,
      it('Copy trace id', copy(traceId, 'Trace id'), { icon: '⧉' }),
      summary?.request ? it('Copy request text', copy(summary.request, 'Request'), { icon: '⧉' }) : null,
    ];
  });

  return reg;
}
