# StarNet space-station mode — integration spec

Task t1 of project `eeb4920bf0` (research only; no code changed). Goal: an **experimental, fully reversible** mode in
which JARVIS shows the StarNet space station, with workers, instead of the 3D "cloud" (the force-graph galaxy).

## 1. What was studied

| | |
| --- | --- |
| Repo | https://github.com/androoAGI/starnet (cloned `--depth 50`) |
| Commit | `d540d503d9c8d5140685881880d46985b27e2f9c` (2026-10-16), tag `v0.13.5`, package `starnet-harness` |
| Author | Andrew Sims |
| Size | 5.1 GB checkout; `.git` 1.6 GB; `frontend/` 1.3 GB (of which `frontend/assets/industrial` 1.2 GB, `assets/sprites` 40 MB, `assets/agent-demo` 31 MB); `website/app` is a second 1.3 GB verbatim copy of `frontend/` |

**Facts, not inferences, unless marked (inferred).**

## 2. What StarNet is and renders

StarNet is a local-first **desktop AI-agent harness** (Tauri shell + one Node process `sidecar/index.js` on :8787,
~23k lines, no deps for the core). README: "A living pixel-art station where real AI agents do real work."

- The station is a **2D canvas** renderer (pixel-art, isometric-looking, CRT warp, procedural bake), not WebGL and not three.js.
  `frontend/app/world.js` (12,049 lines, canvas 2D), `worldmodel.js` (5,051; rooms/tiles/props/BFS pathing),
  `stationbake.js` (5,782; procedural bake + cache), `worldrenderer.js`, `worldlight.js`, `spacebg.js` (starfield backdrop),
  `conveyor.js`, `pipeline.js`.
- Product contract (README): a **room** is a capability-scoped team, a **hallway** an authorised handoff lane, a **placed
  object** a real capability grant. Agents (a "hero" plus `crew[]`) are bodies at **Bay** props that walk, work and idle;
  work crates ride **conveyors** from INTAKE to Bays to OUTBOX (`world.js:141-146`, `syncCrewFromPlan`).
- **No build step.** `frontend/index.html` loads ~80 classic `<script>` files in dependency order; modules are `const X = (() => {…})()`
  globals (`World`, `WorldModel`, `Harness`, `U.bus`…). All assets must live under `frontend/`.
- Runtime needs: any modern browser with Canvas 2D (no WebGL, no bundler). Node ≥18 only for the sidecar. The frontend
  expects the sidecar API (`Harness.api`, `/api/roster`, SSE `U.bus` events; local API is token-fenced, `sidecar/apiauth.js`)
  **or** a seeded save: `website/app/demo-boot.js` boots the real frontend with **no sidecar** from a captured save
  (`scripts/sync-website-app.mjs`). That is the precedent for driving the renderer from outside.
- State is frontend-owned: save v5 in localStorage + sidecar mirror; the roster is pushed by the browser (`POST /api/roster`).
  Mutations to the station layout are persisted; StarNet's product law is "the interface must never assert state the harness cannot prove".

## 3. License and attribution

- **Code: MIT**, `Copyright (c) 2026 Andrew Sims` (`LICENSE`; `package.json` `"license": "MIT"`). RIGS (`rigs-mesh`) is also MIT, so compatible.
  Obligation: keep the copyright + permission notice in **all copies or substantial portions** — i.e. ship `LICENSE` (as `THIRD_PARTY/starnet/LICENSE`) with any vendored/installed files and credit StarNet in the About/Help text and README.
