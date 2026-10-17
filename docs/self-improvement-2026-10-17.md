# JARVIS self-improvement — 2026-10-17

Goal: Sir gives JARVIS a request by voice or chat, and it is routed, planned, executed, verified and reported
back as done, with nobody nudging it. I traced the pipeline end to end (`chat.jarvisSend` → `router.route` →
`server.fileWork` → `planner.planProject` → `planner.dispatchReady` → `work.startTask` → agent →
`project_task_update` → `planner.updateTask`/`tick` → `notify`). I used live mesh state and two acceptance
scenarios.

## Findings, ranked by impact

| # | Impact | Finding | Evidence |
|---|---|---|---|
| 1 | **Critical** | **Agents that go idle without reporting stall forever.** `tick` only noticed a closed OpenRig queue item or a dead tmux session. An agent sitting at its prompt ("I'll pick up once it finishes") was "running" indefinitely. | Mad Mike FPS project `86d35f15bc` t1: "running" for 6 h. OpenRig showed `stalled-after-claim`, `idle-at-prompt`. t2–t6 never started. |
| 2 | **Critical** | **Failures ended silently.** A `failed` task, or a session that ended without reporting (`review`), left the project `running` forever. Its dependents never started, there was no retry, and Sir got no "needs you". | `planner.updateTask` / `tick` (before) |
| 3 | **High** | **Stuck planning was never recovered.** When the daemon restarted during the brain call, the project stayed `planning` for good. The same happened to a `starting` task. | `jarvis-communication-levels` (`4bc7f3e5cf`): `planning` since 2026-10-16 19:36 |
| 4 | **High** | **Scenario A was answered with a question.** "Mad Mike update on the macbook" restricted the search to macbookpro, where MadMaxUnity does not exist, so the request came back unresolved ("ask Sir"). The keyword fallback also routed it to `answer`, and nothing knew the project has a nightly flow (Claude scheduled task `madmikeupdate` on magix-system). | `workspaces.resolve`, `router.heuristicRoute` |
| 5 | **High** | **Scenario B had no target.** "JARVIS feature: …" matched no workspace (or was ambiguous between the RIGS checkouts `~/.rigs/app` and `~/Documents/Rigs`), so JARVIS asked Sir. Binding it to `~/.rigs/app` would have had agents editing the production checkout. | `router.bindWork` |
| 6 | **High** | **Nothing landed RIGS self-changes.** Even when they were done, nobody proposed the branch, followed the merge, or reported after rollout. | — |
| 7 | **Medium** | **Plans had no definition of done.** Tasks had no acceptance criteria or verification step, no plan was guaranteed a final review, and the brief only said "Verify your result". | `planningPrompt`, `taskPrompt` |
| 8 | **Medium** | **The rules preferred talk.** persona/AGENTS.md said "When unsure between answer and implement, prefer answer". That is exactly how work requests turn into talk. | `persona/AGENTS.md` |
| 9 | **Medium** | **Completion was announced with no content.** The final notice was just "Project X is complete." | `updateTask` |
| 10 | **Critical** (found during the proof run) | **Concurrent writes lost updates.** An agent's report and the 20-second tick both read and wrote the project JSON, and one silently undid the other. t2 went back to `starting` while its agent ran, and t3 was dispatched twice. | project `e525365a44`, 09:41–09:42 |
| 11 | **High** (found during the proof run) | **OpenRig injects managed blocks.** It writes about 260 lines of seat culture and onboarding into `CLAUDE.md` in every seat's folder. In a RIGS worktree this blocks the auto-proposal (dirty tree) or gets committed. It also landed in the **installed checkout** `~/.rigs/app`, which made the updater refuse every update on macbookpro ("local uncommitted changes"). | `git status` in `~/.rigs/app`; `MadMaxUnity/CLAUDE.md` on magix-system has the same 4 blocks |
| 12 | **High** (found during the proof run) | **`rig` processes piled up.** `openrig.status()` had a TTL cache but no single-flight. Once a refresh took longer than the TTL, every caller started its own 5–7 `rig` processes. I measured up to 44 concurrent processes and a load average of about 960, and every merge's checks timed out. | `ps` sampling at 13:31 |
| 13 | **Medium** | **Merge checks ran on a loaded worker.** The steward runs `npm test` (all files in parallel) on a machine that also runs agents. Under load, the flaky `test/appproxy.test.js` and the cancelled `merge`/`smoke` files bounced a correct branch three times. | merge `48cab9e6` ×3 |
| 14 | **Low** | **Codex direct sessions can still ask for escalation.** They run with `approval on-request`. The attention feed surfaces those waits, and the watchdog leaves them alone. Claude agents run in `auto` mode and OpenRig seats in `builtin:auto`. | `models.agentModes` — left as is |

