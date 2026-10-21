// Pure logic of the media player (ui/src/media-player.js): which files are audio or video, their types, the folder's
// playlist, time formatting, keyboard shortcuts, speeds and volume, what closing the window does, the error wording,
// and the arbiter that keeps one media element playing at a time. No DOM, so it is unit-tested in Node
// (test/media-player.test.js).

export const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)$/i;
export const VIDEO = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;

// The same types src/files.js mimeOf serves, for canPlayType().
const TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg; codecs="opus"', weba: 'audio/webm', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mkv: 'video/x-matroska', ogv: 'video/ogg',
};

const base = (p) => String(p || '').split(/[\\/]/).pop();
const extOf = (name) => (/\.([^.]+)$/.exec(base(name))?.[1] || '').toLowerCase();

/** 'audio' | 'video' | null (not something the player opens). */
export function mediaKind(name) {
  const n = base(name);
  if (AUDIO.test(n)) return 'audio';
  if (VIDEO.test(n)) return 'video';
  return null;
}

export const mimeFor = (name) => TYPES[extOf(name)] || '';
/** The file name without its extension: the track title. */
export const titleOf = (name) => base(name).replace(/\.[^.]+$/, '') || base(name);
export const folderOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '') || '/';
export const folderName = (p) => base(folderOf(p)) || folderOf(p);

/** files/raw on machine `nodeId` (the gateway relays it to a peer, Range and all). */
export const rawUrl = (nodeId, p, { download = false } = {}) =>
  `/api/nodes/${encodeURIComponent(nodeId || 'self')}/files/raw?path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`;

/** "1:05", "12:00", "1:02:03"; unknown or infinite (a live stream) → "--:--". */
export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The playlist for `path`: the audio and video files of its folder listing (`entries` = files.js / files API rows
 * { name, path, type }), in natural name order ("2 x" before "10 x") → { list: [{ name, path, kind }], index }.
 * The file itself is always in it, also when the listing is missing or does not hold it.
 */
export function mediaSiblings(entries, path) {
  const list = (entries || []).filter((e) => e && e.type !== 'dir' && e.path && mediaKind(e.name || e.path) && !base(e.name || e.path).startsWith('._')) // ._x = a macOS resource fork
    .map((e) => ({ name: e.name || base(e.path), path: e.path, kind: mediaKind(e.name || e.path) })).sort(byName);
  let index = list.findIndex((e) => e.path === path);
  if (index < 0 && path) { list.unshift({ name: base(path), path, kind: mediaKind(path) }); index = 0; }
  return { list, index };
}

/** Index after stepping `d` from `i` in a list of `n`; -1 past either end (the player does not wrap). */
export const stepTrack = (n, i, d) => { const j = i + d; return j >= 0 && j < n ? j : -1; };

/** The next (d 1) or previous (-1) track of `kind` ('audio' in the background mini-player, which cannot show video); -1 = none. */
export function stepKind(list, i, d, kind) {
  for (let j = stepTrack(list.length, i, d); j >= 0; j = stepTrack(list.length, j, d)) if (!kind || list[j].kind === kind) return j;
  return -1;
}

export const SPEEDS = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
/** The next speed up (dir 1) or down (-1) from the listed speed nearest `cur`, held at the ends. */
export function stepSpeed(cur, dir) {
  let i = 0;
  for (let j = 1; j < SPEEDS.length; j++) if (Math.abs(SPEEDS[j] - cur) < Math.abs(SPEEDS[i] - cur)) i = j;
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + dir))];
}
/** The speed button: up through SPEEDS, then back to the slowest. */
export const nextSpeed = (cur) => (cur >= SPEEDS[SPEEDS.length - 1] - 1e-9 ? SPEEDS[0] : stepSpeed(cur, 1));
export const speedLabel = (s) => `${Number(s.toFixed(2))}×`;

export const clampVolume = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, Math.round(v * 100) / 100)) : 1);

/** Where a seek of `delta` seconds from `cur` lands, kept inside [0, duration] (an unknown duration only has a floor). */
export function seekTarget(cur, delta, duration) {
  const t = Math.max(0, (Number.isFinite(cur) ? cur : 0) + delta);
  return Number.isFinite(duration) && duration > 0 ? Math.min(t, duration) : t;
}

