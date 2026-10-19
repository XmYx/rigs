// Graphify window (graphify.js): the pure bits — ids, the header summary and when the window should be drawing.
// No DOM, so it runs under node --test (test/graphify.test.js).

export const GRAPHIFY_ID = 'graphify';
export const GRAPHIFY_TITLE = 'Graphify';

/** "12 nodes · 14 links · 3 machines" for the window header. */
export function summarize(data) {
  const nodes = data?.nodes || [];
  const links = data?.links || [];
  const machines = nodes.filter((n) => n.type === 'machine' || n.type === 'offline').length;
  const parts = [`${nodes.length} node${nodes.length === 1 ? '' : 's'}`, `${links.length} link${links.length === 1 ? '' : 's'}`];
  if (machines) parts.push(`${machines} machine${machines === 1 ? '' : 's'}`);
  return { nodes: nodes.length, links: links.length, machines, text: parts.join(' · ') };
}

/** The graph only renders (and only gets fresh data) while the window is open and expanded. */
export const shouldRun = ({ closed, collapsed } = {}) => !closed && !collapsed;
