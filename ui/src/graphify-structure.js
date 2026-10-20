// Graphify "Structure" view: how JARVIS itself is meant to work — its tool surfaces, the pre-routing algorithm, the
// project → agent pipeline, the completion loop and the merge steward — as nodes and edges for graph.js. Pure data (no
// DOM, no three.js) so node --test can check it. Every node names the file (`src`) and a symbol that must appear in it
// (`sym`); test/graphify.test.js reads the source and fails when a claim no longer matches the code, so this diagram
// cannot drift silently. The positions are a grid (col, row): a flowchart read left → right, one lane per concern.
// When the design changes, change the source first and then the row here.

export const S_TYPES = {
  's-entry': { label: 'Entry points', color: '#e2e8f0' },
  's-stage': { label: 'Components & steps', color: '#60a5fa' },
  's-decision': { label: 'Decision points', color: '#fbbf24' },
  's-route': { label: 'Routes', color: '#f472b6' },
  's-agent': { label: 'Agents & brains', color: '#f5c451' },
  's-surface': { label: 'Tool surfaces', color: '#22d3ee' },
  's-registry': { label: 'Registries & apps', color: '#e879f9' },
  's-store': { label: 'State & ledgers', color: '#4ade80' },
  's-outcome': { label: 'End states', color: '#a3e635' },
  's-lane': { label: 'Lane', color: '#475569', hidden: true }, // a lane's title: a label on the diagram, not a component
};

// Link kinds: flow = next step, branch = a decision's outcome, loop = feedback / retry / fallback, tool = calls or feeds.
export const S_LINKS = {
  flow: { label: 'Next step', color: '#38bdf8' },
  branch: { label: 'Decision outcome', color: '#fbbf24' },
  loop: { label: 'Retry · fallback · feedback', color: '#f87171' },
  tool: { label: 'Calls · feeds', color: '#22d3ee' },
};

export const LANES = [
  { id: 'tooling', label: 'Tools & surfaces' },
  { id: 'routing', label: 'Intake & routing' },
  { id: 'work', label: 'Projects → agents' },
  { id: 'loop', label: 'Completion loop' },
  { id: 'merge', label: 'Merge steward' },
];

// Node volume (graph.js draws radius = 2.6 · cbrt(val)): big enough to read as a diagram when the whole thing is in view.
const SIZE = { 's-entry': 50, 's-stage': 26, 's-decision': 38, 's-route': 40, 's-agent': 44, 's-surface': 34, 's-registry': 44, 's-store': 38, 's-outcome': 40 };
export const GRID = { col: 118, row: 70 };
const { col: COL, row: ROW } = GRID;

