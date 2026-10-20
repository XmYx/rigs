// The one registry of JARVIS commands. The top menu bar (menubar.js), context menus and keyboard shortcuts all
// run commands from here, so an action has one id, one label, one shortcut and one enabled rule wherever it shows.
// Pure: no DOM at import time, so the enable/when logic and shortcut matching are unit-tested in Node.
//
// A command: { id, label, shortcut?, icon?, when?(ctx, args), enabled?(ctx, args), checked?(ctx, args), run(ctx, args),
//              global? }
//   label    string or (ctx, args) => string
//   shortcut "Mod+Shift+M", "Mod+Z", "F10", "?" — Mod is ⌘ on macOS and Ctrl elsewhere; an array for alternatives
//   when     false → the command does not apply here: menus leave it out and its shortcut does nothing
//   enabled  false → it applies but cannot run now: menus show it greyed out
//   global   its shortcut also fires while typing in a text field (default: it doesn't)

const safe = (fn, ctx, args, dflt) => {
  if (typeof fn !== 'function') return dflt;
  try { return fn(ctx, args); } catch { return false; }
};

export function createRegistry() {
  const cmds = new Map();
  const reg = {
    register(cmd) {
      if (!cmd?.id || typeof cmd.run !== 'function') throw new Error('a command needs an id and run()');
      cmds.set(cmd.id, cmd);
      return cmd;
    },
    registerAll(list) { for (const c of list) reg.register(c); },
    unregister(id) { cmds.delete(id); },
    has: (id) => cmds.has(id),
    get: (id) => cmds.get(id) || null,
    list: () => [...cmds.values()],
    /** Does the command apply here at all? Unknown commands never do. */
    isVisible(id, ctx = {}, args) {
      const c = cmds.get(id);
      return !!c && safe(c.when, ctx, args, true) !== false;
    },
    /** Applies and can run now. */
    isEnabled(id, ctx = {}, args) {
      const c = cmds.get(id);
      return reg.isVisible(id, ctx, args) && safe(c.enabled, ctx, args, true) !== false;
    },
    isChecked(id, ctx = {}, args) {
      const c = cmds.get(id);
      return !!c && safe(c.checked, ctx, args, false) === true;
    },
    label(id, ctx = {}, args) {
      const c = cmds.get(id);
      if (!c) return id;
      return String((typeof c.label === 'function' ? safe(c.label, ctx, args, '') : c.label) || id);
    },
    /** Run it if enabled. Returns false when it could not run, else the run() result (or true). */
    run(id, ctx = {}, args) {
      if (!reg.isEnabled(id, ctx, args)) return false;
      const r = cmds.get(id).run(ctx, args);
      return r === undefined ? true : r;
    },
    /** The command whose shortcut matches this keydown, honouring when/enabled and text-field focus. */
    forEvent(ev, ctx = {}) {
      for (const c of cmds.values()) {
        if (!c.shortcut) continue;
        if (ctx.inText && !c.global) continue;
        const scs = Array.isArray(c.shortcut) ? c.shortcut : [c.shortcut];
        if (scs.some((s) => matchShortcut(s, ev, ctx)) && reg.isEnabled(c.id, ctx)) return c;
      }
      return null;
    },
  };
  return reg;
}

/** "Mod+Shift+M" → { mod, shift, alt, ctrl, meta, key: 'm' }. */
export function parseShortcut(s) {
  const parts = String(s || '').split('+');
  const key = parts.pop();
  const out = { mod: false, shift: false, alt: false, ctrl: false, meta: false, key: key === '' ? '+' : key.toLowerCase() };
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (p === 'mod' || p === 'cmdorctrl') out.mod = true;
    else if (p === 'shift') out.shift = true;
    else if (p === 'alt' || p === 'option') out.alt = true;
    else if (p === 'ctrl' || p === 'control') out.ctrl = true;
    else if (p === 'meta' || p === 'cmd') out.meta = true;
  }
  return out;
}

/** Does a keydown event match the shortcut? `mac` decides what Mod means. A printable symbol like "?" ignores Shift. */
export function matchShortcut(s, ev, { mac = false } = {}) {
  const sc = typeof s === 'string' ? parseShortcut(s) : s;
  const key = String(ev.key || '').toLowerCase();
  const code = String(ev.code || '');
  // Shift/Alt change ev.key ("M" vs "m", Alt+M on a Mac gives "µ"): fall back to the physical key for letters/digits.
  const physical = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : '';
  if (key !== sc.key && physical !== sc.key) return false;
  const wantCtrl = sc.ctrl || (sc.mod && !mac);
  const wantMeta = sc.meta || (sc.mod && mac);
  if (!!ev.ctrlKey !== wantCtrl || !!ev.metaKey !== wantMeta || !!ev.altKey !== sc.alt) return false;
  const symbol = sc.key.length === 1 && !/[a-z0-9]/.test(sc.key);
  if (!symbol && !!ev.shiftKey !== sc.shift) return false;
  return true;
}

// Named keys as menus show them (the rest: first letter capitalised, F10).
const KEY_NAMES = { arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', pageup: 'PgUp', pagedown: 'PgDn' };
const MAC_KEY_NAMES = { enter: '↩', backspace: '⌫', escape: '⎋', home: '↖', end: '↘', pageup: '⇞', pagedown: '⇟' };

/** How a shortcut is shown in a menu: ⌘⇧M on macOS, Ctrl+Shift+M elsewhere. */
export function formatShortcut(s, mac = false) {
  if (!s) return '';
  const first = Array.isArray(s) ? s[0] : s;
  const sc = parseShortcut(first);
  const named = (mac && MAC_KEY_NAMES[sc.key]) || KEY_NAMES[sc.key];
  const key = named || (sc.key.length === 1 ? sc.key.toUpperCase() : sc.key.replace(/^./, (c) => c.toUpperCase()));
  if (mac) return `${sc.ctrl ? '⌃' : ''}${sc.alt ? '⌥' : ''}${sc.shift ? '⇧' : ''}${sc.mod || sc.meta ? '⌘' : ''}${key}`;
  return [sc.mod || sc.ctrl ? 'Ctrl' : '', sc.meta ? 'Meta' : '', sc.alt ? 'Alt' : '', sc.shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'password', 'number', 'tel', '']);
/** Is this element somewhere you type (so plain keys and Ctrl+Z belong to it, not to JARVIS)? */
export function inTextField(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return TEXT_INPUTS.has(String(el.type || '').toLowerCase());
  return !!el.closest?.('.xterm'); // a terminal owns every key
}

export const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');

/** The JARVIS registry: commands are registered at boot (jarvis-commands.js) and read by every menu. */
export const commands = createRegistry();
