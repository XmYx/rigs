# Request → Result: optimization plan — 2026-10-22

Goal, in Sir's words: reduce the time and effort it takes to fulfil a request, and tie the system together so that
every request ends in something visible — a model training brings up a live dashboard with charts, a 3D object is
made in Blender and shown in the RIGS UI, and ordinary asks (open this, copy that, make me a thing) are handled
quickly and interactively.

This document records what the live mesh looked like, where the time went, and what this change does about it.
Branch: `work/macbookpro/request-to-result`.

## 1. State of the rig (as found)

- Mesh: `macbookpro` (M1, core brain) and `magix-system` (RTX 4090, ComfyUI, Blender 5.0.1, TRELLIS.2 via
  the props-studio app) online; one Mac offline; an iPhone. Both nodes on `003e1cb`.
- OpenRig: daemon up, 53 rigs on disk, most with snapshots days old. The `jarvis` overseer rig is RUNNING, yet
  `hubs.keep()` tried `rig up` on it repeatedly and logged `rig_name_running` / "Daemon did not respond".
- Projects: 129 (108 done, 10 blocked, 6 paused, 4 planned, 1 running). Merge steward on `magix-system`: 91
  requests, 87 merged.
- Usage last 7 days: $57. Planning calls alone were $34.8 (126 calls, Opus high); chat turns $22.
- Pre-routing is **losing** time: router median 8.6 s on answers, 13.4 s on work, total −4.2 s per request.
- The daemon log (8.7k lines): 1182 lines of `merge status: magix-system is offline` (one per 20 s tick while
  the steward was away), 788×2 `cannot listen … EADDRNOTAVAIL` (stale Tailscale IPs retried every 30 s),
  8× `Body Matching … did not answer /healthz within 60s` (its Python API needs minutes to import torch),
  TTS piper/neural fallbacks, and the `rig up` loop above.

## 2. Where the time goes (measured)

| Request | Total | Router | Brain | Note |
|---|---|---|---|---|
| "show the last 10 uefa winners" | 36.7 s | 9.9 s (Haiku) | 9.4 s (Haiku) | 17 s intake→router gap (cold caches) |
| "show me the v3b … model in files" | 60.6 s | 6.8 s | 51 s | 42 s inside `find ~` on magix, path was already in the project record |
| "yolo a calculator" | 40 s | rules | 40 s (Sonnet high) | fine |
| plan requests | 45–92 s before the first task starts | | Opus high, full persona + all tools | then a mandatory review task |

