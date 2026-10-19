# StarNet view — gap list

Task t1 of project `9b07477a3b` ("Deliver starnet view functions"). Audit only: no behaviour changed.
Read-only against `work/macbookpro/deliver-starnet-view-functions-4e52` (base `bbefe12`). Facts come from the code
cited; anything not run is marked *(inferred)*. The station view was **not** launched in this task.

## 1. Duplicate-work check

| Candidate | What it is | Verdict |
| --- | --- | --- |
| Thread `71b70a61` (`~/.rigs/chats/71b70a61-…json`, "Experimental starnet space-station mode") | The JARVIS chat that spawned project `eeb4920bf0`. Its **last message** is Sir's request for this work ("make sure that the starnet view features all starnet functions, so making agents, reaching them, etc"), which JARVIS answered by passing it to the starnet project. | That request **is** project `9b07477a3b` (this one). Not a second implementation. |
| Project `eeb4920bf0` "Experimental starnet space-station mode" | Built the flag, install, iframe view and read-only bridge. 4/4 tasks done, merged as `1b0e97e`. | Not a duplicate: `docs/starnet-integration.md` §6 ("Read-only: the station never mutates JARVIS state") and §8 explicitly put two-way control out of scope. This project is the follow-on. |
| Other projects | `project_list` on macbookpro: only these two mention starnet. | No other project covers it. |

→ Proceed. (Only macbookpro's project list was checked; other mesh nodes' lists were not.)

## 2. What "all starnet functions" means here

Sir's words: "making agents, reaching them, etc". The view replaces the galaxy, so the baseline is **everything you can
do from the galaxy** (the JARVIS inspector, context menu and chat). StarNet's own harness functions (hire an agent,
chat with a worker, assign work, build mode) are a second reading; section 4 covers them separately because the spec
deliberately excluded them.

## 3. Galaxy functions vs the station view

Status: **wired** = reachable from the station today; **partial** = reachable only indirectly or for some nodes;
**missing** = not reachable while the station is on.

The mechanism that makes things work: a click on a station object posts `{type:'select', id}`
(`ui/starnet/rigs-boot.js:200,243,244`) → `onSelect` (`ui/src/main.js:1310`) → `select(id); revealInspector()` →
`renderInspector` (`ui/src/main.js:455`). **Every action below that is "wired" is wired only because it lives in that
inspector.** The station itself has no action UI.