## What changed

Five merges, all rolled out with `mesh_update`:
- `5946254`: the pipeline.
- tick settle.
- `planner-race`.
- `openrig-managed-blocks`.
- `3732a29`: the install fix plus the single-flight `rig` status.

New tests are in `test/autonomy.test.js` (14), `test/openrig.test.js` and `test/merge.test.js`.

- **Routing** (`workspaces.js`, `router.js`, `chat.js`)
  - **Flows.** Claude scheduled tasks (`~/.claude/scheduled-tasks/*/SKILL.md`) are indexed and attached to the workspace whose name or title they spell. "Mad Mike update" matches `madmikeupdate`, which belongs to MadMaxUnity.
  - **Where the code lives.** If the machine Sir names lacks the workspace, the request resolves to the machine where it lives, with a note: "asked for macbookpro, but MadMaxUnity lives on magix-system — it runs there".
  - **Self-changes.** JARVIS/RIGS requests, or matches on a RIGS checkout, become a self-change bound to this node. They never point at the installed app.
  - **No talk for work.** A named flow or "JARVIS feature: …" is never left as `answer`/`continue`. The keyword fallback now knows update / improve / make … more / feature. Questions stay questions.
- **Filing** (`server.fileWork`)
  - Self-changes get their own dev worktree (`merge.startWork`).
  - Flow requests run the flow (`planner.planFlow`: a run task plus a review task) instead of being planned from scratch.
  - Filed projects are marked `autoRun`.
- **Planning** (`planner.js`)
  - Every task carries `acceptance` and `verify`. UI work must include phone-viewport screenshots.
  - `ensureFinalReview` guarantees the plan ends in an independent review that depends on every leaf task.
  - Self-change plans know the worktree and branch, and never plan their own merge.
- **Briefs**
  - A definition of done: check every criterion, fix and re-check on failure, put evidence in the summary.
  - Never stop to ask, and never end a turn while waiting on a background job.
  - A retry brief includes the previous failure.
- **Lifecycle** (`planner.js`, `work.js`)
  - **Retries.** `retryOrFail` gives one fresh attempt for a reported failure, a silently ended session or a failed dispatch (which re-routes). After that the task is `failed` and the project becomes `blocked`, with a spoken "needs you".
  - **Watchdog.** `watchTask` detects idle agents from OpenRig liveness (`idle-at-prompt`) or an unchanged tmux pane fingerprint. It nudges every 15 min (`rig send` / tmux `send-keys`) and escalates to `blocked` after 3 nudges. Agents waiting on a permission are left to the attention feed.
  - **Recovery.** Stuck `planning` is re-planned once for `autoRun` projects; other projects go back to draft. A task stuck in `starting` is retried.
  - **Completion.** `settle` finishes the project with `finalReport`: a spoken line plus each task's evidence. For RIGS self-changes it proposes the worktree to the merge steward. `followMerge` turns failed checks into a fix task and proposes again, and reports "merged and rolled out" once the branch is merged.
- **Rules** (`persona/AGENTS.md`): imperatives are work, not talk. Added the flow and "JARVIS feature" rules.
- **Consistency** (`planner.withProject`, `work.findTask`)
  - Project changes are serialized per project. Dispatch claims tasks under the lock, starts them outside it, and writes each result onto the current state.
  - A task stuck in `starting` is first looked up on its machine (OpenRig queue item or tmux session) and adopted if its agent is already working. Live: "t2 was already running … adopted", 09:56.
  - A running project that nothing can move any more is escalated by the tick. Live: the Mad Mike FPS project went to `blocked` with "needs you".
- **Clean install and repos** (`merge.js`, `updater.js`, `work.js`)
  - OpenRig blocks are stripped from a team's worktree before RIGS proposes it, and the steward refuses branches that add them to `CLAUDE.md`/`AGENTS.md`.
  - The updater strips them from the install before its dirty check. macbookpro needed one forced fast-forward (no file overlap, nothing discarded); after that it cleaned itself.
  - Agents are never started in the installed checkout.
- **Load** (`openrig.js`): status refreshes are single-flight and shared by every caller. `force` means "newer than 2 s". Concurrent `rig` processes dropped from up to 44 to about 10.

## Acceptance scenarios

**A — "Mad Mike update on the macbook".**
- **Before:** the search was limited to macbookpro and found no workspace, so the request was unresolved and JARVIS asked Sir. With the model router down it was routed to `answer`.
- **Now (live check against the real mesh):** `mesh_workspaces` resolves it to MadMaxUnity on magix-system, flow `madmikeupdate`, with `elsewhere: true, wanted: [macbookpro]`. `planFlow` puts the run task (Claude Opus) and the cross-check review (Codex) on magix-system. Both behaviours are covered by unit tests.
- **Not run:** I did not dispatch a real nightly run. That runs on schedule, and the Unity editor on magix-system is already held by the FPS project's seat; a second agent driving the same editor would conflict.

