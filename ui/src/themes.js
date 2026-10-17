// UI themes. A theme is CSS variables (ui/src/styles.css, `:root[data-theme="<id>"]` block) plus the few colors
// that live outside CSS: the 3D graph background and the xterm palette. Adding one = an entry here + a CSS block
// (see docs/playbooks/ui-theme.md). Importable in Node (no DOM at import time) so the registry is unit-tested.

const TERM_DEFAULT = { background: '#05090e', foreground: '#d7e3ea', cursor: '#5eead4', selectionBackground: '#164e63', black: '#0b1218', brightBlack: '#475569', cyan: '#22d3ee', brightCyan: '#67e8f9', green: '#4ade80', magenta: '#c084fc', yellow: '#fbbf24', blue: '#60a5fa', red: '#f87171' };

export const THEMES = {
  jarvis: { name: 'JARVIS (default)', graph: { background: '#04060a', stars: 0x334155 }, terminal: TERM_DEFAULT },
  atari: {
    name: '8-bit Atari (dark)',
    // Pixel fonts; without network the CSS falls back to the system monospace.
    fonts: 'https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap',
    graph: { background: '#000000', stars: 0x7c4a14 },
    orb: { online: [252, 148, 40], listening: [92, 216, 56], thinking: [252, 216, 0], speaking: [216, 72, 200], error: [232, 60, 40] },
    terminal: { background: '#000000', foreground: '#fce0a8', cursor: '#fc9428', cursorAccent: '#000000', selectionBackground: '#7c4a14', black: '#000000', brightBlack: '#6c5a3c', red: '#e83c28', green: '#5cd838', yellow: '#fcd800', blue: '#3c7cfc', magenta: '#d848c8', cyan: '#3cd8c8', white: '#fce0a8', brightRed: '#fc6c48', brightGreen: '#8cfc6c', brightYellow: '#fcfc68', brightBlue: '#6ca8fc', brightMagenta: '#fc7cec', brightCyan: '#7cfcec', brightWhite: '#ffffff' },
  },
};

export const DEFAULT_THEME = 'jarvis';
const KEY = 'rigs.theme';
const listeners = new Set();

export function themeId() {
  try { const id = localStorage.getItem(KEY); return THEMES[id] ? id : DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}
export const currentTheme = () => THEMES[themeId()];

/** Called with the theme on every change (graph, open terminals). */
export function onTheme(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function applyTheme(id = themeId()) {
  if (!THEMES[id]) id = DEFAULT_THEME;
  try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
  const t = THEMES[id];
  if (id === DEFAULT_THEME) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  if (t.fonts && !document.querySelector(`link[data-theme-font="${id}"]`)) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = t.fonts; l.dataset.themeFont = id;
    document.head.append(l);
  }
  for (const fn of listeners) { try { fn(t, id); } catch { /* one listener must not break the rest */ } }
  return t;
}
