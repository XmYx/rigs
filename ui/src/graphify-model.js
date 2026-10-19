// Graphify window (graphify.js): the pure bits — ids, the header summary and when the window should be drawing.
// No DOM, so it runs under node --test (test/graphify.test.js).

export const GRAPHIFY_ID = 'graphify';
export const GRAPHIFY_TITLE = 'Graphify';

/** The two views of the window: how JARVIS is built and meant to work (default) and the live mesh. */
export const VIEWS = ['structure', 'mesh'];
export const DEFAULT_VIEW = 'structure';
export const VIEW_LABEL = { structure: 'Structure', mesh: 'Mesh' };
export const VIEW_KEY = 'rigs.graphify.view';
export const normalizeView = (v) => (VIEWS.includes(v) ? v : DEFAULT_VIEW);

/** "12 nodes · 14 links · 3 machines" for the window header. */
export function summarize(data) {
  const nodes = data?.nodes || [];
  const links = data?.links || [];
  const machines = nodes.filter((n) => n.type === 'machine' || n.type === 'offline').length;
  const parts = [`${nodes.length} node${nodes.length === 1 ? '' : 's'}`, `${links.length} link${links.length === 1 ? '' : 's'}`];
  if (machines) parts.push(`${machines} machine${machines === 1 ? '' : 's'}`);
  return { nodes: nodes.length, links: links.length, machines, text: parts.join(' · ') };
}

/** "58 nodes · 91 links · 5 lanes" for the Structure view's header. */
export function summarizeStructure(data) {
  const nodes = (data?.nodes || []).filter((n) => n.type !== 's-lane'); // lane titles are labels, not components
  const links = data?.links || [];
  const lanes = new Set(nodes.map((n) => n.lane).filter(Boolean)).size;
  const decisions = nodes.filter((n) => n.type === 's-decision').length;
  const parts = [`${nodes.length} node${nodes.length === 1 ? '' : 's'}`, `${links.length} link${links.length === 1 ? '' : 's'}`];
  if (lanes) parts.push(`${lanes} lane${lanes === 1 ? '' : 's'}`);
  if (decisions) parts.push(`${decisions} decision${decisions === 1 ? '' : 's'}`);
  return { nodes: nodes.length, links: links.length, lanes, decisions, text: parts.join(' · ') };
}

/** The graph only renders (and only gets fresh data) while the window is open and expanded. */
export const shouldRun = ({ closed, collapsed } = {}) => !closed && !collapsed;
