// JARVIS System Preferences — the one source of truth for every RIGS OS and JARVIS setting (inventory and API contract
// in docs/settings.md). Pure and import-free: the browser bundle (the preferences window), the server (GET/POST
// /api/local/settings) and node --test all read this same table. test/settings-model.test.js fails when config
// defaults(), a config key read in src/, or a UI pref gains a key that is neither mapped here nor in HIDDEN with a reason.
//
// An item: { id, label, help, control, group, scope, config?, writer?, pref?, action?, values?, choices?, min?, max?,
// step?, unit?, integer?, default?, readOnly?, secret?, restart?, reload?, env?, cli?, phone?, clear? }
//   id       config path for a config.json setting ('quick.local.enabled'), 'ui.<name>' for a UI pref, 'action.<name>'
//   control  one of CONTROLS; 'list' = several values (free strings, or a subset of `values`)
//   scope    one of SCOPES, derived: GLOBAL_PATHS → 'global', other config → 'machine', SYNCED_KEYS prefs → 'synced'
//   writer   the WRITERS entry that saves it (longest prefix of its config path), absent when readOnly
//   pref     { key, format: 'raw'|'json'|'flag', field?, on?, off?, invert?, dom?, via } — a localStorage pref
//   action   { api: 'POST shared/sync' (relative to the machine's API base; '/api/…' = absolute) | open: UI_SURFACES key,
//              confirm? }
//   choices  dynamic values filled by the window at render time (CHOICES); validation is then left to the setter
//   secret   the value never leaves the server: GET answers { set, len, source } (secretStatus), never the value
//   restart  takes effect after a daemon restart · reload: after a page reload · env: an environment variable that
//            overrides or supplies it · cli: the equivalent `rigs` command · phone: false = not on phones

export const SCHEMA_VERSION = 1;

export const CONTROLS = ['switch', 'select', 'slider', 'number', 'text', 'list', 'secret-status', 'action'];

export const SCOPES = {
  global: 'Mesh-global: one value for the whole mesh. A change stamps config.globalRev and every peer adopts the newest (src/globalbrain.js).',
  machine: 'This machine: its own ~/.rigs/config.json. Another machine is read and changed through /api/nodes/<id>/settings.',
  synced: 'Synced UI: kept by the daemon\'s ui-layout store and followed live by every JARVIS on the mesh (src/uilayout.js).',
  browser: 'This browser: localStorage of the JARVIS page.',
};

// Mirrors src/globalbrain.js GLOBAL_PATHS ([path, machine-bound keys left out]); the test keeps the two equal.
export const GLOBAL_PATHS = [
  ['brain.core', []], ['brain.chat', []], ['brain.home', []], ['brain.compact', []], ['router', ['jev.url', 'jev.apiKey']], ['routing', []], ['quick', []], ['yolo', []],
];
// Mirrors src/uilayout.js KEYS: localStorage keys the daemon syncs across the mesh.
export const SYNCED_KEYS = ['rigs.dock', 'rigs.appdock', 'rigs.docking', 'rigs.scaling', 'rigs.spaces'];

/**
 * Who saves a config subtree, longest prefix first. POST /api/local/settings must go through these so validation and
 * side effects stay exactly those of the existing endpoint. body = the item's path below `prefix` (`field` when the
 * path is the prefix itself); `whole` = the endpoint replaces the object, so the other fields come from the current value.
 */
export const WRITERS = {
  router: { prefix: 'router', endpoint: 'POST /api/local/router', setter: 'applyRouterPatch (src/router.js), then markGlobalChanged', read: 'routerSettings(config().router)' },
  quick: {
    prefix: 'quick', endpoint: 'POST /api/local/quick', setter: 'applyQuickPatch (src/quick.js)', read: 'quickSettings(config().quick), local: localSettings(config().quick.local)',
    note: 'local switched on without a node gets this machine as host; a local change warms the responder. Every quick change stamps globalRev (quick is in GLOBAL_PATHS).',
  },
  yolo: { prefix: 'yolo', endpoint: 'POST /api/local/yolo/config', setter: 'applyYoloPatch (src/yolo.js), then markGlobalChanged', read: 'yoloSettings(config().yolo)' },
  brainHome: { prefix: 'brain.home', field: 'node', endpoint: 'POST /api/local/brain/home', setter: 'server.js brain/home (machine checked against discovery), patchConfig', read: 'homeNode(config())' },
  brainChat: { prefix: 'brain.chat', whole: ['provider', 'model', 'effort'], endpoint: 'POST /api/local/brain/chat', setter: 'server.js brain/chat (claude-ollama remembers its model), patchConfig', read: 'config().brain.chat' },
  brainCore: { prefix: 'brain.core', whole: ['provider', 'model', 'effort', 'node'], endpoint: 'POST /api/local/brain/core', setter: 'server.js brain/core (node \'\' = this machine), patchConfig', read: 'config().brain.core' },
  compact: { prefix: 'brain.compact', endpoint: 'POST /api/local/compact', setter: 'applyCompactPatch (src/compact.js), then markGlobalChanged', read: 'compactSettings(config().brain.compact)' },
  exhibits: { prefix: 'exhibits', endpoint: 'POST /api/local/exhibits/config', setter: 'saveSettings (src/exhibits.js)', read: 'settings() (src/exhibits.js)' },
  starnet: { prefix: 'experimental.starnet', endpoint: 'POST /api/local/starnet/config', setter: 'saveSettings (src/starnet.js), emits config to open UIs', read: 'settings() (src/starnet.js)' },
  comfyui: { prefix: 'comfyui', endpoint: 'POST /api/local/comfyui/config', setter: 'saveSettings (src/comfyui.js)', read: 'loadSettings() (src/comfyui.js)' },
  linear: { prefix: 'linear', endpoint: 'POST /api/local/linear/config', setter: 'setConfig (src/linear.js)', read: 'loadSettings() (src/linear.js)' },
  googleDrive: { prefix: 'connectors.googleDrive', endpoint: 'POST /api/local/connectors/google-drive/config', setter: 'saveSettings (src/connectors/google-drive.js)', read: 'loadSettings() (src/connectors/google-drive.js)' },
  config: { prefix: '', endpoint: 'POST /api/local/config', setter: 'patchConfig (src/config.js): merge, stamps globalRev when it touches GLOBAL_PATHS', read: 'config()' },
};

/** Dynamic choices the window fills at render time. */
export const CHOICES = {
  machines: 'RIGS machines of the mesh snapshot, by name (an empty choice where the item allows it)',
  providers: 'provider ids of GET /api/local/models (claude, codex, ollama, claude-ollama; + auto for the core brain)',
  'models:<provider>': 'model ids of that provider (or of the provider chosen in the named item); free text allowed',
  'efforts:<provider>': 'effort levels of that provider (or of the provider chosen in the named item)',
  ollamaModels: 'models installed on the host\'s Ollama (the claude-ollama brain entry of the mesh snapshot)',
  voices: 'voice.voices(): system:<name> (server TTS) and browser:<name> (speechSynthesis)',
  themes: 'THEMES of ui/src/themes.js',
};

/** UI surfaces an `open` action names (they exist today; the window calls them rather than rebuilding them). */
export const UI_SURFACES = {
  'mesh.routing': 'Mesh control ⚙ › Routing tab (ui/src/mesh.js renderRouting): the routing rules editor',
  'mesh.tools': 'Mesh control ⚙ › Tools tab: machine tools (capabilities)',
  'mesh.connectors': 'Mesh control ⚙ › Connectors tab (ui/src/connectors-panel.js): Google Drive connect flow',
  'mesh.updates': 'Mesh control ⚙ › Updates tab: versions per machine, update every machine',
  'mesh.changes': 'Mesh control ⚙ › Changes tab: merge steward and queue',
  control: 'Access & control panel of a machine (ui/src/control.js openControl): the only place that switches screen control on',
  apps: 'the App Cloud apps list / ▦ launcher',
  appstore: 'the App Store window (ui/src/appstore.js)',
  hubs: 'the left panel\'s Top hubs (pinned projects; pin or unpin there)',
};

