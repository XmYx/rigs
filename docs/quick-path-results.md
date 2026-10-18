# Quick-task fast path: live results

`node scripts/e2e-quick-path.js` starts a scratch daemon from this checkout (not `~/.rigs/app`), sends three requests through the real `POST /api/local/jarvis/send` with pre-routing on, first on the fast path and then with `quick:false`, and prints a table from each request's trace and the usage ledger. It needs the real `claude` CLI, and it writes `docs/audits/quick-path-e2e.log`.

Run of 2026-10-18 (macbookpro, `timeToReplyMs`, cost = ledger `costUsd` of the turn):

| request | lane / model / effort | tools | fast | baseline (quick:false, Opus medium) | tokens fast / base | cost fast |
|---|---|---|---|---|---|---|
| web search (Node LTS) | quick · Sonnet 5.5 · medium | ToolSearch, WebSearch | 31.8 s | 50.3 s | 255k / 336k | $0.31 |
| tool use (magix-system load) | quick · Haiku 5.5 · low | ToolSearch, mesh_status, mesh_exec | 27.0 s | 27.1 s | 415k / 168k | $0.018 |
| report (machines and load) | quick · Sonnet 5.5 · medium | ToolSearch, mesh_status | 22.5 s | 51.4 s | 243k / 350k | $0.30 |

Traces: `tr-20261018-3c63fbd2246e`, `-1921f67e201f`, `-4e3d4e693b45` (fast); `-64cb8f22d49d`, `-2f50cbc343f9`, `-cfcaf2b462b3` (baseline). All six answered with route `answer`, with no project, task or handoff. The two earlier runs gave 33.0/23.0/21.6 s fast against 43.9/24.5/31.2 s baseline.

What it shows:
- Search and report are clearly faster on the fast path (about 1.5x to 2.3x). Both meet the 45 s target.
- The simple tool-use ask on Haiku misses the 20 s target: 23 to 27 s. It is no faster than the baseline. Part of that is the pre-router (about 15 s when the fallback router is used) and part is a `ToolSearch` round-trip before the first `mesh_*` call.
- Setting `ENABLE_TOOL_SEARCH=false` on the fast turn to skip `ToolSearch` was tried. It made the run slower (38 s, about 1M tokens), so it was reverted.
- Haiku is the cheapest by far ($0.018). Sonnet runs cost about $0.3 each here, mostly cache-read tokens of the persona and MCP tool prompt.
- Not measured: baseline cost in dollars (only its tokens are in the table).