**B — "JARVIS feature: make the mobile site more accessible and pleasing to use on mobile".** Sent to the live
`/api/local/jarvis/send` after rollout. See the proof run below.

## Proof run (scenario B): done without human input

Sent at 09:16 to `POST /api/local/jarvis/send`, exactly as typed by Sir. Nobody touched the project after that.
(I fixed RIGS bugs in parallel through the normal propose flow; the project itself got no manual nudges, edits or
dispatches.)

| Time | What happened |
|---|---|
| 09:16 | **Routed and filed.** The router model picked `plan` and bound the request to RIGS itself. It was filed as project `e525365a44` in a fresh worktree `~/rigs-dev/mobile-site-accessibility-and-82ae`, and JARVIS answered in one line. |
| 09:17 | **Planned.** Opus produced 6 tasks: audit → layout ∥ a11y → polish ∥ regression test → final review. Each task had acceptance criteria and a verify step, and phone-viewport screenshots were required. |
| 09:41 | **t1 audit done** (Sonnet). About 40 issues, a reusable `scripts/mobile-shots.js` (Playwright + axe), baseline screenshots. |
| 09:56 | **t2 adopted.** The watchdog adopted t2's live agent after the lost-update race (finding 10, fixed by then). |
| 10:13–10:19 | **Kept alive.** Another session's OpenRig keep-alive kept t2's seat going through daemon restarts. |
| 10:26 | **t3 accessibility done** (Sonnet). Landmarks, dialogs with focus trap and return, a live region, accessible names, reduced motion. |
| 10:41 | **t2 phone layout done** (Opus, high effort). Phone drawer, full-screen windows, 44px targets, safe areas. |
| 10:59 | **t5 regression test done.** `test/mobile-a11y.test.js`, part of `npm test`. |
| 11:14 | **t4 polish done.** PWA manifest and icons, type scale, touch feedback, galaxy budget, pause when hidden. |
| 13:36 | **t6 final review done** (Opus). The machine was at load 500–800 and Chromium crashed there, so the reviewer moved its browser runs to magix-system on its own. It fixed 6 more defects (R1–R6), including keyboard activation of the orb/face/dock and a capture script that could have written the real `~/.ssh`. Verdict: better on phones, desktop unchanged. |
| 13:36 | **Proposed.** RIGS stripped the OpenRig blocks and proposed the branch to the merge steward itself. |
| 13:37–13:55 | **Merged.** Main moved twice meanwhile (other sessions' UI work). Resolver agents handled both conflicts. Merged as `c47b40e` and rolled out to macbookpro and magix-system. The project went to `done` and its final report was spoken through `mesh_notify`. |

Reviewer's evidence:
- **Tests:** build + `npm test` 121/121 on Linux, including the browser test.
- **Screenshots:** at 390×844, 360×740 and 1440×900, overflow 0, small targets 0, page errors 0 across 44 views.
- **axe:** 0 serious or critical violations.
- **Lighthouse mobile:** accessibility 91 → 100, SEO 82 → 91, performance 25 → 32–36, page weight 2158 → 1639 KB.
- **Keyboard and reduced-motion walkthrough:** 16/16.
- **Side-by-sides:** `docs/mobile-audit/review/`.

The reviewer listed 14 open items in `docs/mobile-audit.md`. The main one: the "agent needs you" banner covers the drawer search on phones.

## Still open / for Sir

- **Mad Mike FPS project (`86d35f15bc`) is `blocked` and needs Sir.** t1 captured a baseline on `perf/baseline-1017`, but 2 of its done-criteria are open.
- **MadMaxUnity's `CLAUDE.md` on magix-system carries 4 OpenRig managed blocks** that seats injected. It's Sir's file, so I left it alone; they can be deleted (between the `BEGIN/END OpenRig MANAGED BLOCK` markers).
- **macbookpro is overloaded.** The data disk is 99% full (16 GB free), Safari/WebKit runs at about 60% CPU, and several agent teams are active. Merge checks are more reliable from the steward on magix-system.
- **`test/appproxy.test.js` is flaky under load on main too** (1 failing run in 4). It needs longer timeouts or serial execution.
- **Parallel tasks share one worktree.** In B, t2 and t3 committed to the same branch at the same time. It worked, but a per-task branch merged by the reviewer would be cleaner.
- **Codex is switched off by `routing.avoid` on this machine** (another session's change), so cross-check reviews went to Opus.
- **Scenario A wasn't dispatched for real** (routing verified live). Saying "Mad Mike update" now runs `madmikeupdate` on magix-system with a Codex/Opus review.
