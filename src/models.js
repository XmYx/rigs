import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { bin, ollamaModels } from './tools.js';
import { HOME } from './util.js';

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
  // The Claude Code harness (`claude -p`) pointed at Ollama's Anthropic-compatible endpoint: Claude's tools and
  // stream, a local model. No effort levels (Claude's `--effort` is Anthropic-side), no cost.
  'claude-ollama': {
    label: 'Claude via Ollama', runtime: 'claude-code',
    models: [],
    efforts: [],
  },
};

export function claudeFlags({ model, effort, permissionMode } = {}) {
  const a = [];
  if (model) a.push('--model', model);
  if (effort && PROVIDERS.claude.efforts.includes(effort)) a.push('--effort', effort);
  if (permissionMode) a.push('--permission-mode', permissionMode);
  return a;
}

/** The local-model brain id (PROVIDERS key, `brain` in chats, `provider` in traces and the usage ledger). */
export const CLAUDE_OLLAMA = 'claude-ollama';
const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

/** Where Claude Code is sent: `brain.claudeOllama.url`, else the Ollama URL of the ollama brain. No trailing slash. */
export function claudeOllamaUrl(brain = config().brain) {
  return String(brain?.claudeOllama?.url || brain?.ollamaUrl || OLLAMA_DEFAULT_URL).replace(/\/+$/, '');
}

/**
 * Environment overrides for the `claude` child process only (merged over the cleaned process env; never written to
 * Claude's settings). Ollama ignores the token, so it is a fixed dummy — and every real credential Claude would
 * otherwise pick up from the environment is blanked, so nothing real is sent to the local endpoint. The model is also
 * the alias of every Claude tier, so side calls (titles, summaries) go to the local model instead of "haiku".
 */
export function claudeOllamaEnv({ url, model } = {}) {
  const env = {
    ANTHROPIC_BASE_URL: String(url || claudeOllamaUrl()).replace(/\/+$/, ''),
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (model) {
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) env[k] = model;
  }
  return env;
}

/** `claude` flags for the local brain: the model only (no `--effort`; permission mode is added by the caller). */
export function claudeOllamaFlags({ model } = {}) {
  return model ? ['--model', model] : [];
}

/** Default local model: a tool-capable one (Claude Code is all tool calls), else the first that can chat. */
export function pickClaudeOllamaModel(models = []) {
  const chat = models.filter((m) => !(m.capabilities?.length && !m.capabilities.includes('completion')));
  return (chat.find((m) => m.capabilities?.includes('tools')) || chat[0] || models[0] || {}).name || '';
}

/** Why the local brain can or can't run right now, for the settings hint and the turn's error. Pure. */
export function claudeOllamaStatus({ claude, ollama, url, models = [], model = '' }) {
  const names = models.map((m) => m.name);
  if (!claude) return { available: false, reason: 'The claude CLI is not installed on this machine.' };
  if (!ollama) return { available: false, reason: `Ollama is not reachable at ${url}. Start it with \`ollama serve\`.` };
  if (!names.length) return { available: false, reason: 'Ollama is running but has no models — `ollama pull qwen3-coder`.' };
  if (model && !names.includes(model)) return { available: true, reason: '', warning: `${model} is not installed in Ollama (installed: ${names.slice(0, 5).join(', ')}).` };
  return { available: true, reason: '' };
}

export function codexFlags({ model, effort, sandbox, approval, network } = {}) {
  const a = [];
  if (model) a.push('-m', model);
  if (effort && PROVIDERS.codex.efforts.includes(effort)) a.push('-c', `model_reasoning_effort="${effort}"`);
  if (sandbox) a.push('-s', sandbox);
  if (approval) a.push('-a', approval);
  if (network && sandbox === 'workspace-write') a.push('-c', 'sandbox_workspace_write.network_access=true');
  return a;
}

/** Permission flags for interactive agents RIGS starts (config.agents — "auto" by default). */
export function agentModes() {
  const g = config().agents || {};
  return {
    claude: { permissionMode: g.claudePermissionMode || 'auto' },
    codex: { sandbox: g.codexSandbox || 'workspace-write', approval: g.codexApproval || 'on-request', network: g.codexNetwork !== false },
  };
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
  if (bin('codex')) out.push({ id: 'codex', ...PROVIDERS.codex, models: uniq([...(extra.codex || []), ...PROVIDERS.codex.models]), signedIn: codexSignedIn() });
  const o = await ollamaModels();
  if (o.running) out.push({ id: 'ollama', ...PROVIDERS.ollama, models: o.models.map((m) => m.name), details: o.models });
  if (bin('claude')) {
    const url = claudeOllamaUrl();
    const st = claudeOllamaStatus({ claude: true, ollama: o.running, url, models: o.models });
    const saved = config().brain.claudeOllama?.model;
    const tools = o.models.filter((m) => m.capabilities?.includes('tools')).map((m) => m.name);
    out.push({
      id: CLAUDE_OLLAMA, ...PROVIDERS[CLAUDE_OLLAMA], models: o.models.map((m) => m.name), details: o.models, toolModels: tools, url,
      default: o.models.some((m) => m.name === saved) ? saved : pickClaudeOllamaModel(o.models),
      available: st.available, ...(st.reason ? { reason: st.reason } : {}),
    });
  }
  return out;
}

function uniq(a) { return [...new Set(a.filter(Boolean))]; }

/** Codex can only work with credentials: a login (auth.json) or an API key. Installed-but-signed-out is not available. */
export function codexSignedIn() {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return true;
  return fs.existsSync(path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'auth.json'));
}

/** JARVIS's conversational brain: casual chat and replies to the user (fast, cheap). Heavy work is delegated. */
export function chatBrain() {
  const b = config().brain;
  const c = b.chat || {};
  return { provider: c.provider || 'claude', model: c.model || 'claude-haiku-5-5', effort: c.effort || 'low' };
}

/** The machine's default "core brain" (JARVIS + planner). */
export function coreBrain() {
  const b = config().brain;
  return { provider: b.core?.provider || 'auto', model: b.core?.model || '', effort: b.core?.effort || '', node: b.core?.node || '' };
}