// ── item constructors ────────────────────────────────────────────────────────────────────────────────────────────────
const sw = (id, label, help, o = {}) => ({ id, label, help, control: 'switch', ...o });
const sel = (id, label, help, values, o = {}) => ({ id, label, help, control: 'select', ...(Array.isArray(values) ? { values } : { choices: values }), ...o });
const num = (id, label, help, min, max, o = {}) => ({ id, label, help, control: 'number', min, max, integer: true, ...o });
const slider = (id, label, help, min, max, o = {}) => ({ id, label, help, control: 'slider', min, max, ...o });
const text = (id, label, help, o = {}) => ({ id, label, help, control: 'text', ...o });
const list = (id, label, help, o = {}) => ({ id, label, help, control: 'list', ...o });
const secret = (id, label, help, o = {}) => ({ id, label, help, control: 'secret-status', ...o });
const action = (id, label, help, act, o = {}) => ({ id, label, help, control: 'action', action: act, ...o });
const opt = (value, label) => ({ value, label });
const pref = (key, o = {}) => ({ pref: { key, format: 'json', ...o } });
const withGroup = (group, items) => items.map((it) => ({ group, ...it }));

const CLAUDE_MODES = ['auto', 'acceptEdits', 'manual', 'dontAsk', 'bypassPermissions', 'plan'];
const CODEX_SANDBOXES = [opt('read-only', 'read-only'), opt('workspace-write', 'workspace-write (home)'), opt('danger-full-access', 'danger-full-access')];
const READ_ONLY_TOOLS = ['mesh_status', 'mesh_sessions', 'mesh_apps', 'project_list', 'mesh_processes', 'usage_report', 'trace_list', 'ui_open'];
const ALLOWED_TOOLS = ['mcp__rigs', 'mcp__rea', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebSearch', 'WebFetch'];
const brainTriple = (base, d, o = {}) => [
  sel(`${base}.provider`, 'Provider', 'Which harness runs it.', o.providers || 'providers', { default: d.provider }),
  text(`${base}.model`, 'Model', 'Exact model id; empty = the provider\'s default.', { choices: `models:${base}.provider`, default: d.model }),
  sel(`${base}.effort`, 'Effort', 'Reasoning effort; empty = default.', `efforts:${base}.provider`, { default: d.effort }),
];

// ── the categories, in System Preferences order ─────────────────────────────────────────────────────────────────────
const RAW = [
  ['general', 'General', '⚙️', 'Who JARVIS is and this machine\'s identity.', [
    ...withGroup('JARVIS', [
      text('persona.name', 'Assistant name', 'The name JARVIS answers to and shows in the Ask field.', { default: 'J.A.R.V.I.S.' }),
      text('persona.address', 'Calls you', 'How JARVIS addresses you ("sir").', { default: 'sir' }),
      slider('persona.humor', 'Humor', 'How dry and playful replies are.', 0, 100, { step: 5, unit: '%', default: 60 }),
      sw('persona.thinkingPhrases', 'Answer at once with a thinking phrase', 'Say a short pre-rendered line ("One moment, sir.") the moment a request is sent.', { default: true }),
      sw('persona.soul', 'Personality', 'JARVIS\'s character text in every brain prompt (chat, fast path, local responder). Off = a plain assistant.', { default: true }),
    ]),
    ...withGroup('This machine', [
      text('name', 'Machine name', 'This machine\'s name on the mesh. Change it with `rigs setup --name`.', { readOnly: true, env: 'RIGS_NAME', cli: 'rigs setup --name <name>' }),
      text('nodeId', 'Machine id', 'Stable id of this RIGS node.', { readOnly: true }),
      sw('keepAwake', 'Keep this machine awake', 'Hold a sleep inhibitor while RIGS runs so the machine stays on the mesh 24/7.', { default: true, restart: true, env: 'RIGS_NO_KEEPAWAKE' }),
    ]),
  ]],
  ['appearance', 'Appearance & Display', '🎨', 'Theme, the galaxy, windows and the dock.', [
    ...withGroup('Look', [
      sel('ui.theme', 'Theme', 'Colors of the whole UI, the galaxy and terminals.', 'themes', { default: 'jarvis', ...pref('rigs.theme', { format: 'raw', dom: '#d-theme', via: 'themes.js applyTheme(id)' }) }),
      sw('ui.face', 'JARVIS face', 'The 3D face beside the orb. Off by default on low-power devices.', { default: true, ...pref('rigs.face', { format: 'flag', via: 'main.js showFace(on)' }) }),
      sw('ui.menubarHidden', 'Hide the menu bar', 'Hide the top menu bar (⌘⇧M brings it back).', { default: false, phone: false, ...pref('rigs.menubar', { format: 'flag', on: 'hidden', off: 'shown', via: 'menubar.js setMenubarHidden(on)' }) }),
      sw('ui.clock12', '12-hour clock', 'The menu bar clock shows 12-hour time.', { default: false, ...pref('rigs.clock12', { format: 'flag', on: 'h12', off: 'h24', via: 'tray.js clock toggle (module state; needs an exported setter)' }) }),
      sel('ui.askPlacement', 'Ask field', 'Where the Ask JARVIS field lives.', [opt('topbar', 'In the menu bar'), opt('floating', 'Floating panel'), opt('docked', 'Docked panel'), opt('hidden', 'Hidden (⌘K shows it)')],
        { default: 'topbar', phone: false, ...pref('rigs.askPanel', { field: 'mode', via: 'ask-panel.js (Window › Ask JARVIS: topbar(), float(), hide())' }) }),
    ]),
    ...withGroup('Galaxy', [
      sw('ui.cloud', 'Show the galaxy', 'The 3D mesh galaxy behind everything. Hidden, it is not drawn at all (no GPU or memory used). Off by default on low-power devices.', { default: true, ...pref('rigs.cloud', { dom: '#d-cloud', via: 'main.js setCloud(on)' }) }),
      sw('ui.labels', 'Labels', 'Names next to machines, sessions and apps in the galaxy.', { default: true, ...pref('rigs.d-labels', { dom: '#d-labels', via: 'graph.setDisplay({ labels })' }) }),
      sw('ui.traffic', 'Traffic', 'Particles flowing along the links. Off by default on low-power devices.', { default: true, ...pref('rigs.d-particles', { dom: '#d-particles', via: 'graph.setDisplay({ particles })' }) }),
      sw('ui.orbit', 'Orbit', 'Slowly rotate the galaxy. Off by default on low-power devices.', { default: true, ...pref('rigs.d-rotate', { dom: '#d-rotate', via: 'graph.setDisplay({ rotate })' }) }),
      slider('ui.repel', 'Repel', 'How strongly nodes push each other apart.', 20, 400, { step: 1, default: 120, ...pref('rigs.repel', { dom: '#repel', via: 'graph.setForces({ repel })' }) }),
      slider('ui.linkLength', 'Link length', 'Rest length of the links between nodes.', 8, 80, { step: 1, default: 24, ...pref('rigs.linklen', { dom: '#linklen', via: 'graph.setForces({ linkLength })' }) }),
      sel('ui.exhibitAnim', 'Exhibit animations', 'off: never · auto: only the stage running now · always: every card while work runs (never while idle, hidden, on reduced motion or low power).', ['off', 'auto', 'always'],
        { default: 'auto', ...pref('rigs.exhibitAnim', { dom: '#d-exanim', via: 'exhibits.js setExhibitAnim(mode)' }) }),
    ]),
    ...withGroup('Windows', [
      sw('ui.docking', 'Docking layout', 'Drag a panel by its title bar onto another to dock it. Follows every machine.', { default: false, phone: false, ...pref('rigs.docking', { format: 'flag', via: 'docking.js setDocking(on)' }) }),
      sw('ui.scaling', 'Smart scaling', 'Keep every visible panel fully on screen as the browser window resizes.', { default: false, phone: false, ...pref('rigs.scaling', { format: 'flag', via: 'scaling.js setScaling(on)' }) }),
    ]),
    ...withGroup('Dock', [
      sel('ui.dock.position', 'Position on screen', 'Where the app dock sits (always the bottom on phones).', [opt('left', 'Left'), opt('bottom', 'Bottom'), opt('right', 'Right')], { default: 'bottom', ...pref('rigs.appdock', { field: 'settings.position', via: 'app-dock.js act(setSettings)' }) }),
      sw('ui.dock.autoHide', 'Automatically hide and show', 'The dock slides away until the pointer reaches its edge.', { default: false, ...pref('rigs.appdock', { field: 'settings.autoHide', via: 'app-dock.js act(setSettings)' }) }),
      sw('ui.dock.magnification', 'Magnification', 'Icons grow under the pointer (off on phones and with reduced motion).', { default: true, ...pref('rigs.appdock', { field: 'settings.magnification', via: 'app-dock.js act(setSettings)' }) }),
      sel('ui.dock.magnifyStrength', 'Magnification size', 'How much icons grow.', [opt(0.3, 'Small'), opt(0.6, 'Medium'), opt(1, 'Large')], { default: 0.6, ...pref('rigs.appdock', { field: 'settings.magnifyStrength', via: 'app-dock.js act(setSettings)' }) }),
      sw('ui.dock.autoDock', 'Dock new panels and windows', 'Newly opened panels and windows join the dock layout automatically.', { default: false, ...pref('rigs.appdock', { field: 'settings.autoDock', via: 'app-dock.js act(setSettings)' }) }),
      sw('ui.dock.autoTabTerminals', 'Tab auto-opened terminals together', 'Agent terminals that open by themselves share one tabbed group.', { default: false, ...pref('rigs.appdock', { field: 'settings.autoTabTerminals', via: 'app-dock.js act(setSettings)' }) }),
      sw('ui.dock.autoGroup', 'Group new apps and machines', 'New applets and machines land in their default dock groups.', { default: true, ...pref('rigs.appdock', { field: 'settings.autoGroup', via: 'app-dock.js act(setSettings)' }) }),
    ]),
  ]],
  ['notifications', 'Notifications', '🔔', 'Toasts, the attention banner and agent sessions that pop up.', [
    sw('ui.notifications', 'Notifications', 'Show toasts for mesh events and agent replies.', { default: true, ...pref('rigs.notifications', { format: 'flag', on: 'true', off: 'false', dom: '#d-notify', via: 'toasts.js prefs().notifications' }) }),
    sw('ui.attnBanner', '"Agent needs you" banner', 'A banner while an agent waits for an answer or a permission.', { default: true, ...pref('rigs.attnBanner', { format: 'flag', on: 'true', off: 'false', dom: '#d-attnbanner', via: 'toasts.js prefs().attnBanner' }) }),
    sw('ui.autoOpenSessions', 'Auto-open new agent sessions', 'Agent sessions started in the background pop up as terminals.', { default: true, ...pref('rigs.autoOpenSessions', { dom: '#d-autosess', via: 'main.js store (read on each new session)' }) }),
    sel('persona.speakAloud', 'Speak on this machine\'s speakers', 'auto = speak notifications aloud here when no JARVIS UI is open; never = stay silent.', ['auto', 'never'], { default: 'auto' }),
  ]],
  ['voice', 'JARVIS Voice & Hearing', '🎙', 'How JARVIS speaks and listens.', [
    ...withGroup('In this browser', [
      sw('ui.speak', 'Speak replies aloud', 'Voice output on or off (the 🔊 button).', { default: true, ...pref('rigs.muted', { format: 'flag', invert: true, via: 'voice.setMuted(muted)' }) }),
      sel('ui.voice', 'Voice', 'The voice this browser plays: the server\'s (system:…) or the browser\'s own (browser:…).', 'voices', { default: '', ...pref('rigs.voice', { format: 'raw', via: 'voice.setVoice(id)' }) }),
      sel('ui.stt', 'Hearing', 'auto = Web Speech where it works, else the mesh\'s Whisper; server / browser force one.', [opt('', 'Automatic'), opt('server', 'Mesh Whisper (server)'), opt('browser', 'Browser speech recognition')],
        { default: '', reload: true, ...pref('rigs.stt', { format: 'raw', via: 'voice.js preferServerHearing() at start' }) }),
    ]),
    ...withGroup('Speech on this machine', [
      sel('persona.tts.engine', 'Speech engine', 'auto = Kokoro (neural), then the resident piper voice, then this machine\'s own engine.', ['auto', 'neural', 'piper', 'local'], { default: 'auto' }),
      sw('persona.neural', 'Neural voice (Kokoro)', 'Use the jarvis-voice App Cloud app for JARVIS\'s voice and lip-sync.', { default: true }),
      text('persona.voiceApp', 'Neural voice app', 'App Cloud app that renders the neural voice: "id" or "node/id".', { default: 'jarvis-voice' }),
      text('persona.tts.piperUrl', 'Piper voice URL', 'The resident CPU piper voice (applets/piper-voice).', { default: 'http://127.0.0.1:8210' }),
      sw('persona.tts.trim', 'Trim silence', 'Cut leading and trailing silence from rendered speech.', { default: true }),
      text('persona.voice', 'System voice', 'macOS / Windows voice name, or a piper .onnx model path on Linux; empty = the engine default.', { default: '' }),
    ]),
    ...withGroup('Hearing and senses on this machine', [
      text('persona.hearingApp', 'Hearing app', 'App Cloud app whose Whisper transcribes recorded speech.', { default: 'jarvis-voice' }),
      text('persona.emotionApp', 'Emotion app', 'App Cloud app that picks the face\'s emotion for each reply.', { default: 'localjev' }),
    ]),
  ]],
  ['brain', 'Brain & Models', '🧠', 'Which model thinks, where, and how hard.', [
    ...withGroup('Main brain (whole mesh)', [
      sel('brain.home', 'Main-brain machine', 'Every JARVIS on the mesh talks to this machine\'s brain; empty = each machine answers itself.', 'machines', { default: '' }),
      ...brainTriple('brain.chat', { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' }),
    ]),
    ...withGroup('Core brain (project planning)', [
      ...brainTriple('brain.core', { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }),
      sel('brain.core.node', 'Planning machine', 'Where the core brain plans projects; empty = the machine that saved it.', 'machines', { default: '' }),
    ]),
    ...withGroup('Self-compaction (whole mesh)', [
      sw('brain.compact.enabled', 'Compact the JARVIS thread', 'When the main brain\'s context reaches the threshold, summarise the conversation and start a fresh session from the summary. Messages are never deleted.', { default: true, cli: 'rigs compact on|off' }),
      num('brain.compact.atTokens', 'Compact at', 'Context size (the last API call\'s input + cache tokens) that triggers a compaction.', 1000, 2000000, { unit: 'tokens', default: 100000, cli: 'rigs compact at <tokens>' }),
      num('brain.compact.keepMessages', 'Keep last messages', 'Conversation messages the fresh session gets verbatim after the summary.', 0, 200, { default: 12, cli: 'rigs compact keep <messages>' }),
      text('brain.compact.model', 'Summary model', 'Claude model that writes the summary.', { choices: 'models:claude', default: 'claude-sonnet-5-5' }),
    ]),
    ...withGroup('Local models on this machine', [
      text('brain.ollamaUrl', 'Ollama URL', 'This machine\'s Ollama server.', { default: 'http://127.0.0.1:11434', env: 'RIGS_OLLAMA_URL' }),
      sel('brain.claudeOllama.model', 'Claude via Ollama model', 'The local model the Claude Code harness runs; empty = pick a tool-capable one.', 'ollamaModels', { default: '' }),
      text('brain.claudeOllama.url', 'Claude via Ollama URL', 'Ollama endpoint for the Claude harness; empty = the Ollama URL above.', { default: '' }),
    ]),
    ...withGroup('Model catalog', [
      list('models.claude', 'Extra Claude models', 'Model ids added to the built-in Claude catalog.', { default: [] }),
      list('models.codex', 'Extra Codex models', 'Model ids added to the built-in Codex catalog.', { default: [] }),
    ]),
  ]],
  ['routing', 'Routing & Fast Path', '🧭', 'How a request is classified and how quick answers run.', [
    ...withGroup('Pre-routing', [
      sw('router.preroute', 'Pre-routing', 'Classify each request (answer · implement · plan · continue) before any brain sees it, and file work automatically. Off = the brain gets it as it is.', { default: true, cli: 'rigs preroute on|off' }),
      sel('router.engine', 'Engine', 'jev = LocalJev (about half a second) · claude = a small Claude model · rules = keywords only.', [opt('jev', 'LocalJev'), opt('claude', 'Claude (Haiku)'), opt('rules', 'Keyword rules')], { default: 'jev', cli: 'rigs preroute engine jev|claude|rules' }),
      sel('router.fallback', 'Fallback', 'Who decides when the engine is down, slow or unsure.', [opt('claude', 'Claude'), opt('rules', 'Keyword rules')], { default: 'claude' }),
      text('router.claudeModel', 'Claude router model', 'Model of the claude engine and fallback.', { choices: 'models:claude', default: 'claude-haiku-5-5' }),
      text('router.jev.url', 'LocalJev URL', 'This machine\'s Jev-compatible API; empty = the App Cloud app below.', { default: '' }),
      text('router.jev.appId', 'LocalJev app', 'App Cloud app id that serves the Jev API.', { default: 'localjev' }),
      text('router.jev.model', 'LocalJev model', 'Model the Jev API answers with.', { default: 'jev-latest' }),
      secret('router.jev.apiKey', 'LocalJev API key', 'Key for the Jev API on this machine.', { clear: '' }),
      num('router.jev.timeoutMs', 'LocalJev timeout', 'Give up on the engine after this long.', 500, 60000, { unit: 'ms', default: 8000 }),
      slider('router.jev.minProb', 'Minimum confidence', 'Below this probability the fallback decides.', 0, 1, { step: 0.05, default: 0.55 }),
      num('router.baselineMs.answer', 'Baseline: answers', 'Time-saved baseline for answers while no request has run with pre-routing off; 0 = estimated from history.', 0, 3600000, { unit: 'ms', default: 0 }),
      num('router.baselineMs.work', 'Baseline: work', 'Time-saved baseline for work requests; 0 = estimated from history.', 0, 3600000, { unit: 'ms', default: 0 }),
    ]),
    ...withGroup('Quick fast path', [
      sw('quick.enabled', 'Quick fast path', 'Answers, searches and short reports run as one bounded turn on a cheaper model instead of the full brain.', { default: true, cli: 'rigs quick on|off' }),
      sel('quick.simple.provider', 'Simple asks: provider', 'The fast path runs on the Claude Code harness.', ['claude'], { default: 'claude' }),
      text('quick.simple.model', 'Simple asks: model', 'Model for simple asks.', { choices: 'models:claude', default: 'claude-haiku-5-5' }),
      sel('quick.simple.effort', 'Simple asks: effort', 'Effort for simple asks.', 'efforts:claude', { default: 'low' }),
      sel('quick.standard.provider', 'Research and reports: provider', 'The fast path runs on the Claude Code harness.', ['claude'], { default: 'claude' }),
      text('quick.standard.model', 'Research and reports: model', 'Model for web research, multi-step tool use and reports.', { choices: 'models:claude', default: 'claude-sonnet-5-5' }),
      sel('quick.standard.effort', 'Research and reports: effort', 'Effort for research and reports.', 'efforts:claude', { default: 'medium' }),
      num('quick.maxTurns', 'Max tool turns', 'A quick answer gets at most this many tool turns before the full brain takes over.', 1, 50, { default: 8 }),
      num('quick.timeoutMs', 'Timeout', 'Hand the request to the full brain after this long.', 5000, 600000, { unit: 'ms', default: 90000 }),
    ]),
  ]],
  ['responder', 'Local Responder', '🗣', 'A model on a machine\'s own Ollama answers the fast path, with read-only tools.', [
    sw('quick.local.enabled', 'Local responder', 'Answer the fast path\'s tiers below on a local Ollama model. Switched on without a host, this machine hosts it.', { default: false, cli: 'rigs quick local on|off' }),
    sel('quick.local.node', 'Host machine', 'The machine whose Ollama runs the model; empty = the machine running the fast path.', 'machines', { default: '', cli: 'rigs quick local node <machine>' }),
    text('quick.local.model', 'Model', 'Ollama model the responder runs.', { choices: 'ollamaModels', default: 'qwen3:8b', cli: 'rigs quick local model <model>' }),
    list('quick.local.tiers', 'Answers these tiers', 'haiku = simple asks, sonnet = research and reports.', { values: ['haiku', 'sonnet'], default: ['haiku'] }),
    list('quick.local.tools', 'Tools', 'Read-only tools it may use (config can narrow this list, never widen it).', { values: READ_ONLY_TOOLS, default: READ_ONLY_TOOLS }),
    sw('quick.local.think', 'Thinking', 'Let the model think before answering (slower).', { default: false }),
    num('quick.local.numCtx', 'Context size', 'Context window in tokens.', 2048, 131072, { default: 16384 }),
    text('quick.local.keepAlive', 'Keep loaded', 'How long Ollama keeps the model in memory: 30m, 1h, -1 (forever).', { default: '30m', pattern: '^(?:-1|0|\\d+(?:\\.\\d+)?(?:ms|s|m|h)?)$' }),
    num('quick.local.maxRounds', 'Max tool rounds', 'Tool rounds per answer.', 1, 10, { default: 4 }),
    sw('quick.local.guard', 'Guard', 'Hand a reply to the full brain when it looks unsure or off-task.', { default: true }),
    num('quick.local.firstTokenMs', 'First-word deadline', 'Hand over when the first token takes longer than this.', 200, 60000, { unit: 'ms', default: 2500 }),
    num('quick.local.timeoutMs', 'Timeout', 'Hand over when the whole answer takes longer than this.', 2000, 600000, { unit: 'ms', default: 30000 }),
    action('action.responderWarm', 'Warm up now', 'Load the model on its host so the first reply is fast.', { api: 'POST responder/warm' }, { cli: 'rigs quick local warm' }),
  ]],
  ['yolo', 'YOLO', '🚀', '"yolo …" builds a page live in a sandbox window: no project, review, commit or merge.', [
    sw('yolo.enabled', 'YOLO mode', 'Requests marked yolo ("yolo a p5 sketch…") run as one bounded turn that builds a live page. Off = the marker is ignored.', { default: true, cli: 'rigs yolo on|off' }),
    sel('yolo.provider', 'Provider', 'YOLO runs on the Claude Code harness.', ['claude'], { default: 'claude' }),
    text('yolo.model', 'Model', 'Model that builds the page.', { choices: 'models:claude', default: 'claude-sonnet-5-5' }),
    sel('yolo.effort', 'Effort', 'Effort for a YOLO run.', 'efforts:claude', { default: 'low' }),
    num('yolo.maxTurns', 'Max turns', 'Agentic turns per run.', 1, 100, { default: 20 }),
    num('yolo.timeoutMs', 'Timeout', 'Stop a run after this long.', 10000, 1800000, { unit: 'ms', default: 180000 }),
    num('yolo.keep', 'Runs kept', 'Older runs are deleted past this many.', 1, 1000, { default: 50 }),
  ]],
  ['projects', 'Projects & Dispatch', '📋', 'How projects are planned, routed to machines and run.', [
    ...withGroup('Routing policy (whole mesh)', [
      action('routing.rules', 'Routing rules', 'Which provider, model and effort each task kind gets (first match wins). Edited in the routing rules editor.', { open: 'mesh.routing' }, { readOnly: true }),
      sel('routing.plannerPicks', 'Planner suggestions', 'What the planning brain may override.', [opt('machine', 'Machines only'), opt('all', 'Machines, provider and model'), opt('none', 'Ignore its suggestions')], { default: 'machine' }),
      sel('routing.dispatch', 'Default dispatch', 'How tasks are started on a machine.', [opt('auto', 'Auto (OpenRig when available)'), opt('openrig', 'OpenRig'), opt('direct', 'Direct agent sessions')], { default: 'auto' }),
      num('routing.maxTasksPerMachine', 'Tasks per machine', 'At most this many tasks run on one machine at a time.', 1, 32, { default: 4 }),
      list('routing.avoid', 'Providers switched off', 'The planner never suggests them and no task is placed there.', { values: ['claude', 'codex', 'ollama'], default: [] }),
    ]),
    ...withGroup('Pinned projects and hubs', [
      action('pinnedProjects', 'Pinned projects', 'Projects pinned to JARVIS\'s Top hubs on this machine. Pin or unpin them there.', { open: 'hubs' }, { readOnly: true }),
      sw('openrig.hubs.enabled', 'Project hubs', 'A persistent OpenRig rig per pinned project: a lead seat plus on-demand workers.', { default: true }),
      sw('openrig.hubs.jarvis', 'JARVIS rig', 'JARVIS\'s own rig with an overseer seat on the core-brain machine.', { default: true }),
      num('openrig.hubs.idleMinutes', 'Stop idle workers after', 'Idle hub workers are stopped after this long.', 1, 1440, { unit: 'min', default: 20 }),
      ...brainTriple('openrig.hubs.lead', { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }).map((it) => ({ ...it, label: `Lead seat: ${it.label.toLowerCase()}` })),
      ...brainTriple('openrig.hubs.overseer', { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }).map((it) => ({ ...it, label: `Overseer seat: ${it.label.toLowerCase()}` })),
    ]),
    ...withGroup('OpenRig', [
      sw('openrig.registerPeers', 'Register peers as OpenRig hosts', 'Every RIGS peer becomes an OpenRig host here, so seats can run anywhere.', { default: true }),
      sw('openrig.keepDaemon', 'Keep the OpenRig daemon running', 'Restart OpenRig\'s daemon when it is down, so seats and queues survive reboots.', { default: true }),
    ]),
    ...withGroup('Workspaces', [
      list('workspaces.roots', 'Extra project folders', 'Folders searched for projects besides your home (mesh_workspaces, routing a request to a folder).', { default: [] }),
    ]),
  ]],
  ['autonomy', 'Autonomy & Agents', '🤖', 'How unattended work retries, and the permissions agents run with.', [
    ...withGroup('Completion loop', [
      sw('autonomy.enabled', 'Completion loop', 'Retry a task that fails, stalls or goes silent with a fresh brief, one rung up the model ladder each time.', { default: true }),
      num('autonomy.maxAttempts', 'Attempts per task', 'A project can override it.', 1, 10, { default: 3 }),
      list('autonomy.ladder', 'Model ladder', 'Rungs tried in order; empty = Sonnet medium → Opus high → Opus xhigh. Edit in config.json.', { readOnly: true, default: [] }),
      num('autonomy.stallMinutes', 'Stalled after', 'No progress for this long counts as a stall.', 1, 1440, { unit: 'min', default: 60 }),
      num('autonomy.answerAfterSec', 'Answer agent questions after', 'An agent\'s question gets the safe default after this long.', 0, 3600, { unit: 's', default: 90 }),
      num('autonomy.maxSelfAnswers', 'Self-answers per attempt', 'At most this many questions are answered with the safe default per attempt.', 0, 20, { default: 3 }),
      num('autonomy.retryDelaySec', 'Retry delay', 'Wait this long before a retry.', 0, 3600, { unit: 's', default: 60 }),
    ]),
    ...withGroup('Agents RIGS starts on this machine', [
      sel('agents.claudePermissionMode', 'Claude permission mode', 'auto = work unattended; anything that still asks shows up as "needs you".', CLAUDE_MODES, { default: 'auto' }),
      sel('agents.codexSandbox', 'Codex sandbox', 'Codex\'s file access.', CODEX_SANDBOXES, { default: 'workspace-write' }),
      sel('agents.codexApproval', 'Codex approvals', 'When Codex asks before acting.', ['untrusted', 'on-failure', 'on-request', 'never'], { default: 'on-request' }),
      sw('agents.codexNetwork', 'Codex network access', 'Network inside Codex\'s workspace-write sandbox.', { default: true }),
      sel('agents.rigPolicy', 'OpenRig permission policy', 'Policy OpenRig seats launch with.', ['builtin:auto', 'builtin:standard', 'builtin:yolo'], { default: 'builtin:auto' }),
    ]),
    ...withGroup('JARVIS chat on this machine', [
      text('brain.workRoot', 'JARVIS works in', 'Working folder and writable root of JARVIS\'s own brains.', { default: '~' }),
      sel('brain.claudePermissionMode', 'Claude chat permission mode', 'Permission mode of JARVIS\'s Claude brain.', CLAUDE_MODES, { default: 'auto' }),
      list('brain.claudeAllowedTools', 'Claude chat tools', 'Tools JARVIS\'s Claude brain may use without asking.', { default: ALLOWED_TOOLS }),
      sel('brain.codexSandbox', 'Codex chat sandbox', 'Sandbox of JARVIS\'s Codex brain.', CODEX_SANDBOXES, { default: 'workspace-write' }),
    ]),
  ]],
  ['mesh', 'Mesh & Network', '🌐', 'How this machine finds and reaches its peers.', [
    ...withGroup('Peers', [
      list('peers', 'Extra peers', 'Peers to probe besides Tailscale devices, e.g. http://192.168.1.20:4719.', { default: [], env: 'RIGS_PEERS' }),
      num('port', 'Port', 'The RIGS API port. Every peer probes 4719.', 1, 65535, { readOnly: true, restart: true, default: 4719, env: 'RIGS_PORT' }),
      text('bind', 'Listen on', '"auto" = loopback and this machine\'s Tailscale addresses, or a list of addresses. Change it in config.json, and only on trusted networks.', { readOnly: true, restart: true, default: 'auto', env: 'RIGS_BIND' }),
      secret('meshToken', 'Mesh token', 'Shared secret for peers that are not on Tailscale (LAN, containers). Never leaves this machine.', { readOnly: true, env: 'RIGS_MESH_TOKEN' }),
    ]),
    ...withGroup('SSH', [
      sw('ssh.autoAuthorize', 'Authorize mesh peers', 'Add verified peers\' mesh SSH key to authorized_keys.', { default: true }),
      sw('ssh.manageConfig', 'Manage ~/.ssh/config', 'Write `ssh <machine>` aliases for every peer.', { default: true }),
      sw('ssh.authorizeStaticPeers', 'Authorize token peers', 'Also authorize peers that reach this machine by mesh token (not Tailscale).', { default: false }),
      action('action.sshSync', 'Sync SSH now', 'Re-write keys and aliases for the current peers.', { api: 'POST ssh/sync' }),
    ]),
  ]],
  ['files', 'Shared Folder & Files', '📁', 'The folder every machine keeps in sync, and the file browser.', [
    ...withGroup('Shared folder', [
      sw('shared.enabled', 'Shared folder', 'Keep a folder in sync with every online RIGS machine (apps/, files/, reports/).', { default: true, restart: true }),
      text('shared.path', 'Location', 'Empty = ~/RIGS-Shared.', { default: '', restart: true, cli: 'rigs shared path' }),
      num('shared.intervalSec', 'Sync every', 'Full reconcile interval (changes are also pushed at once).', 5, 86400, { unit: 's', default: 60, restart: true }),
      num('shared.maxFileMb', 'Largest file', 'Files above this size are not synced.', 1, 100000, { unit: 'MB', default: 256, restart: true }),
      list('shared.ignore', 'Ignore', 'Glob patterns left out of sync.', { default: [], restart: true }),
      action('action.sharedSync', 'Sync now', 'Pull from every online peer now.', { api: 'POST shared/sync' }, { cli: 'rigs shared sync' }),
    ]),
    ...withGroup('Files', [
      sw('files.showHidden', 'Show hidden files', 'The file browser lists dotfiles.', { default: false }),
      num('files.zip.maxBytes', 'Zip size limit', 'Largest total size going into or out of one archive.', 1024, 4294967296, { unit: 'bytes', default: 536870912 }),
      num('files.zip.maxEntries', 'Zip entry limit', 'Most files in one archive.', 1, 1000000, { default: 20000 }),
    ]),
  ]],
  ['screen', 'Screen Control & Desktop', '🖥', 'Screen access, input control and remote desktop.', [
    ...withGroup('Screen access and control', [
      sw('control.enabled', 'Screen access', 'Screenshots and window lists of this machine. Only Access & control switches it on (a confirmed human surface); the settings API never does.', { readOnly: true, default: true }),
      sw('control.input', 'Full control', 'Pointer, keys and focus. Switched in Access & control.', { readOnly: true, default: true }),
      text('control.backend', 'Backend', '"auto" or a forced one (mutter, portal, …).', { readOnly: true, default: 'auto' }),
      list('control.allowFrom', 'Allowed from', 'Machines allowed to control this one; empty = any machine of the mesh.', { readOnly: true, default: [] }),
      num('control.leaseIdleSec', 'Lease idle timeout', 'A controller loses the lease after this long idle.', 1, 3600, { unit: 's', readOnly: true, default: 60 }),
      num('control.maxActionsPerMin', 'Actions per minute', 'Rate limit on input actions.', 1, 10000, { readOnly: true, default: 120 }),
      num('control.maxShotsPerMin', 'Screenshots per minute', 'Rate limit on screenshots.', 1, 10000, { readOnly: true, default: 30 }),
      num('control.maxStreamFramesPerMin', 'Stream frames per minute', 'Rate limit on the live desktop stream.', 1, 100000, { readOnly: true, default: 600 }),
      text('control.announce', 'Announce', 'When control is announced on this machine.', { readOnly: true, default: 'lease' }),
      text('control.killHotkey', 'Kill hotkey', 'The stop hotkey (⌃⌥⌘⎋ on macOS by default).', { readOnly: true, default: 'default' }),
      num('control.auditPreview', 'Audit preview', 'Characters of typed text kept in the audit log.', 0, 1000, { readOnly: true, default: 64 }),
      action('action.openControl', 'Access & control…', 'Permissions, the access and full-control switches, the live "in control" banner.', { open: 'control' }),
      action('action.controlKill', 'Stop control on this machine', 'Kill switch: stop screen access and input now; it stays off until a person switches it on.', { api: 'POST control/kill', confirm: 'Stop screen control on this machine? It stays off until you switch it on in Access & control.' }, { cli: 'rigs control off' }),
    ]),
    ...withGroup('Remote desktop', [
      text('desktop.sunshineUser', 'Sunshine user', 'Login of this machine\'s Sunshine server (Moonlight pairing).', { readOnly: true, default: 'rigs' }),
      secret('desktop.sunshinePass', 'Sunshine password', 'Generated at setup; used for automatic pairing.', { readOnly: true }),
    ]),
  ]],
  ['connectors', 'Connectors', '🔌', 'Slack, Google Drive, Linear and ComfyUI on this machine.', [
    ...withGroup('Slack', [
      secret('connectors.slack.token', 'Bot token', 'Set connectors.slack.token in config.json or SLACK_BOT_TOKEN for the daemon.', { readOnly: true, env: 'SLACK_BOT_TOKEN', cli: 'rigs connectors slack status' }),
      secret('connectors.slack.userToken', 'User token (search)', 'search.messages needs a user token: connectors.slack.userToken or SLACK_USER_TOKEN.', { readOnly: true, env: 'SLACK_USER_TOKEN' }),
    ]),
    ...withGroup('Google Drive', [
      text('connectors.googleDrive.clientId', 'OAuth client id', 'Desktop OAuth client of your Google Cloud project.', { default: '' }),
      secret('connectors.googleDrive.clientSecret', 'OAuth client secret', 'Client secret of that OAuth client.', { clear: { clearSecret: true } }),
      text('connectors.googleDrive.redirectUri', 'Redirect URI', 'Empty = this daemon\'s loopback callback.', { default: '' }),
      num('connectors.googleDrive.maxBytes', 'Largest file read', 'Files above this size are not read.', 1, 10485760, { unit: 'bytes', default: 1048576 }),
      action('action.driveConnect', 'Connect Google Drive…', 'Sign in with Google (read-only access).', { open: 'mesh.connectors' }),
      action('action.driveDisconnect', 'Disconnect', 'Forget the Google tokens on this machine.', { api: 'POST connectors/google-drive/disconnect', confirm: 'Disconnect Google Drive on this machine?' }),
    ]),
    ...withGroup('Linear', [
      secret('linear.apiKey', 'API key', 'Linear personal API key (lin_api_…), or LINEAR_API_KEY for the daemon.', { env: 'LINEAR_API_KEY', clear: { clearKey: true }, cli: 'rigs linear key [--clear]' }),
      text('linear.url', 'API URL', 'Empty = Linear\'s own GraphQL endpoint.', { default: '' }),
      num('linear.timeoutMs', 'Timeout', 'Per request.', 1000, 120000, { unit: 'ms', default: 15000 }),
    ]),
    ...withGroup('ComfyUI', [
      text('comfyui.url', 'ComfyUI URL', 'Your ComfyUI, e.g. http://127.0.0.1:8188.', { default: '' }),
      secret('comfyui.authHeader', 'Auth header', '"Name: value", or a bare value for Authorization.', { clear: { clearAuth: true } }),
      text('comfyui.gpuOverseer', 'GPU overseer', 'auto, off, or the GPU Overseer\'s URL.', { default: 'auto' }),
      num('comfyui.gpuNeedMb', 'GPU memory needed', 'VRAM a job asks the overseer for.', 0, 512000, { unit: 'MB', default: 18000 }),
      num('comfyui.timeoutSec', 'Job timeout', 'A job that runs longer fails with a clear error.', 10, 7200, { unit: 's', default: 900 }),
    ]),
  ]],
  ['apps', 'Apps & App Store', '▦', 'Apps this machine shares with the mesh, and where installed apps live.', [
    action('apps', 'App Cloud apps', 'Web apps this machine shares with the mesh (mesh_app_register, POST /api/local/apps).', { open: 'apps' }, { readOnly: true }),
    action('capabilities', 'Machine tools', 'Tools this machine offers to the mesh (ComfyUI is detected); tasks that need a tool go only where it is.', { open: 'mesh.tools' }, { readOnly: true }),
    action('action.appStore', 'App Store…', 'Install apps from the catalog.', { open: 'appstore' }),
    text('appstore.appsDir', 'Installed apps folder', 'Empty = ~/.rigs/apps.', { default: '', env: 'RIGS_APPS_DIR' }),
    text('appstore.gpuOverseerClients', 'GPU Overseer clients file', 'clients.json that GPU apps join; empty = ~/apps/gpu-overseer/clients.json (skipped when absent).', { default: '', env: 'RIGS_GPU_OVERSEER_CLIENTS' }),
  ]],
  ['updates', 'Updates & Merge', '⟳', 'Self-updates from GitHub and the merge steward.', [
    ...withGroup('Software update', [
      sw('update.auto', 'Update automatically', 'Fast-forward this machine from GitHub and restart (skipped while it has local edits).', { default: true }),
      num('update.intervalMin', 'Check every', 'Minutes between update checks.', 2, 1440, { unit: 'min', default: 10, restart: true }),
      text('update.remote', 'Remote', 'Git remote the updater pulls from.', { readOnly: true, default: 'origin' }),
      text('update.branch', 'Branch', 'Branch the mesh runs. Every machine follows main.', { readOnly: true, default: 'main' }),
      action('action.updateNow', 'Update this machine', 'Pull the latest code and restart.', { api: 'POST update', confirm: 'Update this machine from GitHub and restart it?' }, { cli: 'rigs update' }),
      action('action.updateAll', 'Update every machine', 'Roll the latest code out to the whole mesh.', { api: 'POST /api/mesh/update', confirm: 'Pull the latest code from GitHub on every machine and restart them?' }, { cli: 'rigs update --all' }),
    ]),
    ...withGroup('Change policy', [
      sel('merge.steward', 'Merge steward', 'Machine that merges work branches onto main; empty = the first machine that can push.', 'machines', { default: '' }),
      action('action.mergeQueue', 'Merge queue…', 'Proposed branches and their state.', { open: 'mesh.changes' }, { cli: 'rigs merge' }),
    ]),
  ]],
  ['privacy', 'Privacy & Security', '🛡', 'Who may use this machine and what is recorded.', [
    ...withGroup('Access', [
      list('allowedUsers', 'Allowed Tailscale users', 'Logins that may use this machine besides its owner; empty = only the owner.', { default: [] }),
      sw('allowTaggedDevices', 'Allow tagged devices', 'Tailscale devices with tags (servers, containers) of the same tailnet may call this machine.', { default: true }),
    ]),
    ...withGroup('Request traces', [
      sw('traces.enabled', 'Record request traces', 'One span tree per request (traces/<day>.jsonl), secrets redacted.', { default: true }),
      num('traces.days', 'Keep traces for', 'Older day files are deleted.', 1, 3650, { unit: 'days', default: 14 }),
      num('traces.maxField', 'Field size cap', 'Characters kept per span input / output / meta before it is cut.', 200, 1000000, { unit: 'chars', default: 8000 }),
    ]),
  ]],
  ['experimental', 'Experimental', '🧪', 'Features that are still being tried out.', [
    ...withGroup('Exhibits', [
      sw('exhibits.enabled', 'Exhibits', 'Illustrated documents of each request and project, built from the traces.', { default: false }),
      sel('exhibits.images', 'Images', 'auto = SVG, plus ComfyUI pictures when this machine\'s ComfyUI answers.', ['auto', 'svg', 'comfyui', 'off'], { default: 'auto' }),
      num('exhibits.maxPerDoc', 'Entries per document', 'Most entries one document keeps.', 5, 500, { default: 60 }),
      num('exhibits.maxDocs', 'Documents kept', 'Past this many, the least recently written are deleted.', 10, 5000, { default: 200 }),
    ]),
    ...withGroup('StarNet space station', [
      sw('experimental.starnet.enabled', 'Space station view', 'StarNet\'s station in place of the galaxy on this machine\'s UI.', { default: false, cli: 'rigs starnet on|off' }),
      text('experimental.starnet.ref', 'StarNet commit', 'Empty = the pinned commit.', { readOnly: true, default: '', cli: 'rigs starnet install' }),
      text('experimental.starnet.dir', 'StarNet folder', 'Empty = ~/.rigs/starnet/<ref>.', { readOnly: true, default: '' }),
      action('action.starnetInstall', 'Install StarNet', 'Fetch the station renderer at the pinned commit.', { api: 'POST starnet/install' }, { cli: 'rigs starnet install' }),
    ]),
  ]],
];

/**
 * Settings and prefs left out of the window on purpose. { config: path } covers that path and everything below it;
 * { pref: key } one localStorage key; { prefPrefix } a family of keys.
 */
export const HIDDEN = [
  { config: 'globalRev', reason: 'Revision stamp of the mesh-global settings, written by RIGS (src/globalbrain.js), not a preference.' },
  { config: 'routing.rulesVersion', reason: 'Bookkeeping: lets non-customized machines pick up new default rules (RULES_VERSION).' },
  { config: 'routing.customized', reason: 'Set when the rules are saved and cleared by "Reset to defaults" in the routing rules editor.' },
  { config: 'agents.commitOtherProjects', reason: 'No longer read by any code (audit A1, docs/audits/self-optimize-projects.md): task agents never commit outside a RIGS dev worktree (src/autonomy.js guardBrief).' },
  { config: 'brain.compact.timeoutMs', reason: 'Time limit of the summarisation call (src/compact.js); not exposed by POST /api/local/compact or rigs compact.' },
  { config: 'persona.overseer', reason: 'Internal pointer to JARVIS\'s overseer session (default tmux jarvis-overseer), set by RIGS.' },
  { pref: 'rigs.dock', reason: 'The dock layout itself (arranged by dragging; reset in the Panels menu), not a preference.' },
  { pref: 'rigs.panels', reason: 'Legacy dock layout, migrated into rigs.dock.' },
  { pref: 'rigs.spaces', reason: 'The virtual desktops (Spaces) and which desktop each window is on, arranged from the menu bar desktop indicator, not a preference.' },
  { pref: 'rigs.spaces.active', reason: 'The desktop this browser was last on (Spaces, switched with Ctrl+arrows or the menu bar indicator), not a preference.' },
  { pref: 'rigs.sync', reason: 'Bookkeeping of the synced storage (revisions of rigs.dock and friends).' },
  { pref: 'rigs.removed', reason: 'Removed panels and apps with their undo history; restored from the Window menu.' },
  { pref: 'rigs.agents.dismissed', reason: 'Agent cards you dismissed: state, not a preference.' },
  { pref: 'rigs.askHistory', reason: 'History of what you asked: data, not a preference.' },
  { pref: 'rigs.chat', reason: 'The open conversation: state.' },
  { pref: 'rigs.chatTarget', reason: 'The session the conversation is sent to: state.' },
  { pref: 'rigs.brain', reason: 'This browser\'s cache of the main brain; the window shows the mesh-global brain.home and brain.chat instead.' },
  { pref: 'rigs.brainv', reason: 'One-time migration marker of rigs.brain.' },
  { pref: 'rigs.hidden', reason: 'Node types hidden in the Filters legend: a view filter toggled in the legend.' },
  { pref: 'rigs.graphify.view', reason: 'Which view the Graphify window shows: remembered window state.' },
  { pref: 'rigs.finder', reason: 'The file browser\'s view (icons, list, columns), sort and sidebar/preview widths, set in the window itself (finder-model.js): remembered window state.' },
  { pref: 'rigs.media', reason: 'The media player\'s volume, mute and speed, set with its own controls: remembered player state.' },
  { pref: 'rigs.usage.range', reason: 'Time range of the Tokens & time panel: remembered panel state.' },
  { prefPrefix: 'rigs.traces.', reason: 'Request traces panel and explorer view state (range, view, lane, size, even, limit).' },
  { prefPrefix: 'rigs.exhibits.', reason: 'Exhibit window view state (cards or document).' },
  { prefPrefix: 'rigs.desktop.pos.', reason: 'Where you dragged the desktop icons, per folder (desktop.js positionsKey): layout state, not a preference.' },
];

// ── derived ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const under = (p, base) => base === '' || p === base || p.startsWith(base + '.');
const isConfigId = (id) => !id.startsWith('ui.') && !id.startsWith('action.');

/** 'global' when the path is mesh-global (GLOBAL_PATHS minus its machine-bound keys), else 'machine'. */
export function configScope(p) {
  for (const [base, omit] of GLOBAL_PATHS) {
    if (!under(p, base)) continue;
    return omit.some((o) => under(p, `${base}.${o}`)) ? 'machine' : 'global';
  }
  return 'machine';
}

/** The WRITERS key that saves a config path: the longest matching prefix. */
export function writerFor(p) {
  let best = 'config';
  for (const [k, w] of Object.entries(WRITERS)) if (w.prefix && under(p, w.prefix) && w.prefix.length > WRITERS[best].prefix.length) best = k;
  return best;
}

function finish(it, category) {
  const out = { ...it, category };
  if (out.control === 'secret-status') out.secret = true;
  if (out.pref) {
    out.scope = SYNCED_KEYS.includes(out.pref.key) ? 'synced' : 'browser';
  } else if (isConfigId(out.id)) {
    out.config = out.id;
    out.scope = configScope(out.id);
    if (!out.readOnly) out.writer = writerFor(out.id);
  } else {
    out.scope = out.action?.open ? 'browser' : String(out.action?.api || '').includes(' /api/mesh/') ? 'global' : 'machine';
  }
  return Object.freeze(out);
}

/** [{ id, label, icon, help, items }] in System Preferences order. */
export const CATEGORIES = Object.freeze(RAW.map(([id, label, icon, help, items]) => Object.freeze({ id, label, icon, help, items: Object.freeze(items.map((it) => finish(it, id))) })));
/** Every item, flat, in window order. */
export const ITEMS = Object.freeze(CATEGORIES.flatMap((c) => c.items));
const BY_ID = new Map(ITEMS.map((it) => [it.id, it]));

export const itemById = (id) => BY_ID.get(id) || null;
export const categoryById = (id) => CATEGORIES.find((c) => c.id === id) || null;
/** Items the server reads and writes (they have a config path). */
export const serverItems = () => ITEMS.filter((it) => it.config);
/** Items that live in this browser or the synced UI store. */
export const prefItems = () => ITEMS.filter((it) => it.pref);
/** Can POST /api/local/settings change it? */
export const isWritable = (id) => !!itemById(id)?.writer;

// ── coverage (the test and reviews use these) ────────────────────────────────────────────────────────────────────────

/**
 * Is a config path in the window? 'item' = an item maps it or a parent of it, 'hidden' = HIDDEN lists it (or a parent),
 * 'parent' = it is a parent of mapped items (reading config().brain as a whole), null = missing.
 */
export function configCoverage(p) {
  if (ITEMS.some((it) => it.config && under(p, it.config))) return 'item';
  if (HIDDEN.some((h) => h.config && under(p, h.config))) return 'hidden';
  if (ITEMS.some((it) => it.config && it.config.startsWith(p + '.')) || HIDDEN.some((h) => h.config?.startsWith(p + '.'))) return 'parent';
  return null;
}

/** Is a localStorage key in the window? 'item' | 'hidden' | null. */
export function prefCoverage(key) {
  if (ITEMS.some((it) => it.pref?.key === key)) return 'item';
  if (HIDDEN.some((h) => h.pref === key || (h.prefPrefix && key.startsWith(h.prefPrefix)))) return 'hidden';
  return null;
}

// ── search ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Items matching every word of the query (label, help, group, category, id, CLI), label matches first. */
export function searchItems(query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const c of CATEGORIES) {
    for (const it of c.items) {
      const hay = fold([it.label, it.help, it.group, c.label, it.id, it.cli, it.pref?.key].filter(Boolean).join(' '));
      if (!words.every((w) => hay.includes(w))) continue;
      hits.push({ item: it, category: c, rank: words.every((w) => fold(it.label).includes(w)) ? 0 : 1 });
    }
  }
  return hits.sort((a, b) => a.rank - b.rank).map(({ item, category }) => ({ item, category }));
}

// ── values ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getPath = (o, p) => (p ? p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o) : o);
export function setPath(o, p, v) {
  const ks = p.split('.');
  let a = o;
  for (const k of ks.slice(0, -1)) { if (a[k] == null || typeof a[k] !== 'object' || Array.isArray(a[k])) a[k] = {}; a = a[k]; }
  a[ks.at(-1)] = v;
  return o;
}

const valueList = (it) => (it.values || []).map((v) => (v && typeof v === 'object' ? v.value : v));
/** The masked value a secret field may send back unchanged; it means "keep the stored secret". */
export const SECRET_MASK = '••••';

/** A value for an item, checked against the schema (type, choices, range). { ok, value } or { ok: false, error }. */
export function validateValue(it, v) {
  const fail = (error) => ({ ok: false, error });
  if (!it) return fail('unknown setting');
  if (it.control === 'action') return fail('an action, not a setting');
  if (it.readOnly) return fail('read-only here');
  switch (it.control) {
    case 'switch': return typeof v === 'boolean' ? { ok: true, value: v } : fail('must be true or false');
    case 'select': {
      if (it.values) return valueList(it).some((x) => x === v) ? { ok: true, value: v } : fail(`must be one of ${valueList(it).map((x) => JSON.stringify(x)).join(', ')}`);
      return typeof v === 'string' ? { ok: true, value: v.trim() } : fail('must be a string');
    }
    case 'slider':
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return fail('must be a number');
      if (it.integer && !Number.isInteger(n)) return fail('must be a whole number');
      if ((it.min != null && n < it.min) || (it.max != null && n > it.max)) return fail(`must be between ${it.min} and ${it.max}`);
      return { ok: true, value: n };
    }
    case 'text': {
      if (typeof v !== 'string') return fail('must be a string');
      if (v.length > 2000 || /[\0-\x08\x0a-\x1f\x7f]/.test(v)) return fail('must be one line of at most 2000 characters');
      if (it.pattern && v.trim() && !new RegExp(it.pattern).test(v.trim())) return fail('has the wrong format');
      return { ok: true, value: v.trim() };
    }
    case 'list': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return fail('must be a list of strings');
      const clean = [...new Set(v.map((x) => x.trim()).filter(Boolean))];
      if (it.values) { const ok = valueList(it); const bad = clean.find((x) => !ok.includes(x)); if (bad !== undefined) return fail(`only ${ok.join(', ')} are allowed`); }
      return { ok: true, value: clean };
    }
    case 'secret-status': {
      if (v === null || v === '') return { ok: true, value: null }; // clear
      if (v === SECRET_MASK) return { ok: true, value: SECRET_MASK }; // keep
      return typeof v === 'string' && v.length <= 4096 ? { ok: true, value: v } : fail('must be a string'); // never echo it
    }
    default: return fail(`unknown control ${it.control}`);
  }
}

