// xterm is ~25% of the bundle and only needed once a terminal is opened, so terminal.js is loaded on first use.
export const openTerminal = (...args) => import('./terminal.js').then((m) => m.openTerminal(...args));
export const focusTerminal = (ptyId) => import('./terminal.js').then((m) => m.focusTerminal(ptyId));
