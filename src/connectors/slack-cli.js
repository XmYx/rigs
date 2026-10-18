// Slack connector — the pieces shared by `rigs connectors slack …` and the JARVIS (MCP) tools. Pure, tested in
// test/slack-cli.test.js. Both talk to the local daemon's /api/local/connectors/slack/* routes (src/connectors/slack.js).
// Only reads are offered to agents as tools; posting is the CLI's `post … --confirm`, never a tool.

export const SLACK_USAGE = `usage: rigs connectors slack status [--no-check]
       rigs connectors slack channels [--limit N]
       rigs connectors slack history <#channel|id> [--limit N] [--since <ts|epoch|ISO date>]
       rigs connectors slack search <query> [--count N]
       rigs connectors slack post <#channel|id> <text…> [--thread <ts>] --confirm   (posts only with --confirm)`;

/** Split argv into positionals and --flags (`--k v`, `--k=v`, bare `--k` = true). */
function split(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (['confirm', 'no-check'].includes(a.slice(2)) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[a.slice(2)] = true;
      else flags[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
const BASE = '/api/local/connectors/slack';

/** Args after `rigs connectors slack` → { method, path, body? } or { error }. */
export function parseSlackArgs(argv = []) {
  const [sub, ...rest] = argv;
  const { pos, flags } = split(rest);
  const bad = (m) => ({ error: `${m}\n${SLACK_USAGE}` });
  if (sub === 'status') return { method: 'GET', path: `${BASE}/status${qs({ check: flags['no-check'] ? 0 : undefined })}` };
  if (sub === 'channels') return { method: 'GET', path: `${BASE}/channels${qs({ limit: flags.limit })}` };
  if (sub === 'history') {
    if (!pos[0]) return bad('history needs a channel');
    return { method: 'GET', path: `${BASE}/history${qs({ channel: pos[0], limit: flags.limit, oldest: flags.since })}` };
  }
  if (sub === 'search') {
    if (!pos.length) return bad('search needs a query');
    return { method: 'GET', path: `${BASE}/search${qs({ query: pos.join(' '), count: flags.count })}` };
  }
  if (sub === 'post') {
    if (!pos[0] || pos.length < 2) return bad('post needs a channel and text');
    if (flags.confirm !== true) return bad('post sends a real message: add --confirm');
    return { method: 'POST', path: `${BASE}/post`, body: { channel: pos[0], text: pos.slice(1).join(' '), thread_ts: flags.thread || undefined, confirm: true } };
  }
  return bad(sub ? `unknown subcommand "${sub}"` : 'missing subcommand');
}

/** The read-only JARVIS tools (MCP format). `api(path)` is the MCP server's daemon call. No post tool, on purpose. */
export function slackTools(api) {
  const channel = { type: 'string', description: 'channel id (C…) or name, with or without #' };
  return [
    {
      name: 'slack_status', description: 'Is the Slack connector set up, and for which workspace (configured, team, bot user, last checked)? Never returns the token. Use before other slack_* tools when unsure.',
      inputSchema: { type: 'object', properties: {} },
      run: () => api(`${BASE}/status`),
    },
    {
      name: 'slack_channels', description: 'List the Slack channels the bot can see (id, name, private, member count, topic).',
      inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'default 200' } } },
      run: (a) => api(`${BASE}/channels${qs({ limit: a.limit })}`),
    },
    {
      name: 'slack_history', description: 'Read recent messages of one Slack channel, newest first — e.g. "what was said in #general today": channel "general", since = start of today (ISO date or epoch seconds). Read-only.',
      inputSchema: { type: 'object', properties: { channel, limit: { type: 'number', description: 'default 50' }, since: { type: 'string', description: 'only messages after this time: Slack ts, epoch seconds or ISO date' } }, required: ['channel'] },
      run: (a) => api(`${BASE}/history${qs({ channel: a.channel, limit: a.limit, oldest: a.since })}`),
    },
    {
      name: 'slack_search', description: 'Search Slack messages across the workspace (needs a Slack user token; the error says so if only a bot token is set). Read-only. Posting to Slack is not available as a tool.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] },
      run: (a) => api(`${BASE}/search${qs({ query: a.query, count: a.count })}`),
    },
  ];
}
