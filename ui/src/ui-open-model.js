// The `ui-open` push (src/ui-open.js, MCP ui_open) → what main.js does with it. Pure (test/ui-open.test.js).
// A new view = a name in VIEWS and a branch in uiOpenAction; main.js's onUiOpen runs the result.
import { mediaKind } from './media-player-model.js';
import { toolFor } from './file-tools-model.js';

export const VIEWS = ['files', 'app', 'url', 'project', 'trace', 'model', 'tool'];

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

/** Tools a file opened with `files` gets on top of Finder + preview: the 3D viewer, and the pdf / csv / json tools (never the editor or image viewer). */
export const AUTO_TOOLS = ['model', 'pdf', 'csv', 'json'];

/**
 * A ui-open push → the action for its view, or null when it is not one this UI can open. `machines` are the mesh's
 * machines ({ id, name }), for the window title when the push only names an id.
 * files → { id, view, nodeId, nodeName, path, select, showHidden, play, tool, toast }: `play` = the audio or video
 * file the push named (it is the selected file, not a fallback): the media player opens it instead of the file
 * browser; `tool` = the tool a selected .glb/.gltf/.obj (3D viewer), .pdf, .csv or .json opens in as well.
 * app → { view, app, name, nodeId, nodeName, path }; url → { view, url, title }; project → { view, project, nodeId };
 * trace → { view, trace }; model → { view, nodeId, nodeName, path, title }; tool → { view, nodeId, nodeName, path, tool, title }.
 */
export function uiOpenAction(m, { machines = [] } = {}) {
  if (!m || m.type !== 'ui-open' || !VIEWS.includes(m.view)) return null;
  const known = machines.find((x) => x.id === m.nodeId) || machines.find((x) => x.name === m.nodeName);
  const nodeId = known?.id || m.nodeId || '';
  const nodeName = known?.name || m.nodeName || m.nodeId || '';
  const id = String(m.id || '');
  const title = String(m.title || '');
  switch (m.view) {
    case 'files': {
      if (!m.nodeId || !m.path) return null;
      const select = String(m.select || '');
      const picked = select && !m.missing ? select : '';
      const t = picked ? toolFor(picked) : null;
      return {
        id, view: 'files', nodeId, nodeName, path: String(m.path), select,
        // A dotfile to select only shows with hidden files on.
        showHidden: !!select && baseName(select).startsWith('.'),
        play: picked && mediaKind(picked) ? picked : '',
        tool: picked && AUTO_TOOLS.includes(t) ? t : '',
        toast: m.missing ? `${m.requested || 'That path'} isn't on ${nodeName}; opened ${m.path} instead.` : '',
      };
    }
    case 'app': {
      if (!m.app) return null;
      return { id, view: 'app', app: String(m.app), name: String(m.name || m.app), nodeId, nodeName, path: String(m.path || ''), title };
    }
    case 'url': {
      if (!m.url) return null;
      return { id, view: 'url', url: String(m.url), title: title || String(m.url) };
    }
    case 'project': {
      if (!m.project) return null;
      return { id, view: 'project', project: String(m.project), nodeId, nodeName };
    }
    case 'trace': {
      if (!m.traceId) return null;
      return { id, view: 'trace', trace: String(m.traceId) };
    }
    case 'model':
    case 'tool': {
      if (!m.nodeId || !m.path) return null;
      const tool = m.view === 'model' ? 'model' : String(m.tool || toolFor(m.path) || '');
      if (!tool) return null;
      return { id, view: m.view, nodeId, nodeName, path: String(m.path), name: baseName(m.path), tool, title };
    }
    default: return null;
  }
}

/**
 * Which open file-browser window gets the push: the one for that machine (navigate it), else none (open a new one).
 * `wins` = Map nodeId → window handle; a closed handle is skipped.
 */
export function filesTarget(wins, nodeId) {
  const w = wins?.get?.(nodeId);
  return w && !w.closed ? w : null;
}

/**
 * Asks to open or show a folder or file ("open my Downloads folder", "show me what's in ~/Documents"): JARVIS answers them
 * with ui_open, so main.js's local shortcuts (focus a graph node, open a pinned project) leave them alone. Those match
 * by name, and JARVIS's own past turns are session nodes named after Sir's requests: "show me what's in ~/Documents"
 * asked twice would focus the first one's session instead of opening the folder.
 */
export const isBrowseAsk = (text) => /(?:^|[\s"'(])(?:~|\/|[a-z]:\\)|\b(?:folders?|director(?:y|ies)|files?|downloads|documents)\b|\bwhat(?:'|’)?s in\b/i.test(String(text || ''));

/** Trace ids this UI sent, newest last, capped (re-claimed on every reconnect). */
export function addClaim(list = [], traceId, cap = 20) {
  if (!/^tr-\d{8}-[0-9a-f]{12}$/.test(String(traceId || '')) || list.includes(traceId)) return list;
  return [...list, traceId].slice(-cap);
}