- **`NOTICE.md`** (15 KB) lists third-party material inside StarNet. Relevant to the renderer: font **VT323, SIL OFL 1.1**
  (`frontend/assets/fonts/vt323.woff2`; bundle and redistribute OK, keep the notice, don't sell the font alone). The rest of NOTICE.md concerns skill recipes
  (MIT / Apache-2.0, `sidecar/skills`, `skills-catalog`) — **not needed** for this mode; do not copy them.
- **UI sounds** `frontend/assets/sfx/LICENSE.md`: "Interface Bleeps" by Bleeoop (itch.io), free for commercial use but
  **no resale as asset packs**, files "ship only as embedded UI sounds of this application". → **Exclude `assets/sfx`** from anything we copy (we are not that application; avoids the restriction).
- **Sprites / props / textures** (`assets/sprites`, `assets/industrial`, `assets/agent-demo`, `assets/agent-animation-0914`): **no per-asset licence, provenance or credits file was found**
  (only `assets/skin-study-0914/README.md`, a design-review note saying skins were "newly generated"). They sit under the repo's MIT licence by default; whether the author owns/generated all of them is **unverified**.
  Mitigation: ask the author (androo.agi@gmail.com per README) to confirm before any public redistribution; for this private-mesh experiment, MIT as published is sufficient.
- No CLA, no trademark grant. "StarNet"/logo (`assets/brand`) are branding: do not use the logo as a RIGS brand; the in-app credit should read "Station view by StarNet (MIT) — github.com/androoAGI/starnet".

## 4. How it maps onto JARVIS's cloud view

JARVIS's "cloud" = the full-screen **mesh galaxy**: `ui/src/graph.js` (`createGraph`, 3d-force-graph + three.js) fed by
`buildGraph(snapshot)` from `GET /api/mesh/snapshot`. The same data already has everything the station needs:

| JARVIS node (`graph.js` TYPES) | StarNet concept |
| --- | --- |
| `mesh` (TAILNET) | the station hub / outer space + INTAKE |
| `machine` (online) / `offline` | a **room** (offline = dark/unpowered room), named after the machine, linked by hallways |
| `agent` (Claude Code, Codex, Ollama, OpenRig) | a **worker** body at a Bay in that room (class/skin per agent kind) |
| `session` / `live` / `chat` | worker state: live = at desk working, idle = wandering, needs-you (attention) = waiting anchor (`waitanchor.js`) |
| `project` / `plan` / `task` | **crates** on conveyors INTAKE → Bay → OUTBOX; done = crate in OUTBOX |
| `tool` / `app` / `skill` / `model` / `rig` | props/consoles in the room (capability grants), clickable to the same inspector |

Selection, attention blink, Filters, Top hubs, search, inspector and context menu are all keyed on JARVIS node ids
(`m:<id>`, `a:<machine>:<agent>`, `s:…`, `pj:…`); the station view must report clicks back in those ids so the
side panel keeps working unchanged.

### Exact JARVIS files that render the cloud view (and would be touched)

| File | Where | Change |
| --- | --- | --- |
| `ui/index.html` | `<main id="graph">` (line ~20) | unchanged markup; add sibling `<main id="station">` (hidden) — or inject it from JS |
| `ui/src/graph.js` | `createGraph` (l.132), `buildGraph` (l.30), `TYPES` (l.9) | **no change** to galaxy; `buildGraph` output is reused as the station's data model |
| `ui/src/main.js` | `createGraph($('#graph'))` l.72; `graph.setData(buildGraph(visibleSnap()))` l.246 and l.1323; `graph.setAttention` l.150/247; `graph.setHidden` l.412/418/1361; `graph.focus` l.425; `graph.nodeAt` l.1430 (context menu); Graphify l.1208 | add a `view` indirection: `const view = starnetOn ? createStationView(…) : graph`, same method surface (`setData`, `setAttention`, `setHidden`, `focus`, `focused`, `get`, `nodeAt`, `pause/resume`). Call sites go through `view`. Galaxy is still constructed lazily and paused when off-screen |
| **new** `ui/src/starnet-view.js` (+ pure `starnet-model.js`) | — | iframe host + postMessage bridge + snapshot→station-save mapper (pure, tested) |
| `ui/src/jarvis-commands.js` | `experimental.exhibits` l.100–103, Experimental menu l.155 | add checkable `experimental.starnet` ("Space station view") next to Exhibits |
| `ui/src/styles.css` | `#graph` rules | `#station` full-bleed layout, `body.starnet` toggles |
| `src/config.js` | default config near l.87 (`exhibits`) | add `experimental.starnet` default block (below) |
| `src/server.js` | config routes near l.803 (`exhibits/config`), `serveStatic` l.1278, WS `broadcast` l.1455 | `GET/POST /api/local/starnet/config`; serve `/starnet/*` from the install dir (only when enabled); push `{type:'starnet-config'}` |
| `bin/rigs.js` | after `exhibits()` l.247 | `rigs starnet on\|off\|status\|install\|remove` |
| `AGENTS.md`, `README.md` | Layout table | one row (the repo requires the doc to track code) |
| `test/starnet.test.js` (new) | — | pure model + config tests; see §7 |

Out of the cloud path (do not touch): `ui/src/graphify*.js` (it has its own `createGraph` instance), traces/orb/face WebGL.

## 5. What to vendor or depend on

Do **not** vendor the repo: 1.3 GB of assets (the website copy doubles it) would bloat `main`, which every machine pulls through the self-updater (`AGENTS.md`: "treat main as production").

**Recommended: install on demand, pinned, outside git.**

1. `rigs starnet install` fetches StarNet **at the pinned commit `d540d503…`** (sparse/shallow, or the GitHub tarball) into `RIGS_HOME/starnet/<sha>/`
   and writes `LICENSE` + a short `NOTICE` beside it. Only the browser renderer subset: `frontend/index.html`-style entry, `frontend/app/*.js`,
   `frontend/js/*`, `frontend/css/*`, `frontend/agent-demo/*`, `frontend/assets/{fonts,sprites,furniture,brand}` and **only the
   `industrial` files the demo save references** (a bounded allow-list to be measured — it is the 1.2 GB unknown; **not measured in this task**).
   Exclude `sidecar/`, `src-tauri/`, `test/`, `docs/`, `website/`, `assets/sfx`, skills.
2. `server.js` serves it read-only at `/starnet/` (same-origin, so iframe + `postMessage` works; no new port, no App Cloud entry needed).
3. The frontend boots in "demo/seeded" mode like `website/app/demo-boot.js`: a small RIGS-owned `rigs-boot.js` (our file, lives in `ui/starnet/`, committed)
   injected before the first app script replaces the sidecar: it stubs `Harness.api` (no network), seeds the save from the first `snapshot` message, and applies later `snapshot` deltas.
4. Never run StarNet's sidecar, never give it API keys, tokens or the roster endpoints. Offline-safe: no remote fonts or calls (`sync-website-app.mjs` already checks for Google phone-outs; reuse that check).

Alternatives considered:
- *Vendor a trimmed copy into git* — reversible and offline, but needs the asset subset measured first and ~tens/hundreds of MB; revisit once measured. If `rigs starnet install` is judged too fragile, this is the fallback.
- *Run StarNet as an App Cloud app* (its sidecar + its own station) — easiest, but it shows **StarNet's own agents**, not JARVIS's machines/workers, and is not "instead of the cloud". Rejected for this goal; useful only as a smoke test of the checkout.
- *Re-implement the look natively in `graph.js`* — not StarNet, large; out of scope.

## 6. Minimal integration surface and flag design

**One flag**, `config.experimental.starnet`, default **false** (precedent: `config.exhibits.enabled`).

```jsonc
"experimental": { "starnet": { "enabled": false, "ref": "d540d503d9c8d5140685881880d46985b27e2f9c", "dir": "" } }
```

- Read/write through `GET/POST /api/local/starnet/config` (same shape as `exhibits/config`); also `rigs starnet on|off`; UI: **Experimental › Space station view**.
  Picked up live from `~/.rigs/config.json`; WS push `starnet-config` so open windows switch without reload.
- **Mesh-wide or per-browser?** Per-machine config (like exhibits), applied by whichever UI is served from that machine. (assumption; per-viewer override via `localStorage rigs.starnet` is a cheap extension.)
- **Off = current behaviour exactly.** When `enabled` is false: no `/starnet/*` route (404), no iframe, `starnet-view.js` is a lazy chunk never fetched, `view === graph`, the menu item unchecked. `experimental.starnet` absent from an old config = false (config merge defaults).
  Turning it off at runtime destroys the iframe and resumes the galaxy; the galaxy is never torn down, so nothing needs restoring. Removing the install dir (`rigs starnet remove`) leaves zero residue; nothing in `~/.rigs` besides the flag and that dir.
- **Fallback:** if the install is missing, the iframe fails to load within ~5 s, or the bridge handshake times out, show a toast and auto-fall back to the galaxy for that session (flag stays as set); never a blank screen.
- Bridge protocol (JSON `postMessage`, same-origin only, origin-checked): host→station `{type:'snapshot', graph: buildGraph(…), attention:[ids], hidden:[types]}`, `{type:'focus', id}`;
  station→host `{type:'ready'}`, `{type:'select', id}`, `{type:'context', id, x, y}`. Read-only: the station never mutates JARVIS state.
- Mapper rules (pure, `starnet-model.js`): deterministic room/bay layout from the sorted machine/agent ids so the station doesn't reshuffle on each refresh; cap workers per room (e.g. 12) with a "+N" prop; reuse the `visibleSnap()` filter so removed apps stay removed.

## 7. Verification plan for the implementing tasks

- Unit (`test/starnet.test.js`, picked up by `npm test` glob `test/*.test.js`): mapper determinism and caps; config default is `false` and survives merge with an old config; route 404 when disabled; install pins the sha.
- Browser check modelled on `scripts/graphify-check.js`: flag off → identical DOM/galaxy as before (no `#station`, no `/starnet` request); flag on → station visible, a click on a worker selects the same inspector entry as the galaxy node; toggle off → galaxy back; phone 390×844; console clean; screenshots saved under `docs/screenshots/starnet/`.
- `npm run build` (ui changed) and `npm test`.

## 8. Out of scope

- Running StarNet's harness (agent loop, providers, keychain, channels, MCP, cron, skills, Night Shift, voice, Tauri shell, updater); any StarNet ↔ RIGS agent execution or two-way control from the station.
- Station **editing** (Build Mode/Refit), saves, cloud-save, StarNet's quests/XP/dossier systems, its sounds and music, its skill recipes and NOTICE-listed third-party skill content.
- Replacing the galaxy for **Graphify** (separate window; keep it on `createGraph`), traces 3D, face/orb.
- Mobile-optimised station (phone falls back to the galaxy at first), performance tuning of a 12k-line canvas renderer, a trimmed asset build, upstreaming changes to StarNet.
- Public redistribution (blocked on author confirming sprite/prop provenance, §3).

## 9. Risks and open questions

1. **Asset subset size is unmeasured** — decides install-on-demand vs vendoring. First step of implementation: boot `website/app`-style seed, record requested files, size them.
2. **Renderer coupling** (inferred, not proven): `world.js` expects `Harness`, `U.bus`, save/localStorage and a hero agent; a seeded demo boot works for StarNet's own website, but driving it from live snapshots (spawning/removing crew) needs a spike to confirm `syncCrewFromPlan` can be fed from outside.
3. **Upstream drift**: pinned to `d540d503`; StarNet ships often (0.13.5), so never auto-update; bumping `ref` is a deliberate change.
4. **localStorage namespace**: StarNet `starnet.*` keys live on RIGS's origin inside the iframe (same-origin); use a dedicated sub-path/`sandbox` or prefix them in `rigs-boot.js` to avoid touching `rigs.*` keys.
5. Sprite/prop licence provenance (§3).

## 10. As built (task t2)

Implemented behind `config.experimental.starnet.enabled` (default `false`); see the `src/starnet.js` and `ui/src/starnet/…` rows in `AGENTS.md`.

- **Asset subset measured** (§9.1): StarNet's renderer requests ~708 files / 252 MB on boot. The install takes the cone
  `shared/`, `frontend/{app,js,css,agent-demo}`, `frontend/assets/{fonts,sprites,brand,furniture,agent-demo,agent-animation-0914,skin-study-0914}`
  and `frontend/assets/industrial/{remaster,projection-correction,calibration}` (+ files directly in those folders' parents): **14,952 files, 376 MB**, no
  `assets/sfx`. Network install (shallow sparse fetch of `d540d503…`) took ~17 s here; `--from <checkout>` copies a local clone. Install on demand, not vendored (§5).
- **Renderer coupling** (§9.2): no need to feed `syncCrewFromPlan`. Workers are summoned bodies (`World.spawnAgent`, placed in their machine's room by
  pointing the station's spawn room at it for the call), each bound to its own desk (`prop.agentId`), lit with `World.setActivityFor`, and put in the
  waiting pose through StarNet's own `permission.prompt` bus event. A new machine or worker set re-bakes the floor (`World.loadStation`); everything
  else is a state update.
- **localStorage namespace** (§9.4): the frame's `localStorage`/`sessionStorage` are in-memory (rigs-boot.js), so StarNet never touches `rigs.*` keys and leaves none behind.
- StarNet draws no room names on its live floor; rigs-boot.js adds clickable machine names that follow the camera.
- **Switching** needs no restart: the settings API (`/api/local/starnet/config` or `/api/local/config`) and `rigs starnet on|off` apply at once and every
  open JARVIS on that machine switches through the `starnet-config` push. Editing `~/.rigs/config.json` by hand applies at the next daemon start.
- Not done (still out of scope): the phone keeps the galaxy; the station's camera starts on StarNet's own framing (scroll/drag to see every room on a large mesh);
  the JARVIS **Fit** button still fits the (hidden) galaxy.
- Verified with `npm test` (`test/starnet.test.js`: model, flag, subset, route, and a scratch node end to end) and `node scripts/starnet-check.js --dir <install>`
  (23 browser checks: flag off = no `#station`, no `/starnet/` request, no view chunk; on through the settings API, off through the CLI, on/off from the menu;
  one floor body per modelled worker; clicks on JARVIS, a worker and a room name select the matching inspector entry; phone keeps the galaxy; zero console errors).

## 11. Two-way control (project `9b07477a3b`, gap list `docs/starnet-view-gaps.md`)

The station now does what the galaxy does: create agents, reach them, and act on every node, through the galaxy's own menus
and inspector handlers. No new daemon route; the "read-only" line of §6 is replaced by "the frame only asks, the host acts".

- **Bridge** (rigs-boot.js §3, view.js): frame → host also `{type:'select', id, x, y}` (a click: select + the node's action
  menu at the pointer, camera kept), `{type:'context', id|null, x, y}` (right-click; empty floor → the station menu),
  `{type:'action', action, id}` (host whitelist `newAgent`, `sessions`), `{type:'pointer'}` (closes the host's menu); host →
  frame `{type:'fit'}`. The menus are `ctx-providers.js` (`installContextMenu().openFor`): node, session, app, project, task
  and gnode menus as on the galaxy, plus a **Station** group — what the room or desk holds that the floor does not draw
  (agents, models, apps, tools, rigs, sessions, plans, skills), each selecting it in the inspector — and Show the whole station.
- **Picking**: StarNet routes only body and desk clicks. Props (server carts → apps, studio → a tool, workbench → plan,
  intel cabinet → machine, comms dish → mesh) and room floors are hit-tested in the frame with the room-tag camera mapping;
  a right-click on a body asks StarNet's own hit test through a synthetic click the frame keeps to itself.
- **Room tags**: name (select + menu), ✳ New agent on an online machine, +N for agent sessions past the 8 desks or idle for
  over 12 h (opens Sessions on that machine).
- **Created agents walk in**: `agents/start` runs the agent in tmux (`claude-<folder>-<id>`); `tmuxAgent` in
  `src/sessions.js` now names it by that prefix when the pane command does not (Claude Code's native binary titles its
  process with its version), and `model.js` `workerKind` counts tmux / terminal sessions running an agent as workers.
- **Fit / focus**: ◎ Fit and Esc frame the whole station; selecting any node from the side panel frames its room
  (`rooms` covers every node on a machine, plans and tasks on the bridge, a project's first room).
- Still not done, deliberately: phones keep the galaxy; StarNet's own hire / chat / build harness stays fenced off (it
  would not create a RIGS agent).
- Verified: `node scripts/starnet-check.js` — 36 checks, including ✳ → New agent → a real Claude Code in tmux → its worker
  on the floor → a click on its desk → Send message… → `/help` typed through the dock shows in its transcript.
