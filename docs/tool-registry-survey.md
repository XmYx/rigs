# Tool and applet registry survey

Task t1 of project 0010e8a52d (JARVIS reusable tool and applet registry). Read-only research on magix-system and macbookpro, 2026-10-18. Feeds t2 (registry + MCP tools) and t3 (import).

## How this was measured

- Sources: 1,119 Claude Code transcripts (4.9 GB, 86 project dirs) under `~/.claude/projects`, `~/.rigs/{chats,briefs,projects,traces,usage,scratch}`, the 25 dev worktrees in `~/rigs-dev`, `~/.config/systemd/user`, `config.apps` and `mesh_apps` on both nodes, `appstore/catalog`, and app folders in `~`. Codex transcripts (`~/.codex/sessions`) were not scanned (not a source of `Write` tool calls I could parse the same way); macbookpro was checked for registered apps and LaunchAgents only, not its transcripts.
- **Reuse count** = number of distinct transcripts whose tool calls (Bash/Write/Edit inputs) match a pattern for that job. It is an **upper bound** on "sessions that needed this", not a count of rewrites; pattern definitions are in the `evidence` of each JSON entry. `distinct_impls` is the number of separate implementations I could actually find on disk, which is the stricter "reimplemented" number.
- **Tokens saved** = (reuse_sessions - 1) x an estimated cost of writing and debugging the helper from scratch (script size and discovery work, tokens). The per-use estimate is my judgment, not a measurement, so treat the ranking as ordinal.
- An earlier prompt-cluster pass over the same sessions lives in `~/.rigs/scratch/mining-magix-system/clusters.json` (user requests, not code); its clusters `jarvis-app-cloud`, `service-handshake`, `asset-gen-comfy-trellis` and `mod-dashboard-requests` agree with rows 1, 3, 4 and 5 below.

## Candidate tools, ranked by tokens likely saved

| # | Tool | Sessions matched | Distinct impls found | Est. tokens saved | Best implementation | Unattended-safe |
|---|------|------|------|------|------|------|
| 1 | **usage-transcript-parse** | 106 | 4 | 262,500 | `src/usage.js` | yes |
| 2 | **unity-compile-check** | 56 | 1 | 220,000 | `/home/magix/PycharmProjects/MadMaxUnity/share/tools/compile_check.py` | yes |
| 3 | **comfyui-client** | 52 | 5 | 204,000 | `src/comfyui.js` | no |
| 4 | **mobile-audit-playwright** | 33 | 3 | 192,000 | `scripts/mobile-shots.js` | yes |
| 5 | **cdp-screenshot** | 42 | 13 | 123,000 | `applets/krea-studio/scripts/drive.js` | yes |
| 6 | **app-publish** | 63 | 6 | 93,000 | `src/appstore.js` | yes |
| 7 | **merge-conflict-resolve** | 25 | 3 | 48,000 | `src/merge.js` | no |
| 8 | **report-close** | 119 | 1 | 35,400 | `src/work.js` | yes |
| 9 | **ffmpeg-frames** | 34 | 3 | 19,800 | `/home/magix/PycharmProjects/ComfyWebStudio/backend/comfywebstudio/media/probe.py` | yes |
| 10 | **gpu-lease** | 18 | 2 | 13,600 | `applets/live-video/overseer.js` | yes |
| 11 | **healthz-wait** | 41 | 2 | 8,000 | `src/appstore.js` | yes |
| 12 | **mock-comfy-server** | 2 | 2 | 2,500 | `applets/live-video/scripts/mock-comfy.js` | yes |

### 1. usage-transcript-parse - Parse Claude Code / Codex transcripts and usage ledger (tokens, models, tool calls, todos)

- **Reuse:** 106 sessions in 29 projects match; busiest: Quanto (101), MadMaxUnity (28), CyberNinja (19). Example session ids: e7869a66, 9881d120, fccb1eee, dabebefa, 312d0289.
- **Implementations found (4):** src/usage.js foldRecord/readRecords/aggregate; src/sessions.js transcript readers; Quanto overseer/dashboard parsers (Quanto/dashboard); this survey: three throwaway python scanners over ~/.claude/projects.
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/usage.js (foldRecord, readRecords, aggregate) and src/sessions.js
- **Inputs:** transcript .jsonl path or ledger month file ~/.rigs/usage/<YYYY-MM>.jsonl
- **Outputs:** per-model token totals, group-by model/project/task/node/day, todo state
- **Safe unattended:** yes - Read-only. Transcripts contain pasted credentials: never echo raw message text, redact before writing anywhere. 4.9 GB / 1,119 transcripts on magix-system, so stream line by line.

### 2. unity-compile-check - Compile the Unity C# outside the editor, for worktrees (same refs, defines, analyzers)

- **Reuse:** 56 sessions in 3 projects match; busiest: MadMaxUnity (88), CyberNinja (19), -dev-reusable-tool-and-applet-regis-017a (1). Example session ids: 89afb015, agent-a0, agent-a2, agent-a5, agent-a7.
- **Implementations found (1):** MadMaxUnity/share/tools/compile_check.py (84 lines), copied into wt/n1015, n1016, n1017; CyberNinja uses an equivalent invocation by hand.
- **Best existing:** /home/magix/PycharmProjects/MadMaxUnity/share/tools/compile_check.py
- **Inputs:** checkout root (default cwd); needs the main project Library compiled once by the editor
- **Outputs:** compiler errors only, exit code 1 on errors
- **Safe unattended:** yes - Read-only compile into a temp dir. Hard-coded Unity 6000.6.3f1 and csc paths: parameterise before reusing for other projects or on macbookpro.

### 3. comfyui-client - ComfyUI client (system_stats, object_info check, queue prompt, history, view, upload, ws progress)