// [id, type, lane, name, [col, row], src, sym, what it is and the rule it applies, tools?]
const N = [
  // ── Tools & surfaces ────────────────────────────────────────────────────────────────────────────────────────────
  ['rest', 's-surface', 'tooling', 'REST API', [0, 0], 'src/server.js', 'jarvis/send',
    '/api/local/* acts on this machine; /api/nodes/<id>/* proxies to any peer (proxy.js); /api/nodes/<node>/apps/<id>/* is the App Cloud proxy. The UI, the CLI and the MCP server all go through it.'],
  ['cli', 's-surface', 'tooling', 'rigs CLI', [1, 0], 'bin/rigs.js', 'preroute',
    'Supervisor (`rigs start` restarts the server on exit 75 and rolls back a crash-looping update) and the command line: rigs preroute, rigs dev / propose, rigs tools, rigs mcp …'],
  ['mcp', 's-surface', 'tooling', 'rigs MCP server', [3, 0], 'src/mcp.js', 'project_task_update',
    '`rigs mcp`: the stdio MCP server that gives every coding agent (Claude Code, Codex) the mesh. Tools come in families, below; each one calls the REST API of the machine it targets.'],
  ['registry', 's-registry', 'tooling', 'Tool registry', [5, 0], 'src/toolbox.js', 'matchTools',
    'Scripts agents wrote for a task, kept for reuse (RIGS_HOME/tools/<id>/manifest.json + script, plus seed tools in the checkout). searchCatalog ranks tools and App Cloud applets together. The reuse loop: matchTools (keyword match, no model) puts the tools that fit a task into every task brief (briefSection) and the planning prompt. runTool passes JSON args on stdin under a timeout and refuses mutating tools without allowMutating.'],
  ['appcloud', 's-registry', 'tooling', 'App Cloud', [6, 0], 'src/apps.js', 'resolveApp',
    'Anything with a web UI that agents build is published here: config.apps validated, health-probed, proxied at /api/nodes/<node>/apps/<id>/ and opened as a window in every JARVIS on the mesh. Registered with mesh_app_register, started with mesh_app_start.'],
  ['traces', 's-store', 'tooling', 'Request traces', [7, 0], 'src/trace.js', 'startSpan',
    'One traceId per request from Sir and a tree of spans: intake → router → brain turn → tool calls → plan → dispatch → task run. Shown in the Request traces panel and trace explorer.'],
  ['usage', 's-store', 'tooling', 'Usage ledger', [8, 0], 'src/usage.js', 'recordRequest',
    'One JSONL record per chat turn, planning call, task run and request in RIGS_HOME/usage: model, node, tokens, cost, outcome and the pre-routing timing behind the "time saved" figures.'],

  ['mcp-mesh', 's-surface', 'tooling', 'mesh_* reach', [1, 1.2], 'src/mcp.js', 'mesh_exec',
    'Act on any machine of the tailnet: run commands, read / write / list files, processes, sessions of Claude Code · Codex · OpenRig, start an agent, ask another machine\'s brain, notify Sir, open the JARVIS file browser at a folder (ui_open), update a machine.',
    ['mesh_status', 'mesh_exec', 'mesh_read_file', 'mesh_write_file', 'mesh_list_dir', 'mesh_processes', 'mesh_kill', 'mesh_sessions', 'mesh_session_transcript', 'mesh_send', 'mesh_start_agent', 'mesh_ask', 'mesh_notify', 'ui_open', 'mesh_update', 'mesh_workspaces', 'mesh_pin_project']],
  ['mcp-control', 's-surface', 'tooling', 'Screen control (gated)', [2, 1.2], 'src/mcp.js', 'mesh_control',
    'See and drive a machine\'s desktop. Gated by the access policy (src/access.js); no tool can switch control on, only Sir can, and every refusal is explained.',
    ['mesh_screen', 'mesh_windows', 'mesh_control', 'mesh_access']],
  ['mcp-projects', 's-surface', 'tooling', 'Projects & tasks', [3, 1.2], 'src/mcp.js', 'jarvis_task',
    'File work and report on it. jarvis_task is the brain\'s hand-off (planner.intake); project_task_update is the agent\'s completion report (planner.updateTask) — the only way RIGS learns a task finished.',
    ['jarvis_task', 'project_list', 'project_get', 'project_create', 'project_dispatch', 'project_stop', 'project_resume', 'project_feedback', 'project_task_update']],
  ['mcp-change', 's-surface', 'tooling', 'Change policy', [4, 1.2], 'src/mcp.js', 'rigs_propose',
    'How RIGS itself is changed: a dev worktree off main, then a proposal to the merge steward. Nobody commits to main.',
    ['rigs_dev_start', 'rigs_propose', 'rigs_merge_status', 'rigs_merge_resolved']],
  ['mcp-tools', 's-surface', 'tooling', 'Tool registry tools', [5, 1.2], 'src/mcp.js', 'tool_register',
    'Search, read, file and run reusable scripts before writing a new helper.',
    ['tool_list', 'tool_get', 'tool_register', 'tool_run']],
  ['mcp-apps', 's-surface', 'tooling', 'Apps & store', [6, 1.2], 'src/mcp.js', 'mesh_app_register',
    'Publish, start and list App Cloud apps; install from the app store.',
    ['mesh_apps', 'mesh_app_register', 'mesh_app_start', 'appstore_list', 'appstore_install']],
  ['mcp-observe', 's-surface', 'tooling', 'Traces & usage', [7, 1.2], 'src/mcp.js', 'trace_get',
    'Read-only views of the request traces, the usage ledger and the pre-routing statistics.',
    ['trace_list', 'trace_get', 'usage_report', 'preroute_stats', 'exhibit_get']],
  ['mcp-conn', 's-surface', 'tooling', 'Connectors', [8, 1.2], 'src/mcp.js', 'linear_issues',
    'Linear (read; writes only on Sir\'s explicit request) and the read-only Google Drive tools. A disconnected connector answers {connected:false}, not an error.',
    ['linear_status', 'linear_issues', 'linear_issue', 'linear_create_issue', 'linear_update_issue', 'linear_comment', 'drive_search', 'drive_read']],

  // ── Intake & routing ────────────────────────────────────────────────────────────────────────────────────────────
  ['sir', 's-entry', 'routing', 'Sir — voice · chat · API', [0, 3.2], 'src/server.js', 'jarvis/send',
    'A request from the JARVIS UI (typed or spoken) arrives as POST jarvis/send; agents and other tools can send the same way. One JARVIS for the mesh: on any machine that is not the main brain (globalbrain.js homeNode) the request is relayed once to the main-brain machine, which answers and delegates; if it is unreachable this machine answers and says so. The brains, router, routing rules and quick path are global settings (config.globalRev): changed anywhere, pushed to every peer, pulled again when a peer returns.'],
  ['global', 's-store', 'routing', 'Global JARVIS settings', [0, 4.4], 'src/globalbrain.js', 'relayTarget',
    'brain.core · brain.chat · brain.home (main-brain machine) · router · routing · quick, stamped with a revision; the newest revision wins on every machine. Machine-bound keys (Ollama URL, LocalJev url/key, permission modes) stay local.'],
  ['intake', 's-stage', 'routing', 'Intake + trace', [1, 3.2], 'src/server.js', 'startIntake',
    'Mints the traceId (the root span of everything that follows) and starts the request timing that ends as one `request` record in the usage ledger.'],
  ['d-preroute', 's-decision', 'routing', 'Pre-routing on?', [2, 3.2], 'src/router.js', 'prerouteOn',
    'A per-request `preroute` wins over config.router.preroute (default on). Off: the request goes straight to the JARVIS thread, with no routed hint, and the brain decides and files work itself.'],
  ['direct', 's-stage', 'routing', 'Straight to the thread', [2, 2.2], 'src/chat.js', 'directTurn',
    'Pre-routing off: the trace keeps a router span marked `skipped`; the main JARVIS thread answers, files work itself (jarvis_task) or asks.'],
  ['router', 's-stage', 'routing', 'Router', [3, 3.2], 'src/router.js', 'export async function route',
    'Classifies the request before any brain sees it: tries the configured engine, then the fallback, then keyword rules. Sees the ongoing threads, the projects Sir named and the workspace catalog.'],
  ['eng-jev', 's-stage', 'routing', 'Engine 1 · Jev', [4, 2.2], 'src/router.js', 'jevRoute',
    'Default. A Jev-compatible /v1/systemone API (LocalJev, the App Cloud app `localjev`, or router.jev.url) asked with a predecided `route` choice, ~0.5 s. Accepted at jev.minProb (0.55). Unsure on a plain question → straight to the keyword rules.'],
  ['eng-claude', 's-stage', 'routing', 'Engine 2 · Claude Haiku', [4, 3.2], 'src/router.js', 'modelRoute',
    'Fallback when Jev is unreachable or gives no answer: one `claude -p` call on claude-haiku-5-5 returning a JSON decision, validated against the real threads and projects (parseDecision).'],
  ['eng-rules', 's-stage', 'routing', 'Engine 3 · Keyword rules', [4, 4.2], 'src/router.js', 'heuristicRoute',
    'No model. Shares ≥ 2 words with an ongoing thread → continue; plan words or > 600 chars → plan; imperative verb → implement; question → answer; code-change words → implement; else answer.'],
  ['guard', 's-stage', 'routing', 'Guard + bind work', [5, 3.2], 'src/router.js', 'withWork',
    'Deterministic second opinion. guardRoute: an imperative request is never `answer` (→ implement, or plan when it has several parts). A named workspace flow, or a request about JARVIS / RIGS itself, becomes implement. bindWork ties each part to a real folder on a machine; parts it cannot bind are left for the brain to ask about.'],
  ['d-route', 's-decision', 'routing', 'Which route?', [6, 3.2], 'src/router.js', 'export const ROUTES',
    'The decision: answer · implement · plan · continue — or yolo, which a YOLO marker (or jarvis/send `yolo: true`) decides before any engine is asked.'],
  ['r-answer', 's-route', 'routing', 'answer', [7, 2.2], 'src/router.js', "'answer'",
    'A question, a status check, a one-step action. Stays in the main JARVIS thread.'],
  ['r-continue', 's-route', 'routing', 'continue', [7, 3.2], 'src/router.js', "'continue'",
    'The request is about an ongoing thread (shared subject, or the model named its id): it goes back into that thread.'],
  ['r-implement', 's-route', 'routing', 'implement', [7, 4.2], 'src/router.js', "'implement'",
    'A bound piece of work in one folder: RIGS files it itself — one project, planned and cast without the brain.'],
  ['r-plan', 's-route', 'routing', 'plan', [7, 5.2], 'src/router.js', "'plan'",
    'A goal with several parts: filed like implement, but the planning step splits it into a task graph.'],
  ['r-yolo', 's-route', 'routing', 'yolo', [7, 6.2], 'src/router.js', "'yolo'",
    '"yolo a p5 sketch…", "… yolo it", "in yolo mode" or `yolo: true` (src/yolo.js isYoloRequest / resolveYolo). Wins over the engines, the guard, flows, tool work and self binding; `yolo: false` on the request beats the text. Never filed as work.'],
  ['yolo-run', 's-stage', 'routing', 'YOLO run · live window', [8, 6.2], 'src/chat.js', 'yoloTurn',
    'A sandbox RIGS_HOME/yolo/<runId>/ with a placeholder page and `yolo-start` before the model starts; one bounded `claude -p` turn (Sonnet, effort low, ≤ 20 turns, 180 s) writes the page there, every write is a debounced `yolo-update` that reloads the window, the page\'s runtime errors come back to the agent at …/errors. No project, task, worktree, review, commit or merge.'],
  ['d-quick', 's-decision', 'routing', 'Quick path?', [8, 2.2], 'src/quick.js', 'resolveQuick',
    'Only for `answer`. A per-request `quick` (true · false · haiku · sonnet) beats config.quick; without one, a request on a non-Claude brain is left alone.'],
  ['quick', 's-stage', 'routing', 'Quick turn · Haiku / Sonnet', [9, 2.2], 'src/quick.js', 'quickTier',
    'One bounded `claude -p` turn (≤ 8 turns, 90 s) with the persona, rigs MCP and web search, on a fresh session. Haiku for a short question, lookup, single tool call or summary; Sonnet for search, research, a report, a comparison or several steps. Hands back with [[ESCALATE]], on its turn limit, an error or the timeout.'],
  ['thread', 's-store', 'routing', 'Ongoing thread', [8, 3.2], 'src/chat.js', 'ongoingThreads',
    'A chat thread (last few days) that the router may continue; implement and plan open a new one for their work.'],
  ['brain', 's-agent', 'routing', 'JARVIS brain', [10, 3.2], 'src/chat.js', 'sendMessage',
    'The full turn: Claude Code, Codex, Ollama or Claude via Ollama, hot-swappable mid-conversation, with the persona, the mesh summary and the routing hint (what RIGS already filed). It reaches the mesh through the rigs MCP tools.'],
  ['file-work', 's-stage', 'routing', 'fileWork', [8, 4.2], 'src/server.js', 'fileWork',
    'RIGS files the bound work itself, in the background: one project per folder. A change to JARVIS gets its own dev worktree off main (merge.startWork) and is marked selfDev. Then planFlow / planProject → dispatchReady. The brain only tells Sir what was set in motion.'],

  // ── Projects → agents ───────────────────────────────────────────────────────────────────────────────────────────
  ['project', 's-store', 'work', 'Project record', [2, 7.4], 'src/planner.js', 'saveProject',
    'Goal, repo (node + path), tasks with deps / kind / size, assignment, status (draft → planning → planned → running → merging → done · blocked · paused) and an event log. Owned by one machine; tasks reference it through project_task_update.'],
  ['d-playbook', 's-decision', 'work', 'Playbook or flow?', [3, 7.4], 'src/planner.js', 'findPlaybook',
    'A RIGS change whose goal matches a docs/playbooks/*.md regex, or a request naming a workspace flow, skips LLM planning.'],
  ['plan', 's-stage', 'work', 'Plan · core brain', [4, 7.4], 'src/planner.js', 'planProject',
    'The core brain (Opus) gets the goal, the mesh snapshot, the project\'s agent guide (AGENTS.md) and the tool catalog, and returns tasks as JSON: kind (plan · architecture · code · test · review · merge · research · docs …), size, deps, acceptance, verify.'],
  ['playbook', 's-stage', 'work', 'Playbook / flow plan', [4, 8.6], 'src/planner.js', 'playbookTasks',
    'No planning call: one agent follows the saved method (or runs the workspace flow where it lives) and a review verifies it.'],
  ['final-review', 's-stage', 'work', 'Final review task', [5, 7.4], 'src/planner.js', 'ensureFinalReview',
    'Every plan ends in an independent review of the whole result: added if missing, depending on every task nothing else depends on.'],
  ['place', 's-stage', 'work', 'Place tasks', [6, 7.4], 'src/planner.js', 'routeProject',
    'Deterministic and explainable. Policy rule (config.routing.rules by kind × size) → provider / model / effort; then the best machine that has that provider signed in, meets platform / GPU needs, keeps code next to the repository, is idle and under maxTasksPerMachine. A review goes to the other agent than the author. A `private` task stays on local models.'],
  ['dispatch', 's-stage', 'work', 'Dispatch ready tasks', [7, 7.4], 'src/planner.js', 'dispatchReady',
    'A task whose deps are done becomes `starting` and work/start runs on its machine. Each brief carries the registry tools that fit it and the git guard. A machine that fails to start it is a dispatch failure: same model, after a pause, maybe elsewhere.'],
  ['intake-task', 's-stage', 'work', 'planner.intake', [7, 8.8], 'src/planner.js', 'export async function intake',
    'What jarvis_task does: one task filed under the main RIGS · JARVIS project (or a new one) and cast at once, without a planning call.'],
  ['d-openrig', 's-decision', 'work', 'OpenRig on that machine?', [8, 7.4], 'src/work.js', 'startTask',
    'Yes: the project\'s hub rig (hubs.js: lead seat + on-demand workers, a queue item per task) or its team. No: a direct agent session with the same brief.'],
  ['seat', 's-agent', 'work', 'OpenRig seat', [9, 6.4], 'src/hubs.js', 'hubRigName',
    'Persistent rig per pinned project: seat per role and model, tasks via `rig queue`, follow-ups via `rig send`, idle workers stopped after hubs.idleMinutes.'],
  ['direct-agent', 's-agent', 'work', 'Direct agent session', [9, 8.4], 'src/work.js', 'directLine',
    'Where OpenRig is unavailable: a Claude Code / Codex / Ollama session started with the task brief.'],
  ['agent-run', 's-agent', 'work', 'Agent works the task', [10, 7.4], 'src/autonomy.js', 'guardBrief',
    'Works in the project folder; for RIGS itself only in its dev worktree (the git guard allows commit, forbids push / checkout / switch). Finishes by calling project_task_update.'],

  // ── Completion loop ─────────────────────────────────────────────────────────────────────────────────────────────
  ['update', 's-stage', 'loop', 'Report arrives', [0, 10], 'src/planner.js', 'applyUpdate',
    'project_task_update(status, summary) lands in updateTask under the project lock; a late report on a paused project is recorded but nothing is retried or started.'],
  ['d-status', 's-decision', 'loop', 'Reported status?', [1, 10], 'src/planner.js', 'applyUpdate',
    'done · blocked · failed.'],
  ['self-answer', 's-stage', 'loop', 'Answer for Sir', [1, 11.3], 'src/planner.js', 'selfAnswer',
    'A `blocked` that is really a question is answered with the standing safe default (autonomy.selfAnswerText), logged on the task, and the task keeps running — up to autonomy.maxAnswers, then it counts as failed.'],
  ['d-retry', 's-decision', 'loop', 'Attempts left?', [2, 11.3], 'src/planner.js', 'retryOrFail',
    'Attempts per task are bounded (config.autonomy.maxAttempts). The failure goes into the next brief.'],
  ['ladder', 's-stage', 'loop', 'Next rung of the ladder', [3, 11.3], 'src/autonomy.js', 'DEFAULT_LADDER',
    'A fresh attempt one rung up: Sonnet medium → Opus high → Opus xhigh (a machine failure retries the same model after a pause; a `private` task never leaves local models).'],
  ['watchdog', 's-stage', 'loop', 'Watchdog tick', [0, 12.3], 'src/planner.js', 'watchTask',
    'tick() visits every running project: an idle agent is nudged (≤ MAX_NUDGES) and revived (≤ MAX_REVIVES), a task stuck in `starting` is adopted or restarted, a planning that died with the daemon is planned again, a dead-locked task is re-queued.'],
  ['settle', 's-decision', 'loop', 'All tasks done?', [3, 10], 'src/planner.js', 'settle',
    'Not yet: dispatch whatever is ready. Everything failed or blocked with nothing moving: the project is blocked.'],
  ['d-selfdev', 's-decision', 'loop', 'A change to RIGS itself?', [4, 10], 'src/planner.js', 'selfDev',
    'A project with a dev worktree proposes its branch to the merge steward (ctx.propose). Anything else is done. A branch with no commits has nothing to merge and is done too.'],
  ['done', 's-outcome', 'loop', 'Project done · one report', [5, 10], 'src/autonomy.js', 'completionReport',
    'Sir gets ONE report — what was done, retried, still open, "How did it work out, sir?" — and the same end state is never reported twice.'],
  ['blocked', 's-outcome', 'loop', 'Blocked · needs Sir', [5, 11.3], 'src/planner.js', 'completionNotify',
    'The attempt budget is spent or the hand-off cannot finish: the project stops and Sir is told exactly what is stuck.'],

  // ── Merge steward ───────────────────────────────────────────────────────────────────────────────────────────────
  ['propose', 's-stage', 'merge', 'Propose branch', [0, 14.4], 'src/merge.js', 'enqueue',
    '`rigs propose`: the steward (one machine with push rights) fetches the branch from the worker as a git bundle over the mesh — workers need no GitHub credentials.'],
  ['trial', 's-stage', 'merge', 'Trial merge on main', [1, 14.4], 'src/merge.js', 'mergeOne',
    'ONE request at a time, onto the latest origin/main in a scratch worktree. Serial merging is what keeps one worker from overwriting another.'],
  ['d-conflict', 's-decision', 'merge', 'Real conflict?', [2, 14.4], 'src/merge.js', 'conflicts',
    'Only a real conflict calls an agent.'],
  ['resolver', 's-agent', 'merge', 'Resolver agent', [2, 15.7], 'src/merge.js', 'ctx.resolve',
    'A task of routing kind `merge` (Opus) in the conflicted worktree with both sides\' intent; rigs_merge_resolved hands it back to the steward. A resolver that failed or stalled is replaced by re-queuing the request.'],
  ['policy', 's-stage', 'merge', 'Policy gate', [3, 14.4], 'src/merge.js', 'FORBIDDEN',
    'The merged tree must not track node_modules or ui/dist; they break every machine.'],
  ['checks', 's-stage', 'merge', 'Build + tests', [4, 14.4], 'src/merge.js', 'failChecks',
    'The CI gate on the merged tree: npm run build, then npm test.'],
  ['checks-failed', 's-stage', 'merge', 'Checks failed', [4, 15.7], 'src/merge.js', 'checks-failed',
    'Nothing merged; the log goes back to the author. The planner adds a fixN task ("fix the failing checks after merging onto main") and dispatches it.'],
  ['push', 's-stage', 'merge', 'Push main', [5, 14.4], 'src/merge.js', 'non-fast-forward',
    'If main moved meanwhile: fold the new main in and check again (a resolver only on a conflict).'],
  ['rollout', 's-stage', 'merge', 'Roll out', [6, 14.4], 'src/merge.js', 'rollout',
    'Every machine takes the commit through the self-updater (rollback of a crash-looping update).'],
  ['merged', 's-outcome', 'merge', 'Merged to main', [7, 14.4], 'src/planner.js', 'followMerge',
    'The planner follows the request; `merged` closes the project and sends the completion report.'],
];