| # | Function | Where it lives (galaxy) | Station status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | **Create an agent on a machine** (✳ New agent: pick agent, folder, prompt, model → tmux) | machine inspector `ui/src/main.js:482`; dialog `:622-631`; API `POST …/agents/start` `:613`; daemon `src/server.js:666` → `sessions.startAgent` `src/sessions.js:389` | **partial** – click the machine's room-name label or `war_intelcab` prop (`model.js:108`; label click `rigs-boot.js:200`) → inspector → button. Works only for an **online rigs machine**; no in-station affordance, nothing on the floor says "you can create here". | main.js:482,622; model.js:108; rigs-boot.js:200 |
| 2 | Create an agent of a given kind (▶ New Claude/Codex/Ollama/rig session) | `agent` node inspector `ui/src/main.js:488` | **missing** – the station has no `agent`-type objects (`WORKER_KINDS` are *sessions*, `model.js:21,46`; no prop maps to an agent node). Only the generic dialog (row 1) remains, where kind is a dropdown. | main.js:488; model.js:21,46 |
| 3 | New agent in a project folder (✳ Claude here / ▶ New Claude here) | project inspector `main.js:509`; pinned-project window `main.js:379` | **missing** – `project` nodes are not drawn (`model.js` header: only machines, bridge workbench=plan, workers). | main.js:379,509 |
| 4 | **Reach an agent: read its transcript** (📜) | session inspector `main.js:220-223,354` (`sessionsWindow`/`attachSession`) | **wired** – a worker click or desk click selects the session node (`rigs-boot.js:243,244`). | rigs-boot.js:243-244; main.js:220-223 |
| 5 | **Reach an agent: chat / send** (💬 Chat here, `POST …/sessions/send`) | session inspector; send at `main.js:939,1124`; daemon `src/server.js:659` → `sessions.send` (rig seats use `rig send`, `src/sessions.js:274-275`) | **wired** (via inspector, same as 4). | main.js:939,1124; server.js:659 |
| 6 | Attach / resume / open the session's terminal (⌨) | session inspector | **wired** (via inspector). | main.js:223 |
| 7 | Reach an **offline or old** agent | galaxy shows all sessions | **partial** – a worker exists only if live, needs-you, or active in the last 12 h (`RECENT_MS`, `model.js:20,49`), max **8 desks per room** (`MAX_WORKERS`, `model.js:16,~118`; overflow is dropped silently, the spec's "+N" prop was not built). Older sessions are reachable only through 💬 Sessions on the machine. | model.js:16,20,49 |
| 8 | Reach a non-session thing the galaxy draws: `project`, `task`, `model`, `rig`, `tool`, `app`, `skill` nodes | inspector branches `main.js:492-530` (Talk to model, OpenRig TUI, Open app, Open project…) | **partial/missing** – only `plan` (bridge workbenches, max 4 – `MAX_PLANS`) and machines are clickable. `studio` and `gigs_servercart` props are drawn for tools/apps but have **no** `ids` entry, so clicking them selects nothing (`model.js:111-112`). Tasks, models, rigs, skills are absent. | model.js:111-112; main.js:492,526,530 |
| 9 | Machine actions: Terminal, Files, Desktop, Access & control, Sessions, Use as brain, Processes, SSH, OpenRig TUI | machine inspector `main.js:475-486` | **wired** (via inspector, row 1 mechanism). | main.js:475-486 |
| 10 | Talk to JARVIS / pick a brain / voice commands ("start claude on …", `main.js:871`) | chat dock, command bar | **wired** – independent of the canvas; unaffected. | main.js:871 |
| 11 | **Right-click context menu on the canvas** (`galaxyTarget`) | `installContextMenu` + `galaxyEl._ctxAt` `main.js:1436-1439`; `ctx-tag.js:36` | **missing** – the station is an iframe; `contextmenu` fires inside the frame's document, which the host's listener (`contextmenu.js:72`) never sees. `#graph` (where `_ctxAt` is set) is `visibility:hidden` under the station (`view.js:20`). Nothing in `rigs-boot.js` posts a context event; the spec's `{type:'context', id, x, y}` (`docs/starnet-integration.md` §6) was dropped. | contextmenu.js:72; main.js:1438; view.js:20; rigs-boot.js:11-12 (bridge lists no `context`) |
| 12 | Filters / hide types (`graph.setHidden`) | Filters panel | **partial** – `hidden` is passed to `stationFromGraph` (`view.js:27`), so types it models respect it; types it doesn't draw are simply never shown. | view.js:27; model.js:62,65 |
| 13 | Attention ("needs you") | `graph.setAttention` | **wired** – worker walks to wait pose via `permission.prompt` (`rigs-boot.js:137-160`). | rigs-boot.js:137-160 |
| 14 | Focus a node chosen in the side panel / search | `starnetFocus` `main.js:431` | **partial** – frames the room for machines and workers only (`rigs-boot.js:161-166`); other ids do nothing. | main.js:431; rigs-boot.js:161 |
| 15 | **◎ Fit** (whole mesh) | `#fit` `ui/index.html:52`; `main.js:438,1428` | **missing** – fits the hidden galaxy (recorded as "not done" in `docs/starnet-integration.md` §10). Large meshes need manual scroll/drag. | index.html:52; main.js:438 |
| 16 | Phone use | galaxy works at 390 px | **missing by design** – `apply()` refuses the view on phones (`ui/src/starnet/index.js:53`). | starnet/index.js:53 |
| 17 | Turn the view on/off, install | `Experimental › Space station view` `jarvis-commands.js:105,159`; `rigs starnet`; `/api/local/starnet/{config,install}` `server.js:812-814` | **wired** | jarvis-commands.js:105; server.js:812-814 |
| 18 | Without StarNet installed | – | **partial** – flag on + not installed → toast with Install button, galaxy stays (`starnet/index.js:52-60`). Install is ~376 MB. | starnet/index.js:52-60 |

## 4. StarNet's own harness functions (second reading)

These exist inside StarNet but the frame fences them off: `rigs-boot.js` answers every non-`/starnet/` request
"offline" (`allowed()`, `rigs-boot.js:49`), the daemon also 403s `/api/*` calls from the station (`src/server.js:1274`,
`src/starnet.js:266`), and the `docs/starnet-integration.md` §8 lists them out of scope. Whether their UI is visible but
dead, or hidden, was **not run** *(inferred: visible, failing quietly offline)*.

| Function | Status | Note |
| --- | --- | --- |
| Hire / create a StarNet agent from the station | **missing** | No sidecar; it would not create a RIGS agent anyway. This is the closest thing to "making agents" *inside* the station. |
| Chat with / assign a task to a worker in the station | **missing** | Same fence. Reaching works only via the host inspector (rows 4-6). |
| Build mode / refit, hallways, placed objects as grants | **missing**, and hazardous | Station layout is regenerated by `stationFromGraph` (`model.js:61`); edits would be overwritten on the next re-bake. |
| Quests/XP/dossier/sounds/skills | **missing** (excluded on purpose) | Spec §8. |

## 5. Gaps ranked by how much they block "create and reach agents"

1. **No in-station create/reach affordances.** Both work only after a click → inspector (rows 1, 4–6). A user in the
   station sees no sign of it; the inspector may be collapsed (`revealInspector` is called, but nothing on the floor
   hints at actions). *Fix direction:* machine/worker click opens a station-anchored action menu (New agent here,
   Chat, Transcript, Terminal) built from the same handlers.
2. **No right-click menu (row 11).** The standard way to act on a node is dead over the station. Needs a
   `{type:'context', id, x, y}` message from `rigs-boot.js` and host handling.
3. **Agent-kind and project entry points absent (rows 2, 3).** Creating "a Codex here" or "Claude in project X"
   is impossible without the generic dialog.
4. **Reach limits (row 7):** 8 desks/room, 12 h window, silent overflow — a busy machine hides agents you may want.
5. **Non-session nodes unreachable (row 8):** tool/app/server props are inert; tasks, models, rigs, skills missing.
6. **◎ Fit and focus (rows 14–15)** don't operate on the station.
7. **Phone (row 16)** falls back to the galaxy — acceptable, record only.
8. **StarNet-native hire/chat (§4)** — decide whether Sir wants these bridged to RIGS (e.g. station "hire" → `agents/start`)
   or left out; this changes scope of t2 materially. Assumption for t2: bridge the *RIGS* functions through the
   station UI (items 1–3), not StarNet's own harness.

## 6. Suggested t2 scope

- Add bridge messages `context` and `action` (host-side whitelist: `newAgent`, `chat`, `transcript`, `terminal`), origin-checked as today.
- Reuse the inspector handlers (`newAgent`, `startAgent`, `attachChat`, `sessionsWindow`, `openTerminal`) — no new daemon routes needed.
- Map `studio`/`servercart` props to ids; show a "+N" prop for overflow; make Fit frame the station.
- Extend `scripts/starnet-check.js` (23 checks today) with: create an agent from the station, send to a worker, right-click menu on a worker.