- **Reuse:** 52 sessions in 16 projects match; busiest: MadMaxUnity (15), Quanto (12), -home-magix (5). Example session ids: d6bfa67b, 312d0289, a02a3b61, agent-a6, agent-a8.
- **Implementations found (5):** applets/live-video/comfy.js (117 lines, createComfyClient); src/comfyui.js (821 lines, createClient + settings + overseer hook) - same job written twice inside this repo; applets/krea-studio/server.js talking via src/comfyui.js (krea-studio-applet-via-comfyui-910c); ~/PycharmProjects/ComfyWebStudio/backend (pipeline + comfy_browse.py); MadMaxUnity and Quanto asset-generation scripts (inline curl/python to :8188).
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/comfyui.js createClient (auth value redacted in errors; missing node/model check via object_info)
- **Inputs:** base URL, optional auth header, API-format workflow JSON, optional start image
- **Outputs:** prompt id, progress events, history entry, output file stream
- **Safe unattended:** no - Read endpoints (system_stats, object_info, queue, history) are safe. Submitting a graph can auto-download models and burn the GPU: always check /object_info first and never POST /prompt just to validate a graph (see memory note comfyui-prompt-autodownloads). Needs a GPU lease first.

### 4. mobile-audit-playwright - Mobile audit: screenshots + axe-core + layout/touch metrics + perf + keyboard walkthrough

- **Reuse:** 33 sessions in 22 projects match; busiest: MadMaxUnity (4), -dev-krea-studio-applet-via-comfyui-910c (2), -dev-make-project-panel-mobile-frie-c612 (2). Example session ids: 83f00787, 08ec1947, 0a91a721, 927e1244, c3f81e79.
- **Implementations found (3):** scripts/mobile-shots.js (252 lines); scripts/mobile-perf.js (86); scripts/a11y-keyboard.js; byte-identical copies in 18 dev worktrees (md5 76e6446b... mobile-shots), 6 divergent variants.
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/scripts/mobile-shots.js (+ mobile-perf.js, a11y-keyboard.js)
- **Inputs:** --out dir, --url (default spawns rigs serve on :4781 with RIGS_HOME=.rigs-dev), --viewports 390x844,360x740,844x390,740x360, --views; env RIGS_AUDIT_TOOLS=<dir with playwright+axe-core> (~/.cache/rigs-audit)
- **Outputs:** PNGs per view and viewport, axe results, layout and touch-target metrics JSON, perf.json, keyboard-walkthrough.json
- **Safe unattended:** yes - Safe when spawning its own server on :4781; do not point --url at a production daemon. Needs playwright installed outside the repo.

### 5. cdp-screenshot - Headless-Chrome screenshot / drive (desktop 1440x900 and phone 390x844)

- **Reuse:** 42 sessions in 27 projects match; busiest: magix (4), MadMaxUnity (4), op1-field-emu (2). Example session ids: 83f00787, 312d0289, 08ec1947, 0a91a721, 927e1244.
- **Implementations found (13):** applets/navigation/scripts/screenshot.js; applets/live-video/scripts/screenshot.js; applets/krea-studio/scripts/drive.js; scripts/mobile-shots.js (playwright); ~/PycharmProjects/magix/livevideo/ui_check.mjs; ComfyWebStudio/scripts/ui_smoke.py + check_desktop.py + docs_screenshots.py; Quanto/staging/P1.33/shot.py; te-updater/harness/run_capture.mjs; scratchpads: review-shots.mjs (make-project-panel-mobile), e2e.mjs (navigation-trip-recording), ui_check.js (MadMaxUnity).
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/krea-studio/scripts/drive.js (JSON step file: viewport/eval/waitFor/sleep/shot; console errors + failed requests) with applets/navigation/scripts/screenshot.js as the one-shot variant
- **Inputs:** url, output PNG, WIDTHxHEIGHT (width<700 = phone emulation), --wait, --eval, --until, --reduced-motion, --chrome path; or steps.json
- **Outputs:** PNG(s) + printed console errors, exceptions, HTTP>=400 and failed requests
- **Safe unattended:** yes - Spawns its own Chrome with a temp profile and removes it; no write outside the output path. Node built-in WebSocket, no dependencies. Gap: two copies already differ (nav 107 lines, live-video 83) - unify into one parameterised tool.

### 6. app-publish - Publish a web app: systemd --user unit + healthz wait + mesh_app_register (App Cloud)

