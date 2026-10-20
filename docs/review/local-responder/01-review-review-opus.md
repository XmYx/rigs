# Review t5: local live responder against the goal

Reviewer: team-review-opus (claude-opus-5-5), 2026-10-20. Branch `work/magix-system/local-live-speaking-llm-respon-fd2b`,
reviewed at 23c3e39; fixes committed in 197a872.

Goal: an optional local live speaking LLM on magix-system that uses some tools, answers first in place of Haiku when
enabled, and leaves routing and task handling untouched.

**Verdict: meets the goal, ready for the merge steward once two small conflicts with today's main are resolved
(below).** It is optional (off by default), the core files are untouched, the off-path is today's Haiku lane, and
the on-path, the fallbacks, speech and access from macbookpro work. One correctness defect (live-data questions) was
fixed during the review. Three medium items stay open.

## Checks

| check | result |
| --- | --- |
| `npm test` | 826/826 at 23c3e39; **827/827** at 197a872 (final clean run). Three intermediate runs had `EADDRINUSE` boot failures in `smoke`, `appproxy` and `trace` tests, see I-4. Each file passes on its own. |
| `npm run build` | OK |
| router.js, planner.js, work.js, hubs.js, autonomy.js | `git diff origin/main` and `git diff 677facc` (merge base) are empty. The local `main` ref is stale (2026-10-17), so `git diff main` shows unrelated drift from other merges. |
| quick/router/preroute tests | unchanged since the merge base, all pass |
| feature off | Haiku answers (`tier haiku`, no local start, no `fallback`): tr-20261020-8dbf9c19c120, tr-20261020-05e1ed27a633 |
| on: local answers | greeting tr-20261020-378b4044eb91, fact tr-20261020-318c5f48e0fa, tr-20261020-045a88306f3b: `ollama qwen3:8b`, tier local, cost 0 |
| on: tool use | `mesh_status` tr-20261020-25fe0b20208d (real result in the tool-call span) |
| on: escalation | tr-20261020-9d5552f3081f: `[[ESCALATE]]` → reset → full brain answered. A/B: "Build me a small todo web app" escalates 3/3. |
| Haiku fallback, Ollama down | dead `brain.ollamaUrl`: detected in 10–27 ms, Haiku answers, `responder-fallback` event span, request `fallback` reason in the ledger: tr-20261020-297cc610c1cf, tr-20261020-3d6ec23674b0 |
| Haiku fallback, slow first token | occurred naturally under the shared GPU: tr-20261020-ad7c34929d71, tr-20261020-5a71104a95fa |
| TTS fallback | `jarvis-voice` registered on a dead port: health `down`, `/api/local/tts` 200 with `x-tts-engine: piper`, 76–88 ms, no error |
| macbookpro → host route | `curl` over the tailnet to magix-system `/api/local/responder/turn` with the mesh token: "Canberra, sir." in 288 ms round trip |
| macbookpro caller (`remoteTurn`) | scratch daemon from 197a872 on macbookpro, `local.node` = the magix-system host: tr-20261020-a5f94046bc42 (275 ms turn), tr-20261020-c569e78a49f9 (`mesh_sessions` ran on the host, tool span on the caller), host not in the mesh → Haiku: tr-20261020-c3d368d469e8. Relayed to the main brain, which hosts the model: tr-20261020-9c89b59ef2e7 |
| docs vs code | §5.2, §5.5 and §5.6 corrected, duplicate §7 renumbered; AGENTS.md rows match |

Traces are on the scratch nodes (magix-system scratch RIGS_HOME, macbookpro `/tmp/rv-t5-home`), not in the real mesh
trace store. Scratch daemons ran with `RIGS_NO_MIGRATIONS=1` and `openrig.keepDaemon: false`. The real configs
(`globalRev` by macbookpro, no `quick.local`) and `~/.ssh` are unchanged.

## Fixed in 197a872

1. **HIGH: live-data questions answered by guessing.** With the responder on, Haiku-tier asks about weather, prices or
   scores went to qwen3:8b, which has no web tool. "What's the weather in Budapest right now?" got "sunny with a high of
   22°C" (tr-20261020-4fc3f918c94b); Haiku would have searched. Prompt-only fixes do not hold on an 8B model (A/B with
   the real `localTurn`, 3 runs per ask):

   | prompt | mesh asks call a tool | live-data asks escalate | general knowledge answered |
   | --- | --- | --- | --- |
   | as built | 15/15 | 0/9 (declines) | 6/6 |
   | + "no internet, escalate current information" | 14/15 | 7/9 | **0/6** (escalates "external information") |
   | + "answer general knowledge, escalate what changes daily" | 15/15 | 0/9 (declines) | 15/15 |

   Fix: pure `quick.liveInfo(text)`. `localResponder` keeps such asks on the Claude tier (weather, forecast, rain, snow,
   prices, stocks, exchange rates, bitcoin/crypto, scores, headlines, traffic, flights, elections), and `quick: 'local'`
   still forces the local model. "latest", "news" and "search" already pick the Sonnet tier. The prompt is unchanged.
   Verified live: weather tr-20261020-f0dfbf97b48c and Bitcoin tr-20261020-ba60749cfcff were answered by Haiku with
   WebSearch. Unit test in `test/local-responder.test.js`.
