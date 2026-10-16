import { config } from './config.js';
import { bin, ollamaModels } from './tools.js';

/**
 * Model catalog: which providers this machine can run, their models and reasoning-effort levels,
 * and how each harness takes them on the command line. Model lists move fast, so the defaults
 * here can be extended per machine with `models.<provider>` in ~/.rigs/config.json, and any
 * exact model id typed in the UI is passed through as-is.
 */

export const PROVIDERS = {
  claude: {
    label: 'Claude Code', runtime: 'claude-code',
    models: ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  codex: {
    label: 'Codex', runtime: 'codex',
    models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-pro', 'gpt-5.6-terra', 'gpt-5.1-codex-max'],
    efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  ollama: {
    label: 'Ollama (local)', runtime: null,
    models: [],
    // Ollama's `think` option: off, on, or a level for models that support levels (gpt-oss).
    efforts: ['off', 'on', 'low', 'medium', 'high'],
  },
};

export function claudeFlags({ model, effort } = {}) {
  const a = [];
  if (model) a.push('--model', model);
  if (effort && PROVIDERS.claude.efforts.includes(effort)) a.push('--effort', effort);
  return a;
}

export function codexFlags({ model, effort } = {}) {
  const a = [];
  if (model) a.push('-m', model);
  if (effort && PROVIDERS.codex.efforts.includes(effort)) a.push('-c', `model_reasoning_effort="${effort}"`);
  return a;
}

/** Value for Ollama's `think` request field, or undefined to leave it out. */
export function ollamaThink(effort) {
  if (!effort || effort === 'off') return undefined;
  if (effort === 'on') return true;
  return effort;
}

/** Providers available on THIS machine with their models and efforts (for the UI and the router). */
export async function catalog() {
  const extra = config().models || {};
  const out = [];
  if (bin('claude')) out.push({ id: 'claude', ...PROVIDERS.claude, models: uniq([...(extra.claude || []), ...PROVIDERS.claude.models]) });
  if (bin('codex')) out.push({ id: 'codex', ...PROVIDERS.codex, models: uniq([...(extra.codex || []), ...PROVIDERS.codex.models]) });
  const o = await ollamaModels();
  if (o.running) out.push({ id: 'ollama', ...PROVIDERS.ollama, models: o.models.map((m) => m.name), details: o.models });
  return out;
}

function uniq(a) { return [...new Set(a.filter(Boolean))]; }

/** The machine's default "core brain" (JARVIS + planner). */
export function coreBrain() {
  const b = config().brain;
  return { provider: b.core?.provider || 'auto', model: b.core?.model || '', effort: b.core?.effort || '', node: b.core?.node || '' };
}