- **Reuse:** 63 sessions in 22 projects match; busiest: MadMaxUnity (25), -home-magix (13), ix-rigs-dev-build-app-store-catalog-b5d3 (3). Example session ids: d6bfa67b, f2f4f4bf, dabebefa, 312d0289, 08ec1947.
- **Implementations found (6):** applets/*/rigs-*.service units (3 hand-written, one .tmpl); src/appstore.js install flow (venv, models, unit, register, health wait); ~/.config/systemd/user/*.service for 13 hand-made apps; mesh_app_register calls in sessions (build-app-store-catalog-b5d3, krea-studio-applet-via-comfyui-910c, live-video-applet-via-comfyui-5d9e); macOS launchd plist (body-matching) written by hand.
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/appstore.js (install pipeline) + mesh_app_register in src/mcp.js:102; unit template applets/krea-studio/rigs-krea-studio.service
- **Inputs:** id, name, icon, port, healthPath, launch recipe (systemd unit or command per OS)
- **Outputs:** enabled unit, registered App Cloud entry reachable at /api/nodes/<node>/apps/<id>/
- **Safe unattended:** yes - This is the standing ground rule for any app with a web UI, so it is pre-approved. Needs /healthz and relative URLs. Not safe: overwriting an existing unit or app id owned by someone else - check mesh_apps first.

### 7. merge-conflict-resolve - Resolve a merge conflict between dev worktree branches and main (steward flow)

- **Reuse:** 25 sessions in 13 projects match; busiest: MadMaxUnity (9), -home-magix (3), -dev-roll-out-os-control-default-on-32fd (3). Example session ids: 72d2e4ef, 28f75c36, f2f4f4bf, 83f00787, 564f8354.
- **Implementations found (3):** src/merge.js (startWork, bundle, processQueue); rigs_merge_resolved flow used by resolve-cut-token-merge-confli-7f00 and resolve-split-questions-merge-251d; MadMaxUnity nightly/codex branch merges done by hand (9 sessions).
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/merge.js plus MCP tools rigs_dev_start, rigs_propose, rigs_merge_status, rigs_merge_resolved
- **Inputs:** worktree dir, branch, conflicting files
- **Outputs:** merged branch, queue entry, rollout
- **Safe unattended:** no - Rewrites shared history; only the merge steward or a resolver agent should do it. Useful as a documented playbook, not an unattended tool.

### 8. report-close - Finish a RIGS task: rig queue update/close + project_task_update with verification summary

- **Reuse:** 119 sessions in 39 projects match; busiest: op1-field-emu (10), op-1-field-firmwar (8), MadMaxUnity (8). Example session ids: 72d2e4ef, 28f75c36, f2f4f4bf, 83f00787, 298e0fbb.
- **Implementations found (1):** every project task brief (src/work.js builds the text) - agents re-derive the closure flags each time (state=done needs --closure-reason).
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/work.js (brief template) and the project_task_update MCP tool
- **Inputs:** owner, project, task, status, summary, qitem id
- **Outputs:** task marked, queue item closed
- **Safe unattended:** yes - Small per use but present in 119 sessions; a single wrapper that does both calls removes a failure mode (queue item left open).

### 9. ffmpeg-frames - Video probe, frame extraction and contact sheets (ffmpeg/ffprobe)

- **Reuse:** 34 sessions in 17 projects match; busiest: MadMaxUnity (10), Quanto (5), CyberNinja (3). Example session ids: 9881d120, fccb1eee, dabebefa, 312d0289, a02a3b61.
- **Implementations found (3):** ComfyWebStudio/backend/comfywebstudio/media/probe.py; MadMaxUnity/share/tools/encode_intro.sh; inline ffmpeg lines in live-video and Quanto sessions.
- **Best existing:** /home/magix/PycharmProjects/ComfyWebStudio/backend/comfywebstudio/media/probe.py (probe only; no canonical frame-extract script exists)
- **Inputs:** video path, fps or timestamps
- **Outputs:** JSON probe, PNG frames, contact sheet
- **Safe unattended:** yes - Local files only. Needs a canonical implementation written (t3).

### 10. gpu-lease - GPU overseer VRAM lease (acquire before model load, release when idle)

- **Reuse:** 18 sessions in 8 projects match; busiest: MadMaxUnity (4), -home-magix (3), s-dev-live-video-applet-via-comfyui-5d9e (3). Example session ids: 08ec1947, 0a91a721, 927e1244, c3f81e79, 1c894da0.
- **Implementations found (2):** applets/live-video/overseer.js (createOverseer); src/comfyui.js (gpuOverseer + gpuNeedMb option); inline curl against :8195 in sessions of live-video-applet-via-comfyui-5d9e and MadMaxUnity.
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/live-video/overseer.js
- **Inputs:** client name (default comfyui), need_mb, timeout seconds
- **Outputs:** {ok, free_mb, unloaded[]} or {ok:false, unreachable:true}
- **Safe unattended:** yes - Acquire may unload other apps' models by design; always release in a finally block. Overseer service: ~/apps/gpu-overseer/server.py on 127.0.0.1:8195 (registered app gpu-overseer, answers /healthz).

### 11. healthz-wait - Wait for an app /healthz and print the first failing check

- **Reuse:** 41 sessions in 18 projects match; busiest: -home-magix (7), op1-field-emu (5), ix-rigs-dev-build-app-store-catalog-b5d3 (4). Example session ids: 08ec1947, 0a91a721, c3f81e79, c505e84c, 1c894da0.
- **Implementations found (2):** src/appstore.js health wait after install; curl retry loops in 18 projects.
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/appstore.js (health check step)
- **Inputs:** url, timeout
- **Outputs:** ok/failed + last status
- **Safe unattended:** yes - Fold into app-publish.

### 12. mock-comfy-server - Fake ComfyUI server for tests and screenshots

- **Reuse:** 2 sessions in 16 projects match; busiest: MadMaxUnity (15), Quanto (12), -home-magix (5). Example session ids: d6bfa67b, 312d0289, a02a3b61, agent-a6, agent-a8.
- **Implementations found (2):** applets/live-video/scripts/mock-comfy.js; ComfyWebStudio/tests/fixtures/fake_comfy.py.
- **Best existing:** /home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/live-video/scripts/mock-comfy.js
- **Inputs:** port
- **Outputs:** a ComfyUI-shaped HTTP/WebSocket stub that returns canned frames
- **Safe unattended:** yes - No GPU, no model downloads. Counts for this row come from the 2 implementations found, not from the shared comfy_submit session regex.

## Applets and apps

Every web app found. "Registered" means present in App Cloud (`mesh_apps`) on that node at survey time. Ports verified with `ss -ltn` on magix-system.

| id | kind | node | port | launch | registered | path |
|----|------|------|------|--------|-----------|------|
| krea-studio | repo-applet | magix-system | 8732 | systemd --user rigs-krea-studio.service (unit file in repo; NOT installed in ~/.config/systemd/user); node server.js, env KREA_PORT=8732 | no | `/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/krea-studio (deployed: ~/.rigs/app/applets/krea-studio)` |
| live-video-comfy | repo-applet | magix-system | 8741 | systemd rigs-live-video.service (installed) | yes | `/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/live-video (deployed ~/.rigs/app/applets/live-video)` |
| live-video-comfy | repo-applet | macbookpro | 8741 | command: node /Users/mix/.rigs/app/applets/live-video/server.js | yes | `/Users/mix/.rigs/app/applets/live-video` |
| navigation | repo-applet | magix-system | 8731 | systemd rigs-navigation.service (installed, from rigs-navigation.service.tmpl) | yes | `/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/navigation (deployed ~/.rigs/app/applets/navigation)` |
| live-video | legacy-app | magix-system | 8211 | systemd livevideo.service (python venv server.py) | yes | `/home/magix/PycharmProjects/magix/livevideo` |
| krea-studio-legacy | legacy-app | magix-system | 8190 | systemd krea-studio.service (python3 server.py) | yes | `/home/magix/apps/krea-studio` |
| acestep-studio | app | magix-system | 8191 | systemd acestep-studio.service (ace15 venv python server.py) | yes | `/home/magix/apps/acestep-studio` |
| gpu-overseer | app | magix-system | 8195 | systemd gpu-overseer.service (python3 server.py) | yes | `/home/magix/apps/gpu-overseer` |
| grok-agent | app | magix-system | 8196 | systemd grok-agent.service (node server.mjs) | yes | `/home/magix/apps/grok-agent` |
| jarvis-voice | app | magix-system | 8197 | systemd jarvis-voice.service (venv python server.py) | yes | `/home/magix/apps/jarvis-voice` |
| localjev | app | magix-system | 8198 | systemd localjev.service (bun run src/index.ts) | yes | `/home/magix/apps/localjev` |
| worldview | app | magix-system | 8199 | systemd worldview.service (node serve.mjs) | yes | `/home/magix/apps/worldview-host` |
| props-studio | app | magix-system | 8797 | systemd props-studio.service (python3 server.py) | yes | `/home/magix/PycharmProjects/MadMaxUnity/share/tools/visual/props/dashboard` |
| szuf | app | magix-system | 8787 | systemd szuf.service (run.sh), bound to the tailnet address 100.82.152.1 | yes | `/home/magix/PycharmProjects/szuf` |
| op1-screen | app | magix-system | 8793 | systemd op1-screen-viewer.service (python3 -I screen_viewer.py --port 8793) | yes | `/home/magix/op1-field-emu/emu/screen_viewer.py` |
| body-matching | app | macbookpro | 8766 | command: launchctl kickstart gui/$(id -u)/com.rigs.body-matching-host // launchctl bootstrap ... com.rigs.body-matching-host.plist | yes | `(macbookpro) body-matching host, LaunchAgent com.rigs.body-matching-host` |
| comfyui | infra | magix-system | 8188 | systemd comfyui.service (comfyenv python main.py) | no | `/home/magix/ai/ComfyUI` |
| op1-field-emu-app | dev-app | magix-system | 4173 | npm run serve (vite build + preview --host 0.0.0.0 --port 4173) or npm run dev | no | `/home/magix/op1-field-emu/app` |
| comfywebstudio | dev-app | magix-system | 5173 | npm run dev --prefix frontend (.claude/launch.json "studio"); python backend in backend/comfywebstudio | no | `/home/magix/PycharmProjects/ComfyWebStudio` |
| quanto-overseer-dashboard | dev-app | magix-system | 8790 | npm --prefix dashboard run serve (.claude/launch.json "overseer-dashboard") | no | `/home/magix/PycharmProjects/Quanto/dashboard` |
| quanto-guideline-book | dev-app | magix-system | 8765 | python3 guideline/serve.py 8765 | no | `/home/magix/PycharmProjects/Quanto/guideline` |
| magix-site-and-gallery | dev-app | magix-system | 8765 | .claude/launch.json: python3 -m http.server 8765 / 8777 (site), node scripts/organicity-gallery.mjs 8788 (gallery), plus a "signal" server | no | `/home/magix/PycharmProjects/magix` |
| inertiacity | dev-app | magix-system | 5183 | npm run dev -- --port 5183 | no | `/home/magix/PycharmProjects/inertiacity` |
| liverender | dev-app | magix-system | ? | server/app.py (python, see README/setup.sh); port not determined | no | `/home/magix/PycharmProjects/liverender` |

Findings worth acting on:

- `krea-studio` repo applet runs on :8732 but the App Cloud id `krea-studio` still serves the old python app on :8190, and its unit `rigs-krea-studio.service` is only in the repo, not installed. Two live-video apps coexist too (`live-video` :8211 legacy python, `live-video-comfy` :8741 repo applet).
- App Store catalog (`appstore_list`): acestep-studio, krea-studio, live-video, navigation are all `state=external` (registered by hand, never installed through the store). The catalog manifests point at the legacy ports 8190 / 8211, not at the repo applets.
- 8 dev apps have no App Cloud entry (op1-field-emu app, ComfyWebStudio, Quanto dashboard and guideline book, magix site/gallery, inertiacity, liverender), and comfyui is infrastructure. `body-matching` on macbookpro is registered but down.
- 13 of the 14 magix-system units live in `~/.config/systemd/user` as hand-written files with different shapes (WorkingDirectory, venv or system python, `%h` vs absolute home): a single unit template would remove most of the app-publish cost.

## Notes and gaps

- Secrets: none copied. Some launch configs and transcripts contain inline secrets (e.g. in `magix/.claude/launch.json`); only their existence is noted.
- The task's verify one-liner extracts everything after the first newline of the file and parses it as JSON, which cannot hold for a document that also contains prose. The machine-readable block below is therefore a fenced ```json object at the end of the file; extract it with the command in the final section.
- Two counts are inflated by long-running sessions: `usage-transcript-parse` (101 of 106 matches are Quanto sessions, whose overseer reads transcripts continuously) and `unity-compile-check` (88 of the matching tool calls are in one project, MadMaxUnity, where the pattern also matches ordinary dotnet builds). Rank them by distinct implementations (4 and 1) if you want a stricter order: cdp-screenshot, comfyui-client and app-publish then lead.
- Not examined: Codex transcripts, macbookpro transcripts, `~/.rigs/chats` message bodies (only counted), Windows nodes (none online).
- Machine-readable block for t3: `tools` (ranked) and `applets`, `appstore_catalog` as a bonus key.

Extract: `node -e "const s=require('fs').readFileSync('docs/tool-registry-survey.md','utf8');const m=s.match(/```json\n([\s\S]*?)\n```\s*$/);const j=JSON.parse(m[1]);console.log(j.tools.length,j.applets.length)"`

```json
{
 "tools": [
  {
   "id": "usage-transcript-parse",
   "rank": 1,
   "name": "Parse Claude Code / Codex transcripts and usage ledger (tokens, models, tool calls, todos)",
   "reuse_sessions": 106,
   "distinct_impls": 4,
   "est_tokens_saved": 262500,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/usage.js (foldRecord, readRecords, aggregate) and src/sessions.js",
   "inputs": "transcript .jsonl path or ledger month file ~/.rigs/usage/<YYYY-MM>.jsonl",
   "outputs": "per-model token totals, group-by model/project/task/node/day, todo state",
   "unattended": true,
   "note": "Read-only. Transcripts contain pasted credentials: never echo raw message text, redact before writing anywhere. 4.9 GB / 1,119 transcripts on magix-system, so stream line by line.",
   "impls": [
    "src/usage.js foldRecord/readRecords/aggregate",
    "src/sessions.js transcript readers",
    "Quanto overseer/dashboard parsers (Quanto/dashboard)",
    "this survey: three throwaway python scanners over ~/.claude/projects"
   ],
   "evidence": {
    "sessions_matched": 106,
    "projects_matched": 29,
    "top_projects": [
     "Quanto (101)",
     "MadMaxUnity (28)",
     "CyberNinja (19)"
    ],
    "example_session_ids": [
     "e7869a66",
     "9881d120",
     "fccb1eee",
     "dabebefa",
     "312d0289"
    ]
   }
  },
  {
   "id": "unity-compile-check",
   "rank": 2,
   "name": "Compile the Unity C# outside the editor, for worktrees (same refs, defines, analyzers)",
   "reuse_sessions": 56,
   "distinct_impls": 1,
   "est_tokens_saved": 220000,
   "best": "/home/magix/PycharmProjects/MadMaxUnity/share/tools/compile_check.py",
   "inputs": "checkout root (default cwd); needs the main project Library compiled once by the editor",
   "outputs": "compiler errors only, exit code 1 on errors",
   "unattended": true,
   "note": "Read-only compile into a temp dir. Hard-coded Unity 6000.6.3f1 and csc paths: parameterise before reusing for other projects or on macbookpro.",
   "impls": [
    "MadMaxUnity/share/tools/compile_check.py (84 lines), copied into wt/n1015, n1016, n1017",
    "CyberNinja uses an equivalent invocation by hand"
   ],
   "evidence": {
    "sessions_matched": 56,
    "projects_matched": 3,
    "top_projects": [
     "MadMaxUnity (88)",
     "CyberNinja (19)",
     "-dev-reusable-tool-and-applet-regis-017a (1)"
    ],
    "example_session_ids": [
     "89afb015",
     "agent-a0",
     "agent-a2",
     "agent-a5",
     "agent-a7"
    ]
   }
  },
  {
   "id": "comfyui-client",
   "rank": 3,
   "name": "ComfyUI client (system_stats, object_info check, queue prompt, history, view, upload, ws progress)",
   "reuse_sessions": 52,
   "distinct_impls": 5,
   "est_tokens_saved": 204000,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/comfyui.js createClient (auth value redacted in errors; missing node/model check via object_info)",
   "inputs": "base URL, optional auth header, API-format workflow JSON, optional start image",
   "outputs": "prompt id, progress events, history entry, output file stream",
   "unattended": false,
   "note": "Read endpoints (system_stats, object_info, queue, history) are safe. Submitting a graph can auto-download models and burn the GPU: always check /object_info first and never POST /prompt just to validate a graph (see memory note comfyui-prompt-autodownloads). Needs a GPU lease first.",
   "impls": [
    "applets/live-video/comfy.js (117 lines, createComfyClient)",
    "src/comfyui.js (821 lines, createClient + settings + overseer hook) - same job written twice inside this repo",
    "applets/krea-studio/server.js talking via src/comfyui.js (krea-studio-applet-via-comfyui-910c)",
    "~/PycharmProjects/ComfyWebStudio/backend (pipeline + comfy_browse.py)",
    "MadMaxUnity and Quanto asset-generation scripts (inline curl/python to :8188)"
   ],
   "evidence": {
    "sessions_matched": 52,
    "projects_matched": 16,
    "top_projects": [
     "MadMaxUnity (15)",
     "Quanto (12)",
     "-home-magix (5)"
    ],
    "example_session_ids": [
     "d6bfa67b",
     "312d0289",
     "a02a3b61",
     "agent-a6",
     "agent-a8"
    ]
   }
  },
  {
   "id": "mobile-audit-playwright",
   "rank": 4,
   "name": "Mobile audit: screenshots + axe-core + layout/touch metrics + perf + keyboard walkthrough",
   "reuse_sessions": 33,
   "distinct_impls": 3,
   "est_tokens_saved": 192000,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/scripts/mobile-shots.js (+ mobile-perf.js, a11y-keyboard.js)",
   "inputs": "--out dir, --url (default spawns rigs serve on :4781 with RIGS_HOME=.rigs-dev), --viewports 390x844,360x740,844x390,740x360, --views; env RIGS_AUDIT_TOOLS=<dir with playwright+axe-core> (~/.cache/rigs-audit)",
   "outputs": "PNGs per view and viewport, axe results, layout and touch-target metrics JSON, perf.json, keyboard-walkthrough.json",
   "unattended": true,
   "note": "Safe when spawning its own server on :4781; do not point --url at a production daemon. Needs playwright installed outside the repo.",
   "impls": [
    "scripts/mobile-shots.js (252 lines)",
    "scripts/mobile-perf.js (86)",
    "scripts/a11y-keyboard.js",
    "byte-identical copies in 18 dev worktrees (md5 76e6446b... mobile-shots), 6 divergent variants"
   ],
   "evidence": {
    "sessions_matched": 33,
    "projects_matched": 22,
    "top_projects": [
     "MadMaxUnity (4)",
     "-dev-krea-studio-applet-via-comfyui-910c (2)",
     "-dev-make-project-panel-mobile-frie-c612 (2)"
    ],
    "example_session_ids": [
     "83f00787",
     "08ec1947",
     "0a91a721",
     "927e1244",
     "c3f81e79"
    ]
   }
  },
  {
   "id": "cdp-screenshot",
   "rank": 5,
   "name": "Headless-Chrome screenshot / drive (desktop 1440x900 and phone 390x844)",
   "reuse_sessions": 42,
   "distinct_impls": 13,
   "est_tokens_saved": 123000,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/krea-studio/scripts/drive.js (JSON step file: viewport/eval/waitFor/sleep/shot; console errors + failed requests) with applets/navigation/scripts/screenshot.js as the one-shot variant",
   "inputs": "url, output PNG, WIDTHxHEIGHT (width<700 = phone emulation), --wait, --eval, --until, --reduced-motion, --chrome path; or steps.json",
   "outputs": "PNG(s) + printed console errors, exceptions, HTTP>=400 and failed requests",
   "unattended": true,
   "note": "Spawns its own Chrome with a temp profile and removes it; no write outside the output path. Node built-in WebSocket, no dependencies. Gap: two copies already differ (nav 107 lines, live-video 83) - unify into one parameterised tool.",
   "impls": [
    "applets/navigation/scripts/screenshot.js",
    "applets/live-video/scripts/screenshot.js",
    "applets/krea-studio/scripts/drive.js",
    "scripts/mobile-shots.js (playwright)",
    "~/PycharmProjects/magix/livevideo/ui_check.mjs",
    "ComfyWebStudio/scripts/ui_smoke.py + check_desktop.py + docs_screenshots.py",
    "Quanto/staging/P1.33/shot.py",
    "te-updater/harness/run_capture.mjs",
    "scratchpads: review-shots.mjs (make-project-panel-mobile), e2e.mjs (navigation-trip-recording), ui_check.js (MadMaxUnity)"
   ],
   "evidence": {
    "sessions_matched": 42,
    "projects_matched": 27,
    "top_projects": [
     "magix (4)",
     "MadMaxUnity (4)",
     "op1-field-emu (2)"
    ],
    "example_session_ids": [
     "83f00787",
     "312d0289",
     "08ec1947",
     "0a91a721",
     "927e1244"
    ]
   }
  },
  {
   "id": "app-publish",
   "rank": 6,
   "name": "Publish a web app: systemd --user unit + healthz wait + mesh_app_register (App Cloud)",
   "reuse_sessions": 63,
   "distinct_impls": 6,
   "est_tokens_saved": 93000,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/appstore.js (install pipeline) + mesh_app_register in src/mcp.js:102; unit template applets/krea-studio/rigs-krea-studio.service",
   "inputs": "id, name, icon, port, healthPath, launch recipe (systemd unit or command per OS)",
   "outputs": "enabled unit, registered App Cloud entry reachable at /api/nodes/<node>/apps/<id>/",
   "unattended": true,
   "note": "This is the standing ground rule for any app with a web UI, so it is pre-approved. Needs /healthz and relative URLs. Not safe: overwriting an existing unit or app id owned by someone else - check mesh_apps first.",
   "impls": [
    "applets/*/rigs-*.service units (3 hand-written, one .tmpl)",
    "src/appstore.js install flow (venv, models, unit, register, health wait)",
    "~/.config/systemd/user/*.service for 13 hand-made apps",
    "mesh_app_register calls in sessions (build-app-store-catalog-b5d3, krea-studio-applet-via-comfyui-910c, live-video-applet-via-comfyui-5d9e)",
    "macOS launchd plist (body-matching) written by hand"
   ],
   "evidence": {
    "sessions_matched": 63,
    "projects_matched": 22,
    "top_projects": [
     "MadMaxUnity (25)",
     "-home-magix (13)",
     "ix-rigs-dev-build-app-store-catalog-b5d3 (3)"
    ],
    "example_session_ids": [
     "d6bfa67b",
     "f2f4f4bf",
     "dabebefa",
     "312d0289",
     "08ec1947"
    ]
   }
  },
  {
   "id": "merge-conflict-resolve",
   "rank": 7,
   "name": "Resolve a merge conflict between dev worktree branches and main (steward flow)",
   "reuse_sessions": 25,
   "distinct_impls": 3,
   "est_tokens_saved": 48000,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/merge.js plus MCP tools rigs_dev_start, rigs_propose, rigs_merge_status, rigs_merge_resolved",
   "inputs": "worktree dir, branch, conflicting files",
   "outputs": "merged branch, queue entry, rollout",
   "unattended": false,
   "note": "Rewrites shared history; only the merge steward or a resolver agent should do it. Useful as a documented playbook, not an unattended tool.",
   "impls": [
    "src/merge.js (startWork, bundle, processQueue)",
    "rigs_merge_resolved flow used by resolve-cut-token-merge-confli-7f00 and resolve-split-questions-merge-251d",
    "MadMaxUnity nightly/codex branch merges done by hand (9 sessions)"
   ],
   "evidence": {
    "sessions_matched": 25,
    "projects_matched": 13,
    "top_projects": [
     "MadMaxUnity (9)",
     "-home-magix (3)",
     "-dev-roll-out-os-control-default-on-32fd (3)"
    ],
    "example_session_ids": [
     "72d2e4ef",
     "28f75c36",
     "f2f4f4bf",
     "83f00787",
     "564f8354"
    ]
   }
  },
  {
   "id": "report-close",
   "rank": 8,
   "name": "Finish a RIGS task: rig queue update/close + project_task_update with verification summary",
   "reuse_sessions": 119,
   "distinct_impls": 1,
   "est_tokens_saved": 35400,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/work.js (brief template) and the project_task_update MCP tool",
   "inputs": "owner, project, task, status, summary, qitem id",
   "outputs": "task marked, queue item closed",
   "unattended": true,
   "note": "Small per use but present in 119 sessions; a single wrapper that does both calls removes a failure mode (queue item left open).",
   "impls": [
    "every project task brief (src/work.js builds the text) - agents re-derive the closure flags each time (state=done needs --closure-reason)"
   ],
   "evidence": {
    "sessions_matched": 119,
    "projects_matched": 39,
    "top_projects": [
     "op1-field-emu (10)",
     "op-1-field-firmwar (8)",
     "MadMaxUnity (8)"
    ],
    "example_session_ids": [
     "72d2e4ef",
     "28f75c36",
     "f2f4f4bf",
     "83f00787",
     "298e0fbb"
    ]
   }
  },
  {
   "id": "ffmpeg-frames",
   "rank": 9,
   "name": "Video probe, frame extraction and contact sheets (ffmpeg/ffprobe)",
   "reuse_sessions": 34,
   "distinct_impls": 3,
   "est_tokens_saved": 19800,
   "best": "/home/magix/PycharmProjects/ComfyWebStudio/backend/comfywebstudio/media/probe.py (probe only; no canonical frame-extract script exists)",
   "inputs": "video path, fps or timestamps",
   "outputs": "JSON probe, PNG frames, contact sheet",
   "unattended": true,
   "note": "Local files only. Needs a canonical implementation written (t3).",
   "impls": [
    "ComfyWebStudio/backend/comfywebstudio/media/probe.py",
    "MadMaxUnity/share/tools/encode_intro.sh",
    "inline ffmpeg lines in live-video and Quanto sessions"
   ],
   "evidence": {
    "sessions_matched": 34,
    "projects_matched": 17,
    "top_projects": [
     "MadMaxUnity (10)",
     "Quanto (5)",
     "CyberNinja (3)"
    ],
    "example_session_ids": [
     "9881d120",
     "fccb1eee",
     "dabebefa",
     "312d0289",
     "a02a3b61"
    ]
   }
  },
  {
   "id": "gpu-lease",
   "rank": 10,
   "name": "GPU overseer VRAM lease (acquire before model load, release when idle)",
   "reuse_sessions": 18,
   "distinct_impls": 2,
   "est_tokens_saved": 13600,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/live-video/overseer.js",
   "inputs": "client name (default comfyui), need_mb, timeout seconds",
   "outputs": "{ok, free_mb, unloaded[]} or {ok:false, unreachable:true}",
   "unattended": true,
   "note": "Acquire may unload other apps' models by design; always release in a finally block. Overseer service: ~/apps/gpu-overseer/server.py on 127.0.0.1:8195 (registered app gpu-overseer, answers /healthz).",
   "impls": [
    "applets/live-video/overseer.js (createOverseer)",
    "src/comfyui.js (gpuOverseer + gpuNeedMb option)",
    "inline curl against :8195 in sessions of live-video-applet-via-comfyui-5d9e and MadMaxUnity"
   ],
   "evidence": {
    "sessions_matched": 18,
    "projects_matched": 8,
    "top_projects": [
     "MadMaxUnity (4)",
     "-home-magix (3)",
     "s-dev-live-video-applet-via-comfyui-5d9e (3)"
    ],
    "example_session_ids": [
     "08ec1947",
     "0a91a721",
     "927e1244",
     "c3f81e79",
     "1c894da0"
    ]
   }
  },
  {
   "id": "healthz-wait",
   "rank": 11,
   "name": "Wait for an app /healthz and print the first failing check",
   "reuse_sessions": 41,
   "distinct_impls": 2,
   "est_tokens_saved": 8000,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/src/appstore.js (health check step)",
   "inputs": "url, timeout",
   "outputs": "ok/failed + last status",
   "unattended": true,
   "note": "Fold into app-publish.",
   "impls": [
    "src/appstore.js health wait after install",
    "curl retry loops in 18 projects"
   ],
   "evidence": {
    "sessions_matched": 41,
    "projects_matched": 18,
    "top_projects": [
     "-home-magix (7)",
     "op1-field-emu (5)",
     "ix-rigs-dev-build-app-store-catalog-b5d3 (4)"
    ],
    "example_session_ids": [
     "08ec1947",
     "0a91a721",
     "c3f81e79",
     "c505e84c",
     "1c894da0"
    ]
   }
  },
  {
   "id": "mock-comfy-server",
   "rank": 12,
   "name": "Fake ComfyUI server for tests and screenshots",
   "reuse_sessions": 2,
   "distinct_impls": 2,
   "est_tokens_saved": 2500,
   "best": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/live-video/scripts/mock-comfy.js",
   "inputs": "port",
   "outputs": "a ComfyUI-shaped HTTP/WebSocket stub that returns canned frames",
   "unattended": true,
   "note": "No GPU, no model downloads. Counts for this row come from the 2 implementations found, not from the shared comfy_submit session regex.",
   "impls": [
    "applets/live-video/scripts/mock-comfy.js",
    "ComfyWebStudio/tests/fixtures/fake_comfy.py"
   ],
   "evidence": {
    "sessions_matched": 2,
    "projects_matched": 16,
    "top_projects": [
     "MadMaxUnity (15)",
     "Quanto (12)",
     "-home-magix (5)"
    ],
    "example_session_ids": [
     "d6bfa67b",
     "312d0289",
     "a02a3b61",
     "agent-a6",
     "agent-a8"
    ]
   }
  }
 ],
 "applets": [
  {
   "id": "krea-studio",
   "kind": "repo-applet",
   "node": "magix-system",
   "path": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/krea-studio (deployed: ~/.rigs/app/applets/krea-studio)",
   "port": 8732,
   "launch": "systemd --user rigs-krea-studio.service (unit file in repo; NOT installed in ~/.config/systemd/user); node server.js, env KREA_PORT=8732",
   "registered": false,
   "registration_note": "Listening on 127.0.0.1:8732 and /healthz answers ok, but the App Cloud entry krea-studio points at the older python app on :8190 (~/apps/krea-studio). Needs register or a swap."
  },
  {
   "id": "live-video-comfy",
   "kind": "repo-applet",
   "node": "magix-system",
   "path": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/live-video (deployed ~/.rigs/app/applets/live-video)",
   "port": 8741,
   "launch": "systemd rigs-live-video.service (installed)",
   "registered": true,
   "registration_note": "App Cloud id live-video-comfy, up"
  },
  {
   "id": "live-video-comfy",
   "kind": "repo-applet",
   "node": "macbookpro",
   "path": "/Users/mix/.rigs/app/applets/live-video",
   "port": 8741,
   "launch": "command: node /Users/mix/.rigs/app/applets/live-video/server.js",
   "registered": true,
   "registration_note": "App Cloud id live-video-comfy, up"
  },
  {
   "id": "navigation",
   "kind": "repo-applet",
   "node": "magix-system",
   "path": "/home/magix/rigs-dev/reusable-tool-and-applet-regis-017a/applets/navigation (deployed ~/.rigs/app/applets/navigation)",
   "port": 8731,
   "launch": "systemd rigs-navigation.service (installed, from rigs-navigation.service.tmpl)",
   "registered": true,
   "registration_note": "App Cloud id navigation, up; trips in ~/.rigs/navigation/trips"
  },
  {
   "id": "live-video",
   "kind": "legacy-app",
   "node": "magix-system",
   "path": "/home/magix/PycharmProjects/magix/livevideo",
   "port": 8211,
   "launch": "systemd livevideo.service (python venv server.py)",
   "registered": true,
   "registration_note": "App Cloud id live-video, up; catalog entry live-video state=external"
  },
  {
   "id": "krea-studio-legacy",
   "kind": "legacy-app",
   "node": "magix-system",
   "path": "/home/magix/apps/krea-studio",
   "port": 8190,
   "launch": "systemd krea-studio.service (python3 server.py)",
   "registered": true,
   "registration_note": "App Cloud id krea-studio, up; catalog krea-studio state=external"
  },
  {
   "id": "acestep-studio",
   "kind": "app",
   "node": "magix-system",
   "path": "/home/magix/apps/acestep-studio",
   "port": 8191,
   "launch": "systemd acestep-studio.service (ace15 venv python server.py)",
   "registered": true,
   "registration_note": "up; catalog state=external"
  },
  {
   "id": "gpu-overseer",
   "kind": "app",
   "node": "magix-system",
   "path": "/home/magix/apps/gpu-overseer",
   "port": 8195,
   "launch": "systemd gpu-overseer.service (python3 server.py)",
   "registered": true,
   "registration_note": "up; /healthz ok"
  },
  {
   "id": "grok-agent",
   "kind": "app",
   "node": "magix-system",
   "path": "/home/magix/apps/grok-agent",
   "port": 8196,
   "launch": "systemd grok-agent.service (node server.mjs)",
   "registered": true,
   "registration_note": "up"
  },
  {
   "id": "jarvis-voice",
   "kind": "app",
   "node": "magix-system",
   "path": "/home/magix/apps/jarvis-voice",
   "port": 8197,
   "launch": "systemd jarvis-voice.service (venv python server.py)",
   "registered": true,
   "registration_note": "up"
  },
  {
   "id": "localjev",
   "kind": "app",
   "node": "magix-system",
   "path": "/home/magix/apps/localjev",
   "port": 8198,
   "launch": "systemd localjev.service (bun run src/index.ts)",
   "registered": true,
   "registration_note": "up; health path /ready"
  },
  {
   "id": "worldview",
   "kind": "app",
   "node": "magix-system",
   "path": "/home/magix/apps/worldview-host",
   "port": 8199,
   "launch": "systemd worldview.service (node serve.mjs)",
   "registered": true,
   "registration_note": "up"
  },
  {
   "id": "props-studio",
   "kind": "app",
   "node": "magix-system",
   "path": "/home/magix/PycharmProjects/MadMaxUnity/share/tools/visual/props/dashboard",
   "port": 8797,
   "launch": "systemd props-studio.service (python3 server.py)",
   "registered": true,
   "registration_note": "up; Mad Mike's Garage 3D props dashboard, health path /api/state"
  },
  {
   "id": "szuf",
   "kind": "app",
   "node": "magix-system",
   "path": "/home/magix/PycharmProjects/szuf",
   "port": 8787,
   "launch": "systemd szuf.service (run.sh), bound to the tailnet address 100.82.152.1",
   "registered": true,
   "registration_note": "up; health path /"
  },
  {
   "id": "op1-screen",
   "kind": "app",
   "node": "magix-system",
   "path": "/home/magix/op1-field-emu/emu/screen_viewer.py",
   "port": 8793,
   "launch": "systemd op1-screen-viewer.service (python3 -I screen_viewer.py --port 8793)",
   "registered": true,
   "registration_note": "up; binds 0.0.0.0"
  },
  {
   "id": "body-matching",
   "kind": "app",
   "node": "macbookpro",
   "path": "(macbookpro) body-matching host, LaunchAgent com.rigs.body-matching-host",
   "port": 8766,
   "launch": "command: launchctl kickstart gui/$(id -u)/com.rigs.body-matching-host || launchctl bootstrap ... com.rigs.body-matching-host.plist",
   "registered": true,
   "registration_note": "registered but status=down at survey time"
  },
  {
   "id": "comfyui",
   "kind": "infra",
   "node": "magix-system",
   "path": "/home/magix/ai/ComfyUI",
   "port": 8188,
   "launch": "systemd comfyui.service (comfyenv python main.py)",
   "registered": false,
   "registration_note": "Backend service, not an App Cloud app (listed by mesh_status tools.comfyui)"
  },
  {
   "id": "op1-field-emu-app",
   "kind": "dev-app",
   "node": "magix-system",
   "path": "/home/magix/op1-field-emu/app",
   "port": 4173,
   "launch": "npm run serve (vite build + preview --host 0.0.0.0 --port 4173) or npm run dev",
   "registered": false,
   "registration_note": "Not listening at survey time; no App Cloud entry. op1-screen (8793) is the registered part of this project."
  },
  {
   "id": "comfywebstudio",
   "kind": "dev-app",
   "node": "magix-system",
   "path": "/home/magix/PycharmProjects/ComfyWebStudio",
   "port": 5173,
   "launch": "npm run dev --prefix frontend (.claude/launch.json \"studio\"); python backend in backend/comfywebstudio",
   "registered": false,
   "registration_note": "Dev server only, not listening; no App Cloud entry"
  },
  {
   "id": "quanto-overseer-dashboard",
   "kind": "dev-app",
   "node": "magix-system",
   "path": "/home/magix/PycharmProjects/Quanto/dashboard",
   "port": 8790,
   "launch": "npm --prefix dashboard run serve (.claude/launch.json \"overseer-dashboard\")",
   "registered": false,
   "registration_note": "Not listening; no App Cloud entry"
  },
  {
   "id": "quanto-guideline-book",
   "kind": "dev-app",
   "node": "magix-system",
   "path": "/home/magix/PycharmProjects/Quanto/guideline",
   "port": 8765,
   "launch": "python3 guideline/serve.py 8765",
   "registered": false,
   "registration_note": "Not listening; no App Cloud entry"
  },
  {
   "id": "magix-site-and-gallery",
   "kind": "dev-app",
   "node": "magix-system",
   "path": "/home/magix/PycharmProjects/magix",
   "port": 8765,
   "launch": ".claude/launch.json: python3 -m http.server 8765 / 8777 (site), node scripts/organicity-gallery.mjs 8788 (gallery), plus a \"signal\" server",
   "registered": false,
   "registration_note": "Dev servers only; the gallery launch config sets an admin secret inline (value not copied here)"
  },
  {
   "id": "inertiacity",
   "kind": "dev-app",
   "node": "magix-system",
   "path": "/home/magix/PycharmProjects/inertiacity",
   "port": 5183,
   "launch": "npm run dev -- --port 5183",
   "registered": false,
   "registration_note": "Dev server only"
  },
  {
   "id": "liverender",
   "kind": "dev-app",
   "node": "magix-system",
   "path": "/home/magix/PycharmProjects/liverender",
   "port": null,
   "launch": "server/app.py (python, see README/setup.sh); port not determined",
   "registered": false,
   "registration_note": "Not running, no App Cloud entry"
  }
 ],
 "appstore_catalog": [
  {
   "id": "acestep-studio",
   "state": "external"
  },
  {
   "id": "krea-studio",
   "state": "external"
  },
  {
   "id": "live-video",
   "state": "external"
  },
  {
   "id": "navigation",
   "state": "external"
  }
 ]
}
```