A trivial Haiku call through `claude -p` costs **5.3 s** with the user's MCP servers loaded (rigs + REA via
`npx rea-agents`) and **2.5 s** with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`. Every spawn on the
request path (router, quick turn, YOLO turn, planner turn) paid the 3 s.

Ranked sinks (from the pipeline survey, file:line in `~/.rigs/app`):

1. The main thread's `--append-system-prompt` carries the clock to the minute and live cpu/mem per node
   (chat.js:194, server.js:293), so the Opus prompt cache is invalidated on **every** resumed turn.
2. Every turn is a cold `claude -p` that boots every MCP server, including `npx -y rea-agents` (chat.js:260).
3. `jarvis/send` does serial mesh I/O before routing: `projectsSummary` (full mesh snapshot when its 30 s cache
   is stale), `ongoingThreads` (reads all 99 chat files), `meshWorkspaces` (45 s per-peer timeout).
4. `jarvis_task` holds the brain's reply until the agent seat is live: `rig up`/`rig add` up to 300 s plus polling.
5. A mandatory final review task doubles every project, even a one-task plan (planner.js:213).
6. The planning call is a full agentic JARVIS turn (persona, all tools, no turn limit, Opus high).
7. The planner tick polls every task serially with 20 s timeouts; `followMerge` logs every tick while the steward is away.
8. Quick-lane escalation is serial: a stuck quick turn burns the full 90 s before Opus starts.
9. Fixed polling: app health every 5 s for every app, 60 s start wait, attention captures serial.
10. `trace.readSpans` re-reads whole day files (13 MB) for every poll and run end.

And on the "visible result" side (UI survey): `ui_open` can only open the file browser; there is no generic
"show this HTML / URL / chart / 3D model in a window" primitive; the `route` event's filed project is ignored by
the UI; tool chips never resolve; completion notices cannot carry an "Open" action; `.glb/.gltf/.obj` have no viewer.

## 3. The plan

Four waves, implemented together on this branch. Each item names the files it owns.

### Wave A — the fast lane (router.js, chat.js, quick.js, tools.js, server.js, main-chat.js)

- A1. **Router spawn without MCP or tools**: `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools ''
  --no-session-persistence`. Expected: 8–10 s → 3–4 s.
- A2. **Rules first**: a clear browse request, a clear question with no ongoing-thread overlap, or a YOLO marker is
  decided by the keyword rules at once (`via: rules`, routerMs ≈ 0). The model router only sees ambiguous asks.
  Guarded by `config.router.rulesFirst` (default on); the quick lane's `[[ESCALATE]]` and `guardRoute` catch misses.
- A3. **Parallel, capped context prep**: `ongoingThreads`, workspaces and projects summary run with `Promise.all`,
  stale-while-revalidate caches, and a ~1.5 s cap falling back to the last-known value. `listChats` gets an
  mtime-checked in-memory index. Ollama `/api/tags` cached 30 s.
- A4. **Stable system prompt**: clock, live stats and the project list move out of `--append-system-prompt` into a
  short prefix of the user message, so the resumed main thread keeps its prompt cache.
- A5. **Lean MCP for bounded turns**: quick and YOLO turns load only the `rigs` MCP server (`--strict-mcp-config`
  with a generated config); the main thread keeps the user's full set.
- A6. **Quick-lane watchdog**: no delta or tool call for 20 s → abort the quick turn and escalate, instead of
  waiting the full 90 s.
- A7. **No disk scans for named things**: the fast-path note tells the brain to use the project record, workspace
  resolver or a bounded `find <parent> -maxdepth 3`, never `find ~`.
- A8. **Tool chips resolve**: the stream emits `tool-done` when a tool result arrives (contract in §4).
- A9. Log noise: `bindAll` remembers addresses that failed with `EADDRNOTAVAIL` until the Tailscale IP set changes.

### Wave B — reliability and polling (hubs.js, apps.js, yolo.js, trace.js, attention.js)

- B1. `ensureRig`: a `rig_name_running` answer means the rig exists (refresh status, no error); an unresponsive
  OpenRig daemon skips the pass with one log line per 10 minutes, never a `rig up`.
- B2. `startApp`: honours `app.startupGraceMs` (default 180 s); the HTTP route returns `{ starting: true }` right
  away while the probe loop continues in the background and the `apps` event tells the UI when it is up (the app
  window already reloads on that event). Health checks back off exponentially for apps that stay down (5 s → 60 s).
- B3. YOLO: `prune` never deletes an idle v2 run that still has a window; watchers of finished runs are closed.
- B4. `trace.readSpans`: an in-memory LRU of recent spans per trace; day files are read once per trace, not per poll.
- B5. Attention: tmux pane captures run in parallel.

### Wave C — visible results (ui/src/*, src/ui-open.js, src/mcp.js, notify route)

- C1. **`ui_open` views**: `files` (as today), `app` (an App Cloud app window, optional path inside it), `url` (any
  http(s) URL in a sandboxed iframe window), `project` (the Projects window on a project), `trace` (the trace
  explorer), `model` (a 3D model file in the viewer), `tool` (CSV grid, JSON tree, PDF, image, rendered HTML).
  Non-media files opened with `files` now open in the matching file tool, not just selected in Finder.
- C2. **Generic content window**: `openContentWindow({ title, icon, url | html | el, width, height })` in the window
  manager, used by `url`, `tool` and `model`.
- C3. **3D viewer**: `.glb/.gltf/.obj` get a viewer built on the bundled three.js (GLTFLoader/OBJLoader,
  OrbitControls, auto-framing, grid, light rig). Finder preview and Quick Look use it too.
- C4. **The route event opens the work**: when a request is filed as a project, the Projects window opens on it
  (focus: false), so Sir sees the plan appear and the tasks move.
- C5. **"Open" on completion**: `mesh_notify` takes `open: { view, … }` (same shape as `ui_open`); the toast and the
  notification carry an Open button; the server keeps the last 50 notifications per UI session so a missed toast
  can be found (notification history popover).
- C6. Tool chips complete on `tool-done`.

### Wave D — planner, dashboards, Blender (planner.js, work.js, capabilities.js, config.js, persona/AGENTS.md, tools/)

- D1. **Intake returns early**: `jarvis_task` returns once the task is claimed and placed (`starting`, with its
  machine/model); the seat is cast in the background. The brain's one-line reply reaches Sir in seconds.
- D2. **Bounded planning call**: `planProject` spawns `claude -p --tools '' --strict-mcp-config
  --no-session-persistence --max-turns 1 --output-format json` with the planning prompt only (no persona, no tool
  schemas), on the `plan` routing rule's model. The agentic `ctx.ask` stays as a fallback. The three lookups before
  it (snapshot, guide, tools) run in parallel.
- D3. **Small plans skip the separate review**: a one-task plan of size S or M verifies itself against its acceptance
  criteria in the brief; `ensureFinalReview` keeps the review for everything else.
- D4. **Parallel tick**: `work/status` calls per project run with `Promise.all`; `followMerge` logs an unreachable
  steward once and backs off to every 5 minutes.
- D5. **Dashboards**: an App Cloud app entry may declare `opensFor: { workspace, keywords[], path }`. When a task
  starts whose project repo matches `workspace` and whose title/description matches a keyword, RIGS opens that app
  in Sir's UI at `path` (`ui_open` view `app`) and tells the agent in its brief that Sir is watching that dashboard
  (for body matching: run `scripts/mirror_magix_run.sh <run>` so the Mac API sees the magix run). The body-matching
  app is registered with `opensFor: { workspace: 'body_matching_implementation', keywords: ['train', 'training',
  'epoch', 'fine-tune'], path: '/training' }` after rollout.
- D6. **Blender as a mesh capability**: `capabilities.js` detects Blender (`/Applications/Blender.app` on macOS,
  `/usr/bin/blender` or `/opt/blender*/blender` on Linux, Program Files on Windows) with `kinds: ['3d']`; the default
  routing rules gain `{ kind: '3d', tool: 'blender', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }`
  (RULES_VERSION bump). A seed tool `tools/blender-glb` runs a bpy script headless and exports a `.glb` (plus a PNG
  turntable render) into the shared folder. `persona/AGENTS.md` gets the rule: a 3D object is built with the
  `blender-glb` tool (or props-studio on magix for photoreal props), saved under `@shared/files/3d`, then shown with
  `ui_open` view `model`.

### Deferred (not in this change, worth doing next)

- Default YOLO effort is `high` in the live config (the code default is `low`): a setting Sir chose; the first
  frame would come ~2× sooner on `low`.
- Clean up the 53 stale OpenRig rigs (`rig down` on dead rigs): destructive-ish, needs Sir's OK.
- A WebSocket push for project changes (the UI polls every 5–8 s today).
- Install `rea-agents` globally so the main thread's MCP boot does not go through `npx`.
- Voice: on macbookpro the piper fallback points at `http://127.0.0.1:8210` (the piper-voice app lives on magix, so
  it fails at once), and the Kokoro neural voice on magix times out at 20 s before the 30 s back-off kicks in, so a
  first spoken sentence can wait 20 s when the 4090 is busy. Point `persona.tts.piperUrl` at the magix app through
  the proxy and cut the neural timeout to ~6 s with a warm probe.

