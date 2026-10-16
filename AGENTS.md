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
| `src/models.js` | Provider → model → effort catalog and the per-harness flags (`--model/--effort`, `-m/-c model_reasoning_effort`, Ollama `think`); core brain |
| `src/planner.js` | Projects: core-brain planning → routing policy (`config.routing.rules`) → dispatch → tracking. `routeProject` is pure and unit-tested |
| `src/work.js` | Runs one task on this machine: one-seat OpenRig rig + queue item, or a direct agent session |
| `src/capabilities.js` | Machine tools (ComfyUI detector + declared tools). Add a detector here when introducing a new tool |
| `src/apps.js` | App registry (App Cloud): validates `config.apps`, health-probes each app, `GET /api/local/apps`, `aggregateApps`, and `resolveApp(node,id)` for the proxy. Mesh catalog: `GET /api/apps`, MCP `mesh_apps` |
| `src/pty.js` | Terminals (node-pty prebuilds for macOS/Linux/Windows) shared over WebSockets |
| `src/mcp.js` | `rigs mcp` — the stdio MCP server that gives agents the `mesh_*` tools |
| `src/openrig.js` | OpenRig (`rig`) status, seats, and peer registration as OpenRig hosts |
| `src/desktop.js` | Remote desktop: Sunshine/Moonlight (auto-pairing), macOS Screen Sharing, RDP, VNC |
| `src/ssh.js` | Mesh SSH key, authorized_keys + `~/.ssh/config` aliases for verified peers |
| `src/updater.js` | git fast-forward + reinstall + restart; skips machines with uncommitted edits |
| `src/setup.js`, `src/service.js` | `rigs setup`: MCP registration, agent instructions, REA, OpenRig, autostart |
| `ui/src/*` | The JARVIS UI (3d-force-graph galaxy, orb, voice, window manager); bundled by esbuild to `ui/dist` |
| `scripts/install.sh`, `scripts/install.ps1` | One-line installers per OS |

## Rules

- Node 22+, plain ESM JavaScript, no build step for the server. Keep dependencies minimal.
- Everything must work on macOS, Ubuntu (Wayland) and Windows. Use `src/util.js` helpers (`run`,
  `spawnCmd`, `which`) — they handle Windows `.cmd` shims and PATH for services.
- Never write to a user's real `~/.ssh`, `~/.claude*`, or `~/.codex` from tests; use `RIGS_HOME`,
  `RIGS_SSH_DIR`, `RIGS_NO_MIGRATIONS=1` and `RIGS_NO_AUTOUPDATE=1` (see `test/smoke.test.js`).
- New one-time steps for existing machines go in `src/migrations.js` (append-only); anything needing
  root goes through `src/rootsteps.js` so the user types one password in JARVIS.
- **Change policy — never commit to `main`.** `rigs dev <topic>` (MCP `rigs_dev_start`) gives you a
  worktree on `work/<machine>/<topic>` off the latest main; commit there, run `npm test` (and
  `npm run build` if you touched `ui/`), then `rigs propose` (MCP `rigs_propose`). The merge steward
  (`src/merge.js`) merges one branch at a time onto the latest main, re-runs build + tests on the
  merged tree, pushes and rolls out to every machine. Only a real conflict brings in a resolver agent
  (routing kind `merge`); failing checks come back to you. CI also runs on all three OSes after push.
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
2. Give it a **launch recipe**: on Linux a `systemctl --user` unit (enabled, so it survives reboots);
   elsewhere a `command`. JARVIS uses it to spin the app up when someone opens it while it is down.
3. **Register** it on its host: MCP `mesh_app_register` (or `POST /api/local/apps`, or `apps` in
   `~/.rigs/config.json` — picked up live). It appears in the galaxy (Apps), the left-panel Apps list
   and the ▦ launcher on every JARVIS; "open <name>" works by voice.

Code: `src/apps.js` (registry, health, `startApp`), `src/proxy.js` (proxy), `ui/src/apps.js` (windows).