// [from, to, kind, label?]
const L = [
  ['rest', 'mcp', 'tool', 'MCP tools call the REST API'],
  ['cli', 'rest', 'tool'],
  ['mcp', 'mcp-mesh', 'flow'], ['mcp', 'mcp-control', 'flow'], ['mcp', 'mcp-projects', 'flow'], ['mcp', 'mcp-change', 'flow'],
  ['mcp', 'mcp-tools', 'flow'], ['mcp', 'mcp-apps', 'flow'], ['mcp', 'mcp-observe', 'flow'], ['mcp', 'mcp-conn', 'flow'],
  ['mcp-tools', 'registry', 'tool', 'search · file · run'],
  ['mcp-apps', 'appcloud', 'tool', 'publish · start'],
  ['mcp-observe', 'traces', 'tool', 'read'],
  ['mcp-observe', 'usage', 'tool', 'read'],
  ['mcp-projects', 'intake-task', 'tool', 'jarvis_task'],
  ['mcp-projects', 'update', 'tool', 'project_task_update'],
  ['mcp-change', 'propose', 'tool', 'rigs_propose'],
  ['registry', 'dispatch', 'tool', 'matching tools go into every task brief'],
  ['registry', 'plan', 'tool', 'tool catalog goes into the planning prompt'],

  ['sir', 'intake', 'flow'], ['global', 'sir', 'tool', 'relays to the main brain'], ['intake', 'd-preroute', 'flow'], ['intake', 'traces', 'tool', 'root span'],
  ['d-preroute', 'router', 'branch', 'on (default)'],
  ['d-preroute', 'direct', 'branch', 'off'],
  ['direct', 'brain', 'flow', 'the brain decides and files work itself'],
  ['router', 'eng-jev', 'flow', 'engine'],
  ['eng-jev', 'eng-claude', 'loop', 'unreachable → fallback'],
  ['eng-jev', 'eng-rules', 'loop', 'unsure on a plain question'],
  ['eng-claude', 'eng-rules', 'loop', 'no answer'],
  ['eng-jev', 'guard', 'flow', 'typed decision'], ['eng-claude', 'guard', 'flow', 'JSON decision'], ['eng-rules', 'guard', 'flow', 'rule decision'],
  ['guard', 'd-route', 'flow'],
  ['d-route', 'r-answer', 'branch'], ['d-route', 'r-continue', 'branch'], ['d-route', 'r-implement', 'branch'], ['d-route', 'r-plan', 'branch'],
  ['d-route', 'r-yolo', 'branch', 'YOLO marker · yolo: true'], ['r-yolo', 'yolo-run', 'flow'],
  ['r-answer', 'd-quick', 'flow'],
  ['d-quick', 'quick', 'branch', 'fast path on'],
  ['d-quick', 'brain', 'branch', 'off / non-Claude brain'],
  ['quick', 'brain', 'loop', '[[ESCALATE]] · turn limit · error · timeout'],
  ['r-continue', 'thread', 'flow'], ['thread', 'brain', 'flow'],
  ['r-implement', 'file-work', 'flow'], ['r-plan', 'file-work', 'flow'],
  ['file-work', 'brain', 'tool', 'hint: what RIGS already filed'],
  ['file-work', 'project', 'flow', 'createProject'],
  ['brain', 'mcp', 'tool', 'rigs MCP tools'],

  ['project', 'd-playbook', 'flow'],
  ['d-playbook', 'plan', 'branch', 'no match'],
  ['d-playbook', 'playbook', 'branch', 'playbook / named flow'],
  ['plan', 'final-review', 'flow', 'ensureFinalReview'],
  ['playbook', 'place', 'flow'],
  ['final-review', 'place', 'flow'],
  ['place', 'dispatch', 'flow'],
  ['intake-task', 'dispatch', 'flow', 'only this task'],
  ['dispatch', 'd-openrig', 'flow', 'work/start'],
  ['d-openrig', 'seat', 'branch', 'yes'], ['d-openrig', 'direct-agent', 'branch', 'no'],
  ['seat', 'agent-run', 'flow'], ['direct-agent', 'agent-run', 'flow'],
  ['dispatch', 'traces', 'tool', 'dispatch span'],
  ['agent-run', 'update', 'flow', 'project_task_update'],

  ['update', 'd-status', 'flow'], ['update', 'usage', 'tool', 'task run recorded'],
  ['d-status', 'settle', 'branch', 'done'],
  ['d-status', 'self-answer', 'branch', 'blocked (a question)'],
  ['d-status', 'd-retry', 'branch', 'failed'],
  ['self-answer', 'agent-run', 'loop', 'task keeps running'],
  ['self-answer', 'd-retry', 'loop', 'too many answers'],
  ['d-retry', 'ladder', 'branch', 'yes'],
  ['d-retry', 'blocked', 'branch', 'no'],
  ['ladder', 'dispatch', 'loop', 'new attempt, failure in the brief'],
  ['watchdog', 'update', 'loop', 'stalled task recovered'],
  ['watchdog', 'dispatch', 'loop', 'starting task restarted'],
  ['settle', 'dispatch', 'loop', 'not yet — start what is ready'],
  ['settle', 'blocked', 'branch', 'stuck, nothing moving'],
  ['settle', 'd-selfdev', 'branch', 'all done'],
  ['d-selfdev', 'done', 'branch', 'no'],
  ['d-selfdev', 'propose', 'branch', 'yes — ctx.propose'],

  ['propose', 'trial', 'flow'], ['trial', 'd-conflict', 'flow'],
  ['d-conflict', 'policy', 'branch', 'clean'],
  ['d-conflict', 'resolver', 'branch', 'conflict'],
  ['resolver', 'policy', 'loop', 'resolved'],
  ['policy', 'checks', 'flow'],
  ['checks', 'push', 'branch', 'green'],
  ['checks', 'checks-failed', 'branch', 'red'],
  ['checks-failed', 'dispatch', 'loop', 'fixN task'],
  ['push', 'rollout', 'flow'], ['rollout', 'merged', 'flow'],
  ['merged', 'done', 'flow', 'project done'],
];