## 4. Contracts between the waves

- `ui_open` arguments (MCP tool, `POST /api/mesh/ui/open`, WebSocket `ui-open`):
  `{ view: 'files'|'app'|'url'|'project'|'trace'|'model'|'tool', node?, path?, app?, url?, project?, trace?, tool?, title? }`.
  `view: 'app'` → `{ app: '<id>', node?: '<machine>', path?: '/inside/the/app' }`.
- `mesh_notify` gains `open?: <ui_open arguments>`; the `notify` event carries `action: { type: 'open', open }`.
- Stream event `{ type: 'tool-done', id, name, ok }` follows a `tool` event when its result arrives.
- App registry entry: `opensFor?: { workspace: string, keywords: string[], path?: string }` (validated in apps.js,
  read by the planner).
- Tool `blender-glb` (tools/blender-glb): input `{ script?: string, preset?: 'cube'|'sphere'|'chair'|'table'|'mug', name: string, out?: string }`,
  output `{ glb, png?, node }`.

## 5. Verification

- `npm test` (all files) and `npm run build` on the merged tree (the steward re-runs them on `magix-system`).
- Live after rollout: the same two requests from §2 re-sent through `POST /api/local/jarvis/send`; the body-matching
  dashboard opening on a training task; a `.glb` made with `blender-glb` shown through `ui_open` view `model`.

## 6. Implementation notes (as built)

- A2: `confidentRules` also leaves a lookup or question that goes on to ask for work ("show the last build and fix it")
  to the engines. `router.rulesFirst` and `quick.stallMs` are in the config defaults, the Settings page and docs/settings.md.
- A4: the `[now: …]` block's clock is built by hand ("Thursday 22 October, 12:41"), not by the locale, so it reads the
  same on every ICU build. The router prompt kept in a request trace is capped at 4000 chars so the router span's input
  stays one readable structure under `traces.maxField`.
- B2: `POST /api/local/app-start/<id>` waits up to 2 s for a quick app, then answers `{ started: true, starting: true,
  pending: true, health }` while the probe loop goes on for the app's `startupGraceMs`; `localApps()` marks an app with a
  start in flight as `starting: true`, and the app window shows "Starting … it can take a few minutes" instead of
  "is down" until the `apps` event brings it up. `mesh_app_start` reports `starting: true` the same way.
- C1: every `ui-open` push names its machine as `nodeName` + `nodeId` (as the `files` view always did).
- C5: this node keeps the last 50 notices it showed (`GET /api/local/notify/history`); the UI merges them into Tools ›
  Notifications when it connects. `mesh_notify`'s `open` travels untouched (for view `trace` its `trace` is the trace to open).
- D1: `jarvis_task` reports `status: starting (placed; the agent is being cast in the background …)` when the reply came
  back before the seat was up (`pending`), so the brain can say where the work is going without waiting.
- D3: `autonomy.reviewSmall` (default false) is a setting: on, a one-task S/M plan gets its review task as before.
- D5: `mesh_app_register` declares `opensFor` and `startupGraceMs`. The body-matching registration after rollout:
  `mesh_app_register({ node: 'macbookpro', id: 'body-matching', …, startupGraceMs: 300000,
  opensFor: { workspace: 'body_matching_implementation', keywords: ['train', 'training', 'epoch', 'fine-tune'], path: '/training' } })`.
