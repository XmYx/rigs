// PLACEHOLDER (t3). The stream viewer (docs/app-streaming.md §8.2) is t4's: it replaces this file and keeps the export.
// Until then, opening an app from the file browser's Applications place shows this window, keyed by session id.
import { openWindow } from './wm.js';
import { h } from './api.js';

/** Open (or raise) the viewer window for one app session. `app` = { id, name, icon } as in the session answer. */
export function openAppStream({ nodeId, nodeName, sessionId, app = {} } = {}) {
  const w = openWindow({ title: `${app.name || 'App'} — ${nodeName}`, key: `appstream:${nodeId}:${sessionId}`, icon: '🚀', width: 640, height: 420 });
  w.body.replaceChildren(h('div', { class: 'pad muted' },
    h('p', {}, `Session ${sessionId} is running on ${nodeName}.`),
    h('p', {}, 'The live stream viewer is not part of this build yet.')));
  return w;
}