/**
 * A settings patch { [id]: value } → the writes that apply it: { writes: [{ writer, endpoint, body, ids }], errors }.
 * Nothing should be written unless errors is empty. current(path) reads the current config for whole-object writers.
 * Browser prefs, actions, read-only items and unknown ids are errors; a secret sent back as SECRET_MASK is skipped.
 */
export function planPatch(patch, { current = () => undefined } = {}) {
  const errors = [];
  const byWriter = new Map();
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { writes: [], errors: [{ id: '', error: 'expected { values: { <setting id>: value } }' }] };
  for (const [id, raw] of Object.entries(patch)) {
    const it = itemById(id);
    if (!it) { errors.push({ id, error: 'unknown setting' }); continue; }
    if (it.pref) { errors.push({ id, error: 'a browser preference: it is saved in the browser, not on the server' }); continue; }
    const r = validateValue(it, raw);
    if (!r.ok) { errors.push({ id, error: r.error }); continue; }
    if (r.value === SECRET_MASK) continue;
    const w = WRITERS[it.writer];
    if (!byWriter.has(it.writer)) byWriter.set(it.writer, { writer: it.writer, endpoint: w.endpoint, body: {}, ids: [] });
    const out = byWriter.get(it.writer);
    const rel = it.config === w.prefix ? w.field : it.config.slice(w.prefix ? w.prefix.length + 1 : 0);
    if (it.secret && r.value === null) {
      if (it.clear && typeof it.clear === 'object') Object.assign(out.body, it.clear);
      else setPath(out.body, rel, '');
    } else setPath(out.body, rel, r.value);
    out.ids.push(id);
  }
  const writes = [];
  for (const k of Object.keys(WRITERS)) {
    const out = byWriter.get(k);
    if (!out) continue;
    for (const f of WRITERS[k].whole || []) if (out.body[f] === undefined) out.body[f] = current(`${WRITERS[k].prefix}.${f}`) ?? '';
    writes.push(out);
  }
  return { writes, errors };
}

