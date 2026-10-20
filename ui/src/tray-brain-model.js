// The JARVIS tray menu's pure mapping: brain catalog (entry.brains from the mesh snapshot) + current selection → menu entries.
// Codex is switched off as a JARVIS brain, so it is never offered here.

export const TRAY_PROVIDERS = ['claude', 'claude-ollama', 'ollama'];
const blank = (v) => (v == null ? '' : String(v));

/** Providers the menu offers; unavailable ones stay in the list, disabled, with their `reason`. */
export function providerChoices(brains = [], current = {}) {
  return TRAY_PROVIDERS.map((id) => brains.find((b) => b.id === id)).filter(Boolean).map((b) => ({
    id: b.id, label: b.label, checked: b.id === current.brain, disabled: b.available === false, reason: b.available === false ? blank(b.reason) : '',
  }));
}

/** Models of one provider. The provider's default shows for an empty selection; models without tool support get a note on claude-ollama. */
export function modelChoices(brain, current = {}) {
  if (!brain) return [];
  const sel = current.brain === brain.id ? blank(current.model) || blank(brain.default) : '';
  const tools = new Set(brain.toolModels || []);
  return (brain.models || []).map((m) => ({ id: m, label: brain.id === 'claude-ollama' && tools.has(m) ? `${m} · tools` : m, checked: m === sel, disabled: brain.available === false, reason: brain.available === false ? blank(brain.reason) : '' }));
}

/** Effort levels of one provider (none for claude-ollama); '' = the provider's default. */
export function effortChoices(brain, current = {}) {
  const levels = brain?.efforts || [];
  if (!levels.length) return [];
  const sel = current.brain === brain.id ? blank(current.effort) : blank(brain.defaultEffort);
  return levels.map((e) => ({ id: e, label: e, checked: e === sel }));
}

/** What a pick turns into: the selection `setBrain` takes. Switching provider resets to that provider's defaults. */
export function pickBrain(entry, brain, patch = {}, current = {}) {
  const same = current.brain === brain.id;
  return {
    nodeId: entry.node.id, nodeName: entry.node.name, brain: brain.id,
    model: patch.model ?? (same ? blank(current.model) : blank(brain.default) || (brain.id === 'ollama' || brain.id === 'claude-ollama' ? blank(brain.models?.[0]) : '')),
    effort: brain.id === 'claude-ollama' ? '' : patch.effort ?? (same ? blank(current.effort) : blank(brain.defaultEffort)),
  };
}

/** Tooltip + short badge for the tray icon. */
export function brainSummary(current) {
  if (!current) return { badge: '', title: 'JARVIS — no brain available' };
  const model = (blank(current.model) || current.brain).replace(/^claude-/, '').replace(/:latest$/, '');
  const effort = blank(current.effort);
  return { badge: model, title: `JARVIS brain: ${model}${effort ? ` · ${effort}` : ''} on ${current.nodeName}` };
}