/** A fresh { nodes, links } for graph.js every call (3d-force-graph mutates what it is given). Nodes are pinned on the grid. */
export function buildStructure() {
  const nodes = N.map(([id, type, lane, name, [col, row], src, sym, desc, tools]) => ({
    id, type, lane, name, val: SIZE[type], src, sym, desc, ...(tools ? { tools: [...tools] } : {}),
    fx: col * COL, fy: -row * ROW, fz: 0,
  }));
  const links = L.map(([source, target, kind, label]) => ({ source, target, kind, arrow: true, ...(label ? { label } : {}) }));
  // Each lane gets a title to the left of its rows: what the overview shows while the component labels are still too small to read.
  for (const lane of LANES) {
    const rows = N.filter((n) => n[2] === lane.id).map((n) => n[4][1]);
    nodes.push({ id: `lane:${lane.id}`, type: 's-lane', name: lane.label.toUpperCase(), val: 1, fx: -1.45 * COL, fy: -((Math.min(...rows) + Math.max(...rows)) / 2) * ROW, fz: 0 });
  }
  return { nodes, links };
}

/** What is wired to a node, for the detail card: [{ id, name, kind, label, dir: 'in' | 'out' }]. */
export function connections(data, id) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const out = [];
  for (const l of data.links) {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    if (s === id && byId.has(t)) out.push({ id: t, name: byId.get(t).name, kind: l.kind, label: l.label || '', dir: 'out' });
    else if (t === id && byId.has(s)) out.push({ id: s, name: byId.get(s).name, kind: l.kind, label: l.label || '', dir: 'in' });
  }
  return out;
}

/** The components of the diagram (lane titles are labels, not components). */
export const isComponent = (n) => n.type !== 's-lane';

export const STRUCTURE_FACTS = { nodes: N.length, links: L.length, lanes: LANES.length };