/** What a secret looks like outside the server: never the value. source: 'config' | 'env' | null. */
export function secretStatus(value, source = 'config') {
  const s = typeof value === 'string' ? value : '';
  return s ? { set: true, len: s.length, source } : { set: false, len: 0, source: null };
}
export const formatSecret = (st) => (st?.set ? `set${st.len ? ` · len=${st.len}` : ''}${st.source === 'env' ? ' (environment)' : ''}` : 'not set');

/** GET /api/local/settings → { [id]: { value | secret, scope, readOnly, … } }. */
export function valuesById(res) {
  const out = {};
  for (const c of res?.categories || []) for (const e of c.items || []) out[e.id] = e;
  return out;
}

// ── UI prefs: the stored string ⇄ the item's value, as the existing code reads and writes it ────────────────────────

/** The item's value from the raw localStorage string (null = not stored → the item's default). */
export function decodePref(it, raw) {
  const p = it?.pref;
  if (!p) return undefined;
  let v;
  if (raw == null) v = undefined;
  else if (p.format === 'raw') v = raw;
  else if (p.format === 'flag') v = raw === (p.on ?? '1') ? true : raw === (p.off ?? '0') ? false : undefined;
  else { try { v = getPath(JSON.parse(raw), p.field); } catch { v = undefined; } }
  if (v === undefined) return it.default;
  return p.invert ? !v : v;
}

/** The raw string to store for a value (prev = the stored string, kept around a JSON field). */
export function encodePref(it, value, prev = null) {
  const p = it.pref;
  const v = p.invert ? !value : value;
  if (p.format === 'raw') return String(v ?? '');
  if (p.format === 'flag') return v ? (p.on ?? '1') : (p.off ?? '0');
  if (!p.field) return JSON.stringify(v);
  let o = {};
  try { const x = JSON.parse(prev); if (x && typeof x === 'object' && !Array.isArray(x)) o = x; } catch { /* nothing stored yet */ }
  return JSON.stringify(setPath(o, p.field, v));
}