/**
 * A key press → a player action, or null to leave the key alone. Space/K toggle, ←/→ seek 5 s (Shift: 30 s), J/L 10 s,
 * ↑/↓ volume, M mute, F fullscreen (video), I picture-in-picture (video), Shift+N / Shift+P next / previous, < / > speed,
 * 0–9 jump to that tenth, Home/End start/end. Ctrl, ⌘ and Alt combinations belong to JARVIS (tiling, menus), not here.
 */
export function keyAction(e, { kind = 'audio' } = {}) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key;
  const video = kind === 'video';
  switch (k) {
    case ' ': case 'Spacebar': case 'k': case 'K': return { type: 'toggle' };
    case 'ArrowLeft': return { type: 'seek', by: e.shiftKey ? -30 : -5 };
    case 'ArrowRight': return { type: 'seek', by: e.shiftKey ? 30 : 5 };
    case 'j': case 'J': return { type: 'seek', by: -10 };
    case 'l': case 'L': return { type: 'seek', by: 10 };
    case 'ArrowUp': return { type: 'volume', by: 0.1 };
    case 'ArrowDown': return { type: 'volume', by: -0.1 };
    case 'm': case 'M': return { type: 'mute' };
    case 'f': case 'F': return video ? { type: 'fullscreen' } : null;
    case 'i': case 'I': return video ? { type: 'pip' } : null;
    case 'N': return e.shiftKey ? { type: 'next' } : null;
    case 'P': return e.shiftKey ? { type: 'prev' } : null;
    case '<': return { type: 'speed', dir: -1 };
    case '>': return { type: 'speed', dir: 1 };
    case 'Home': return { type: 'seekTo', at: 0 };
    case 'End': return { type: 'seekTo', at: Infinity };
    default:
      if (/^[0-9]$/.test(k)) return { type: 'seekPct', pct: Number(k) * 10 };
      return null;
  }
}

/**
 * Closing the player window: audio that is playing goes on in the menu bar's mini-player ('mini'); anything else stops
 * ('stop') — a video needs its window, and a paused or finished track was put down on purpose.
 */
export function closeOutcome({ kind, paused = true, ended = false } = {}) {
  return kind === 'audio' && !paused && !ended ? 'mini' : 'stop';
}

/**
 * What to tell Sir when a file will not play (MediaError codes: 1 aborted, 2 network, 3 decode, 4 not supported;
 * 0 = the load watchdog: nothing loaded in time). Every case offers the download link next to it.
 */
export function errorMessage(code, { name = '', nodeName = '' } = {}) {
  const ext = extOf(name).toUpperCase();
  const what = ext ? `this ${ext} file` : 'this file';
  switch (code) {
    case 1: return 'Playback was stopped before the file loaded.';
    case 2: return `Couldn't load ${what}${nodeName ? ` from ${nodeName}` : ''}: the connection dropped. Try again, or download it.`;
    case 3: return `This browser couldn't decode ${what} (an unsupported codec, or the file is damaged). Download it to play it in another app.`;
    case 0: return `${what[0].toUpperCase()}${what.slice(1)} isn't loading. This browser may not support it; download it to play it in another app.`;
    default: return `This browser can't play ${what}${ext === 'MKV' || ext === 'FLAC' ? ` (${ext} isn't supported here)` : ''}. Download it to play it in another app.`;
  }
}

/** The Media Session metadata (OS media keys, lock screen, the macOS Now Playing menu) for a track. */
export const sessionMeta = (track, nodeName = '') => ({ title: titleOf(track?.name || track?.path), artist: nodeName, album: folderName(track?.path) });

/**
 * One media element plays at a time: `claim(p)` makes `p` the one playing and pauses the one before it (any object with
 * pause()); `release(p)` forgets it when it is the current one. The player and the file browser's inline previews share it.
 */
export function createArbiter() {
  let cur = null;
  return {
    claim(p) {
      if (cur && cur !== p) { try { cur.pause(); } catch { /* gone */ } }
      cur = p;
    },
    release(p) { if (cur === p) cur = null; },
    current: () => cur,
  };
}