2. **LOW: `rigs quick local status`** exited 1 with only the error when the host's Ollama was unreachable. It now prints
   the status line with the reason.
3. **LOW: docs.** §5.6 now gives the host-route body/events as built (`context` is `{role, content}`, `local` is passed
   on, there are no `start`/`status` events, `tool-result` and `ping` are added) and the trace (the caller records the
   tool spans; the host writes none). §5.5: the first-token timer is in `localTurn`. §5.2: added `warm`. The second
   "§7" is renumbered.

## Open

- **O-1 MEDIUM: the first switch-on picks the wrong host from macbookpro.** `POST /api/local/quick` with no `node`
  makes the machine it was switched on at the host. Sir's UI and main brain are on macbookpro, whose Ollama has only
  `aya` (no qwen3:8b). Switching on there makes macbookpro the host: a red dot ("qwen3:8b is not installed"), and every
  turn silently falls back to Haiku. The toggle has no host picker. Workaround: `rigs quick local node magix-system`.
  Fix: choose a host whose Ollama has the model, or add a host selector to the toggle.
- **O-2 MEDIUM: Ollama's prompt cache breaks every minute.** In qwen3's template the tool definitions come *after* the
  system text, and the system text ends with the clock line. `warm()` also sends no tools. Measured with the GPU shared
  with ComfyUI: 346 ms prompt eval for a repeat in the same minute, 733–878 ms after the clock changes or for the first
  real turn after a warm-up. That adds ~0.4–0.5 s to almost every turn and feeds the 2.5 s first-token fallbacks. Fix:
  move the clock out of the system prompt (into the user turn), send the tool definitions in `warm()`, re-run
  `responder-bench`.
- **O-3 MEDIUM: accuracy of mesh facts.** With a real `mesh_status` result in hand, qwen3:8b said "the Unity editor is
  running" (`unity.running: false`, only installed) and left out ComfyUI (tr-20261020-25fe0b20208d; again from
  macbookpro, tr-20261020-9c89b59ef2e7). In a long thread, "Which apps are down?" was answered with invented "App A/B/C"
  without a tool call (tr-20261020-58b61c0427ac); with no history it calls the tool 3/3. Spoken parts sometimes carry
  markdown lists. Ideas: slimmer per-tool projections for the responder (for example mesh_status → name, online, which
  tools are *running*), fewer context messages.
- Known from t4: localjev's qwen2.5vl and the ComfyUI lease evict qwen3:8b, so the responder falls back often while the
  GPU is leased. The GPU overseer client entry (outside the repo) is still to do.

## Merge with today's main (for the steward's resolver)

`git merge-tree origin/main HEAD` reports two content conflicts. Both are small:
- `AGENTS.md`: both sides added rows after the UI rows (main: `ui/src/cloud.js`, `ui/src/cleanup.js`; branch:
  `ui/src/local-responder*.js`). Keep all three.
- `ui/src/main.js` `conversationWindow`: main capped the shown messages (`older`, `CAPS.chatMessages`); the branch added
  `${x.tier === 'local' ? ' · local' : ''}` to the label. Keep main's line and add the suffix after the model.
`ask()` is still the only `jarvis/send` stream handler on main, so the reply label also works in the new Ask JARVIS
panel.

## Info

- I-1: `hostTurn` takes the caller's `local` settings (model, `numCtx` up to 131072, `keepAlive`). Any caller allowed
  through `src/auth.js` (loopback, same-owner tailnet device, or the mesh token) picks what the host's Ollama loads. Tools
  are limited to `READ_ONLY_TOOLS`, not to the host's own narrower list.
- I-2: a fallback writes a `failed` chat-turn record for the local attempt (cost 0) next to the Haiku one, which usage
  views may count as a failure.
- I-3 (pre-existing): throwaway daemons still register their peers as OpenRig hosts in the real `~/.openrig/hosts.yaml`
  (`openrig.registerPeers`; `RIGS_NO_MIGRATIONS` does not gate it). The review's scratch caller added `rv-host` on
  macbookpro; removed (backup `/tmp/rv-t5-home/hosts.yaml.before-cleanup`). magix-system's list has an unreachable
  `app-node` entry from an earlier test, left as is.
- I-4 (pre-existing): `smoke`, `appproxy` and `trace` tests pick random ports in 20000–40000, which overlaps Linux's
  ephemeral range (32768+). Under loopback load that gives `EADDRINUSE` at boot.
- I-5 (pre-existing): `POST /api/local/quick` stamps the mesh-global revision only when `local` changes; plain tier
  edits still don't propagate until another global change.
- Retracted during the review: "the narration guard's system-role NUDGE is not rendered". A direct test shows qwen3:8b
  receives and follows it.
