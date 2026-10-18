# RIGS OS — notes for coding agents working on this repo

This repo is checked out on **every machine in the mesh** (`~/.rigs/app` by default) and runs there
as the RIGS daemon. A commit pushed to `main` reaches every machine through the self-updater, so
treat `main` as production.

## Layout

| Path | What |
| --- | --- |
| `bin/rigs.js` | CLI + supervisor (`rigs start` restarts the server on exit code 75 and rolls back a crash-looping update) |
| `src/server.js` | HTTP/WebSocket API. `/api/local/*` acts on this machine; `/api/nodes/<id>/*` proxies to any peer |
| `src/proxy.js` | Peer forwarding (`/api/nodes/<id>/*` → peer `/api/local/*`) and the App Cloud proxy `/api/nodes/<node>/apps/<id>/*`: local forward with Location/cookie/HTML/CSS rewriting + runtime shim, peer relay, raw WebSocket piping |
| `src/discovery.js` | Finds peers: online Tailscale devices probed on port 4719, plus static `peers` from config |
| `src/auth.js` | Who may call: loopback, same-owner tailnet devices (`tailscale whois`), or the mesh token |
| `src/sessions.js` | Claude Code / Codex / tmux / OpenRig / terminal session discovery, transcripts, attach, send |
| `src/chat.js` | JARVIS brains: Claude Code (`claude -p`), Codex (`codex exec --json`), Ollama (HTTP). Hot-swappable mid-conversation |
| `src/router.js` | **Pre-routing** (`config.router`): before any brain sees a JARVIS request it is classified answer · implement · plan · continue and bound work is filed by RIGS itself (`opts.onWork`). `preroute: false` (or `preroute` per `jarvis/send` request) skips it: the request goes to the JARVIS thread without the `[routed]` hint, the brain files work itself, and the trace keeps a router span marked `skipped`. Engines: `jev` (default) = a Jev-compatible `/v1/systemone` API — LocalJev, the App Cloud app `localjev` or `router.jev.url` — asked with a predecided `route` choice (~0.5 s), accepted at `jev.minProb`; `claude` = Haiku via `claude -p`; then keyword rules (a plain question Jev answers unsure about goes straight to the rules; Jev unreachable → the fallback, as before). `GET/POST /api/local/router`, `rigs preroute on|off|engine …` |
| `src/preroute-stats.js` | Time saved by pre-routing (pure `prerouteStats`, tested): from the ledger's `request` records, per route class (answer · work) the median latency with pre-routing off (baseline) and on, router cost, saved per request and in total — possibly negative; `estimated` with `baselineSource` (config · on-minus-router · history) while no request ran with it off. `GET /api/local/preroute/stats`, mesh `GET /api/preroute/stats`, MCP `preroute_stats`, `rigs preroute stats` |
| `src/models.js` | Provider → model → effort catalog and the per-harness flags (`--model/--effort`, `-m/-c model_reasoning_effort`, Ollama `think`); core brain |
| `src/planner.js` | Projects: core-brain planning → routing policy (`config.routing.rules`) → dispatch → tracking. `routeProject` is pure and unit-tested |
| `src/autonomy.js` | The completion loop's policy (pure, unit-tested): retry budget + model ladder (`config.autonomy`), the safe-default answer to agent questions, the git guard for briefs and direct agents (no commit/push/branch switch outside a dev worktree), and the one "How did it work out, sir?" report. Wired in by `planner.js` / `work.js`; e2e: `scripts/e2e-completion-loop.js` |
| `src/work.js` | Runs one task on this machine: the pinned project's hub rig, the project's OpenRig team (seat per role + model) + queue item, or a direct agent session where OpenRig is unavailable |
| `src/hubs.js` | Persistent OpenRig rigs: one per pinned project (`hub-<name>-<hash>`, lead seat + on-demand workers, idle workers stopped after `openrig.hubs.idleMinutes`, tasks via `rig queue`, follow-ups via `rig send`) and JARVIS's `jarvis` rig whose overseer seat receives the intake. `GET /api/local/hubs`, `hubs/up`, `hubs/down`, `hubs/send` |
| `src/usage.js` | Work dashboard data (live Claude sessions, plan limits) and the **usage ledger**: one JSONL record per chat turn, planning call and task run in `RIGS_HOME/usage/<YYYY-MM>.jsonl` (model, node, time, tokens, cost, status, outcome), plus one `request` record per request from Sir with its timing (pre-routing on/off, route, routerMs, timeToFiledMs, timeToReplyMs; left out of the usage report unless `kind=request`). Chat turns take tokens from the harness (`claude -p` result, Codex `turn.completed`, Ollama's final chunk); task runs from their seat's transcript slice between start and end (`planner.onRunEnd` → `usage/slice` on the machine that ran it). `GET /api/local/usage`, mesh `GET /api/usage`, MCP `usage_report`, `rigs usage [backfill]` |
| `src/trace.js` | **Request traces**: one traceId per request from Sir (minted at intake: `jarvis/send`, a chat send), a tree of spans `{traceId, spanId, parentId, kind, name, node, start, end, status, input, output, meta}` — intake → router (route, project, thread, the router model's prompt + reply) → brain turn (provider, model, effort, prompt, reply, harness tokens + cost) → tool calls (parsed from the claude stream-json / Codex JSON / Ollama stream) → handoffs (`jarvis_task`, `project_create`, `project_dispatch`, router-filed work, with projectId + taskIds) → plan (prompt, plan JSON, routing per task) → dispatch (per start, `meta.target`) → task run (written by the machine that ran it: seat/agent, model, git guard, reported status + summary; at run end its transcript slice becomes assistant + tool-call spans, `recordRunEnd` via `traces/run-end`) → events (retry, escalate, question, failed). Mesh `/api/traces/<id>` marks machines that did not answer as `gap` spans. Append-only `RIGS_HOME/traces/<YYYY-MM-DD>.jsonl`, written at start (running) and end, last line per span wins; every write is pushed live to the UI (`trace-span`). Redaction, field caps and retention live there (`config.traces`: enabled, days, maxField). The context travels as `RIGS_TRACE` (harness env) → `x-rigs-trace` (rigs MCP) → `p.trace` / `t.trace` → the task brief and `work/start`. `GET /api/local/traces[/<id>]`, mesh `GET /api/traces[/<id>]`, MCP `trace_list` / `trace_get`; schema at the top of the file |
| `src/capabilities.js` | Machine tools (ComfyUI detector + declared tools). Add a detector here when introducing a new tool |
| `src/comfyui.js`, `src/comfyui-workflows.js` | Shared connector to a user-provided ComfyUI (`/api/local/comfyui/*`): per-machine URL + secret auth header in `config.comfyui`, test, models, txt2img/img2img/upscale templates, jobs over `/prompt` + `/ws` with lanes, GPU-overseer leases. Every graph is checked against `/object_info` first — never `/prompt` a missing model (some installs auto-download it). Used by `applets/krea-studio` |
| `src/apps.js` | App registry (App Cloud): validates `config.apps`, health-probes each app, `GET /api/local/apps`, `aggregateApps`, and `resolveApp(node,id)` for the proxy. Mesh catalog: `GET /api/apps`, MCP `mesh_apps` |
| `src/appstore.js` | App Store: catalog of installable apps (`appstore/catalog/*.json`, format in `appstore/README.md`; sources of apps without a public repo vendored in `appstore/sources/<id>`), manifest validation, and the resumable install job (fetch → venv → deps → models → post → launch → register → health) with progress; uninstall moves files to `~/.rigs/trash`. `GET /api/local/appstore`, `…/<id>/install|job|cancel|uninstall`, MCP `appstore_list` / `appstore_install` |
| `src/toolbox.js` | **Tool registry**: scripts agents wrote for a task, kept for reuse (`src/tools.js` is the unrelated CLI-binary finder). One folder per tool in `RIGS_HOME/tools/<id>/`: `manifest.json` (id, name, description, tags, language node/python/bash/sh/powershell, entry, `inputs` JSON schema, outputs, platforms, safety `read-only`/`mutating`, version, timeoutSec, origin project/task/session/trace, created/updated, uses) plus the script files. `validateManifest`, `validateArgs`, `searchCatalog` (ranks tools and App Cloud applets as kind `applet` together), `aggregateTools` and `refusal` are pure and tested (`test/toolbox.test.js`). `runTool` passes JSON args on stdin + `RIGS_TOOL_ARGS` under a timeout (default 60 s, max 600), refuses mutating tools without `allowMutating: true` and any git step the git guard forbids in its cwd, and redacts stdout/stderr (`trace.redact`). `GET /api/local/tools`, `tools/<id>`, `POST tools/register`, `tools/<id>/run`; mesh search `GET /api/tools?q=&tag=&kind=&node=`; MCP `tool_list` / `tool_get` / `tool_register` / `tool_run`; `rigs tools [list\|show\|run]`. The CLI-binary report moved from `/api/local/tools` to `/api/local/bins`. **Reuse loop**: `matchTools` (keyword match on stems, no model) picks the registry tools and applets that fit a task; `briefSection` puts them and a short `tool_list` / `tool_register` paragraph into every task brief (`planner.taskPrompt`), `planNote` into the planning prompt, and `AGENT_NOTE` into the agent instructions `rigs setup` writes (each well under 300 tokens, tested). The planner gets its catalog from `plannerCtx.tools` (`server.toolCatalog`: mesh tools + applets, cached 60 s, 4 s cap). Every `tool_run` (`usage.recordToolEvent` + an `event` span `tool_run <id>` under the caller's trace), every tracked `tool_list` (MCP sends `track=1`) and every brief or plan that names tools is logged in `RIGS_HOME/usage/tools-<YYYY-MM>.jsonl` (separate from the token ledger); `usage.toolReuse` sums them into `toolReuse` of `/api/local/usage` and `/api/usage`, shown as "Tool reuse" in the Tokens & time panel. **Seeds**: `roots()` also lists the checkout's `tools/` (`RIGS_SEED_TOOLS` overrides, empty switches off), so every machine has the seed tools after an update; `RIGS_HOME/tools` wins on a shared id, seed folders are never written to (usage counts go to `RIGS_HOME/tools/.usage.json`, seeds are flagged `seed: true`). A manifest's optional `smoke: { args, expect }` is a safe call (a dry run) that `smokeTool` / `rigs tools smoke [id]` runs and checks. `appletMeta()` reads `tools/applets.json` (description and tags by app id) for applets that registered without their own, so `tool_list` finds them; `runTool` also sets `RIGS_APP_DIR` |
| `tools/` | **Seed tools** (same layout as `RIGS_HOME/tools/<id>/`, plain Node `.mjs`, JSON args in `RIGS_TOOL_ARGS`, one JSON object on stdout, `dryRun` arg for the smoke check): `cdp-screenshot`, `healthz-wait`, `comfyui-client` (read-only, never POSTs `/prompt`), `usage-transcript-parse`, `ffmpeg-frames`, `gpu-lease`, `unity-compile-check`, `app-publish`, `mobile-audit`; `applets.json` is the applet search catalog. Add a seed when a script was written for several tasks: manifest with 3+ tags, a description that says when to use it, `smoke`, no secrets, no git steps (the git guard reads the source); `test/toolbox-seeds.test.js` checks all of that |
| `src/pty.js` | Terminals (node-pty prebuilds for macOS/Linux/Windows) shared over WebSockets |
| `src/mcp.js` | `rigs mcp` — the stdio MCP server that gives agents the `mesh_*` tools (incl. `mesh_screen`, `mesh_windows`, `mesh_control`, `mesh_access`; no tool can enable control) |
| `src/openrig.js` | OpenRig (`rig`) status + health, seats, and peer registration as OpenRig hosts. Run `rig` only through `rigRun` (it puts the daemon's own Node first on PATH) |
| `src/desktop.js` | Remote desktop: Sunshine/Moonlight (auto-pairing), macOS Screen Sharing, RDP, VNC |
| `src/control.js` | OS control (screen access + input), **on by default; kill switch and per-machine off**: the public API (`createControl`), the gate (enabled → allowFrom → lease free → lock → backend + OS permission → rate limit → take the lease → act: a refused call never holds the lease or uses up the rate budget), lease (pure `holderKey`: agent session/seat or the person, per entry node, never the transport `who`), rate limits, audit (`logs/control.jsonl`), announcements, persistent kill (`control-state.json`), pure `selectBackend`, pure `permissionMessage` (the 412 text: which grant, for which app, on which machine). `check(op)` (`GET control/check?op=`, MCP `mesh_control action:"check"`) runs the same gate read-only: no lease, no input, audited as `check`. `status().needs` (pure `access.missingGrants`, shown by `mesh_access`) lists each OS grant a person still has to give. Design: `docs/full-access.md` |
| `src/control-api.js` | `/api/local/control/*` routes (status, screenshot, windows, focus, pointer, type, key, enable, kill, grant, audit) and the announcements/attention item; `POST /api/mesh/control/kill` lives in `server.js` |
| `src/control-setup.js` | The default-on migration's decision and the first-run setup at boot (helper start, macOS helper install, Linux uinput root step, GNOME extension) |
| `src/control-mac-helper.js` | macOS RIGS Control.app: build when the source hash changes, its own LaunchAgent (`dev.rigs.control`; a scratch `RIGS_HOME` gets `dev.rigs.control.<hash8>`, also as its bundle id so TCC keeps its grants apart), one-shot socket requests, stale-grant reset. CLI `rigs control helper`. Tests inject the runner: never load a real LaunchAgent from a test |
| `src/control-{linux,mac,win}.js`, `src/control-rpc.js`, `src/control-error.js` | Platform adapters that start and talk to the helper, the JSON-lines helper transport and the error type |
| `scripts/control/` | Helper sources: `rigs-control-linux.py` (+ `gnome-extension/`), `rigs-control.ps1`, and `macos/` (`RigsControl.swift`, `Info.plist`, `build.sh`): the macOS helper that holds Screen Recording + Accessibility itself, so `node` never needs them; `macos/live-check.js` runs the live screenshot/windows/TextEdit check against a dev daemon; `linux/live-check.js` the Wayland service-mode check (session env, locked 423s, screenshot, typing into its own scratch window) |
| `src/access.js` | Permission status per OS (files, screen capture, input, accessibility) with fix hints and the guided grant |
| `src/ssh.js` | Mesh SSH key, authorized_keys + `~/.ssh/config` aliases for verified peers |
| `src/updater.js` | git fast-forward + reinstall + restart; skips machines with uncommitted edits |
| `src/setup.js`, `src/service.js` | `rigs setup`: MCP registration, agent instructions, REA, OpenRig, autostart |
| `ui/src/*` | The JARVIS UI (3d-force-graph galaxy, orb, voice, window manager); bundled by esbuild to `ui/dist`. `usage-panel.js` is the ⏱ "Tokens & time" panel (mesh `/api/usage`: totals, by model/project/task, latest runs) plus its Pre-routing section (mesh `/api/preroute/stats`: headline time saved, per class diverging bar, router cost, mode, `estimated` badge; a loss is shown as a loss). `brain.js` carries the Pre-routing switch (`GET/POST /api/nodes/<id>/router`, applies to the machine selected in the popover); `preroute-format.js` is the pure wording/numbers behind both and the route chip (`route direct` when pre-routing was off), tested in `test/preroute-ui.test.js` |
| `ui/src/trace-panel.js`, `ui/src/trace-layout.js` | The 🧭 "Request traces" panel (mesh `/api/traces`: recent requests with filters) and the trace explorer window: a 3D DAG of one request's spans (3d-force-graph; time along x, a lane per machine or seat, colour = stage kind, size = duration or tokens), a timeline view, replay scrubber, critical path, summary strip and a span drawer (bottom sheet on phones). "All activity · live" shows the latest requests together. Live from the `trace-span` WebSocket push plus `?after=` polling for other machines. The layout/analysis is pure (`trace-layout.js`, tested in `test/trace-panel.test.js`); fixtures: `node test/fixtures/trace-fixtures.js <RIGS_HOME>` |
| `ui/src/control.js` | Access & control panel per machine: permissions + guided grants, the access/full-control switches, live "in control" banner, Stop / Stop on every machine |
| `scripts/install.sh`, `scripts/install.ps1` | One-line installers per OS |

## Rules

- Node 22+, plain ESM JavaScript, no build step for the server. Keep dependencies minimal.
- Everything must work on macOS, Ubuntu (Wayland) and Windows. Use `src/util.js` helpers (`run`,
  `spawnCmd`, `which`) — they handle Windows `.cmd` shims and PATH for services.
- Never write to a user's real `~/.ssh`, `~/.claude*`, or `~/.codex` from tests; use `RIGS_HOME`,
  `RIGS_SSH_DIR`, `RIGS_NO_MIGRATIONS=1` and `RIGS_NO_AUTOUPDATE=1`, plus `RIGS_NO_OPENRIG=1` for any test or scratch server (otherwise it talks to the real OpenRig and queues fake "Sir: Dark mode" items into the live JARVIS overseer) (see `test/smoke.test.js`).
- New one-time steps for existing machines go in `src/migrations.js` (append-only); anything needing
  root goes through `src/rootsteps.js` so the user types one password in JARVIS.
- **Change policy — never commit to `main`.** `rigs dev <topic>` (MCP `rigs_dev_start`) gives you a
  worktree on `work/<machine>/<topic>` off the latest main; commit there, run `npm test` (and
  `npm run build` if you touched `ui/`), then `rigs propose` (MCP `rigs_propose`). The merge steward
  (`src/merge.js`) merges one branch at a time onto the latest main, re-runs build + tests on the
  merged tree, pushes and rolls out to every machine. Only a real conflict brings in a resolver agent
  (routing kind `merge`); failing checks come back to you. CI also runs on all three OSes after push.
- **Playbooks** (`docs/playbooks/*.md`): proven methods for recurring RIGS changes. A JARVIS request whose goal matches a
  playbook's `match` regex skips LLM planning: one agent follows it, then the final review. When a kind of request
  repeats, write one (front matter `title`, `match`, `size`; then the files, steps and checks). Example: `ui-theme.md`.
- **Screen control is gated (`src/control.js`, design in `docs/full-access.md` §7).** Control is on by default, and
  a person or the kill switch switches it off per machine. `config.control` is in `patchConfig`'s blocked set, so no
  generic settings save or agent `POST config` can switch it back on. Only a confirmed human surface may do that. Do
  not add a route or MCP tool that bypasses the gate, the lease, the audit log or the kill switch. Every refusal is
  audited too, and a kill persists across restarts. Never migrate a machine back on after a person switched it off
  or the kill switch fired (`2026-10-17-control-default-on` leaves those as they are).
- Control safety rules (all of them, in every control change): every call goes through the gate, which checks
  enabled → allowFrom → lease → lock → backend + OS permission → rate limit, and only then takes the lease. Every action, refusal and switch is written to
  `logs/control.jsonl` (the audit log); the audit must be writable before a call touches the desktop. The kill
  switch (`rigs control off`, `POST /api/local/control/kill`, the ⌃⌥⌘⎋ hotkey on macOS) stops the backends at
  once and persists across restarts. Typing never uses Unicode `SetKeymap`: Wayland types keysyms and answers
  `unsupported` (501) for characters it cannot type.
- Agent-facing control tools (`mesh_screen`, `mesh_windows`, `mesh_control`, `mesh_access`) must ask Sir before
  use unless the task brief allows it for that machine. Nothing a tool or agent does may turn control back on.
- Changing default routing rules? Bump `RULES_VERSION` in `src/config.js` so non-customized machines pick them up.

## Local multi-machine test

```bash
docker build -f test/docker/Dockerfile -t rigs-ubuntu .
TOKEN=dev-$(openssl rand -hex 6)
docker run -d --name rigs-ubuntu -p 127.0.0.1:4720:4719 -e RIGS_MESH_TOKEN=$TOKEN \
  -e RIGS_PEERS=http://host.docker.internal:4719 rigs-ubuntu
RIGS_HOME=$PWD/.rigs-dev RIGS_SSH_DIR=$PWD/.rigs-dev/ssh RIGS_MESH_TOKEN=$TOKEN \
  RIGS_PEERS=http://127.0.0.1:4720 node bin/rigs.js start
```

## Ground rule: apps and applets go into the App Cloud

Every web app or applet built on the mesh is published so it opens inside JARVIS on any machine:

1. Serve it with **relative URLs** (it is reached under `/api/nodes/<node>/apps/<id>/`) and a cheap
   health endpoint (`/healthz`).
2. Give it a **launch recipe** for every OS it can run on. JARVIS uses it to spin the app up when someone
   opens it while it is down. `launch` takes, side by side:
   - `systemd`: a `systemctl --user` unit (enabled, so it survives reboots), used on **Linux only**;
   - `command` (+ optional `cwd`, default `~`, and `env`): a command line, used on any OS (on Linux only
     when there is no `systemd`);
   - `linux` / `darwin` / `windows`: `{ command, cwd, env }` for that OS, replacing the top-level recipe
     there (`linux` may give `{ systemd }`).

   ```json
   "launch": { "systemd": "szuf.service", "command": "~/szuf/run.sh",
               "windows": { "command": "python server.py --port 8787", "cwd": "~\\szuf" } }
   ```
   On Windows a command runs **without a POSIX shell**: its program is found on PATH (`.exe`, `.cmd`, `.bat`,
   `.ps1` through `util.spawnCmd`); only a line with cmd.exe syntax (`&&`, `|`, `%VAR%`) goes through cmd.exe.
   `launchFor(launch, platform)` in `src/apps.js` picks the recipe; each app's `launchHere` is the one its host runs.
   Old `{ systemd }` / `{ command }` recipes keep working unchanged.
3. **Register** it on its host: MCP `mesh_app_register` (or `POST /api/local/apps`, or `apps` in
   `~/.rigs/config.json` — picked up live). It appears in the galaxy (Apps), the left-panel Apps list
   and the ▦ launcher on every JARVIS; "open <name>" works by voice.

Code: `src/apps.js` (registry, health, `startApp`), `src/proxy.js` (proxy), `ui/src/apps.js` (windows).
