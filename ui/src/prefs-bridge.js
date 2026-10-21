// The UI prefs of System Preferences (settings-model.js items with a `pref`) read and written through the same code the
// left panel's Display / Forces controls, the menus and the app dock use, so a change shows at once, synced keys reach
// the other machines, and the old controls stay in step. Pure: main.js passes the live functions as `deps`; tested
// with fakes in test/prefs-model.test.js (every pref item must have an entry in BRIDGED).
//
// deps: { storage, theme: { get, set }, face: { get, set }, menubar: { get, set }, clock12: { get, set },
//   ask: { get, set }, cloud: { get, set }, display: { get(k), set(k, on) } (labels | particles | rotate),
//   forces: { get(k), set(k, n) } (repel | linkLength), exhibitAnim: { get, set }, docking: { get, set },
//   scaling: { get, set }, dock: { get(field), set(field, v) } (the app dock's settings), notify: { get(k), set(k, on) },
//   autoOpen: { get, set }, voice: { muted, setMuted, voiceId, setVoice } }
import { decodePref, encodePref, itemById } from './settings-model.js';

const pair = (dep) => dep && { get: () => dep.get(), set: (v) => dep.set(v) };
const keyed = (dep, k) => dep && { get: () => dep.get(k), set: (v) => dep.set(k, v) };

/** Item id → how to reach its live state. Anything else falls back to localStorage in the item's own format. */
export const BRIDGED = {
  'ui.theme': (d) => pair(d.theme),
  'ui.face': (d) => pair(d.face),
  'ui.menubarHidden': (d) => pair(d.menubar),
  'ui.clock12': (d) => pair(d.clock12),
  'ui.askPlacement': (d) => pair(d.ask),
  'ui.cloud': (d) => pair(d.cloud),
  'ui.labels': (d) => keyed(d.display, 'labels'),
  'ui.traffic': (d) => keyed(d.display, 'particles'),
  'ui.orbit': (d) => keyed(d.display, 'rotate'),
  'ui.repel': (d) => keyed(d.forces, 'repel'),
  'ui.linkLength': (d) => keyed(d.forces, 'linkLength'),
  'ui.exhibitAnim': (d) => pair(d.exhibitAnim),
  'ui.docking': (d) => pair(d.docking),
  'ui.scaling': (d) => pair(d.scaling),
  'ui.dock.position': (d) => keyed(d.dock, 'position'),
  'ui.dock.autoHide': (d) => keyed(d.dock, 'autoHide'),
  'ui.dock.magnification': (d) => keyed(d.dock, 'magnification'),
  'ui.dock.magnifyStrength': (d) => keyed(d.dock, 'magnifyStrength'),
  'ui.dock.autoDock': (d) => keyed(d.dock, 'autoDock'),
  'ui.dock.autoTabTerminals': (d) => keyed(d.dock, 'autoTabTerminals'),
  'ui.dock.autoGroup': (d) => keyed(d.dock, 'autoGroup'),
  'ui.notifications': (d) => keyed(d.notify, 'notifications'),
  'ui.attnBanner': (d) => keyed(d.notify, 'attnBanner'),
  'ui.autoOpenSessions': (d) => pair(d.autoOpen),
  'ui.speak': (d) => d.voice && { get: () => !d.voice.muted, set: (v) => d.voice.setMuted(!v) },
  'ui.voice': (d) => d.voice && { get: () => d.voice.voiceId, set: (v) => d.voice.setVoice(v) },
};

/** { get(id), set(id, value) } over the live UI; a missing dep (a feature not on this page) reads/writes storage. */
export function createPrefBridge(deps = {}) {
  const storage = deps.storage ?? globalThis.localStorage;
  const stored = (it) => { let raw = null; try { raw = storage?.getItem(it.pref.key) ?? null; } catch { /* private mode */ } return raw; };
  const fallback = (it) => ({
    get: () => decodePref(it, stored(it)),
    set: (v) => { try { storage?.setItem(it.pref.key, encodePref(it, v, stored(it))); } catch { /* private mode */ } },
  });
  const route = (id) => {
    const it = itemById(id);
    if (!it?.pref) throw new Error(`${id} is not a UI preference`);
    let r = null;
    try { r = BRIDGED[id]?.(deps); } catch { r = null; } // a dep this page does not have
    return { it, r: r || fallback(it) };
  };
  return {
    get(id) {
      const { it, r } = route(id);
      let v;
      try { v = r.get(); } catch { v = undefined; }
      return v === undefined ? fallback(it).get() : v;
    },
    set(id, value) { const { r } = route(id); return r.set(value); },
  };
}
