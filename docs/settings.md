# Settings — JARVIS System Preferences

Every setting RIGS OS and JARVIS have, in one place. The source of truth is **`ui/src/settings-model.js`**: a pure,
import-free module the preferences window (browser bundle), the settings API (`GET/POST /api/local/settings`) and the
tests all read. The inventory at the end of this page is generated from it (`node scripts/settings-doc.js`), and
`test/settings-model.test.js` fails when a setting exists that the schema neither maps nor hides with a reason.

## What was swept

| Source | What it holds |
| --- | --- |
| `src/config.js` `defaults()` | every key of `~/.rigs/config.json`, down to the leaves |
| Keys read in `src/` that `defaults()` does not declare | `brain.home`, `brain.core.node`, `quick.local.*` (`src/quick.js` `localSettings`), `persona.soul`, `persona.neural`, `persona.voiceApp`, `persona.hearingApp`, `persona.emotionApp`, `persona.tts.{engine,piperUrl,trim}`, `persona.overseer`, `files.zip.{maxBytes,maxEntries}`, `openrig.keepDaemon`, `workspaces.roots`, `comfyui.*`, `linear.*`, `connectors.slack.{token,userToken}`, `connectors.googleDrive.*`, `globalRev` |
| Per-feature endpoints | `config`, `brain/core`, `brain/chat`, `brain/home`, `global`, `router`, `quick`, `yolo/config`, `routing`, `exhibits/config`, `starnet/config`, `comfyui/config`, `linear/config`, `connectors/google-drive/config`, `connectors/slack/status`, `control/*`, `shared/*`, `ssh/sync`, `update`, `capabilities`, `pins`, `apps` |
| `rigs` CLI toggles (`bin/rigs.js`) | `preroute on\|off\|engine`, `quick on\|off`, `quick local on\|off\|model\|node\|warm`, `yolo on\|off`, `starnet on\|off\|install`, `linear key [--clear]`, `control off`, `shared sync\|path`, `update [--all]`, `setup --name` |
| Mesh-global stamping | `src/globalbrain.js` `GLOBAL_PATHS`, `patchConfig` (`touchesGlobal`), `markGlobalChanged`, `adoptGlobal` |
| UI prefs | left panel Display / Forces (`ui/index.html` `#d-*`, `#repel`, `#linklen`), every `rigs.*` localStorage key in `ui/src`, the synced keys of `src/uilayout.js`, the app dock's settings menu, the menu bar's checkable commands (docking, smart scaling, menu bar, Ask field), the brain badge / brain popover / tray JARVIS item, the local-responder and Connectors panels, Mesh control's JARVIS / Routing / Tools / Updates tabs |

## Categories

In System Preferences order: **General · Appearance & Display · Notifications · JARVIS Voice & Hearing · Brain &
Models · Routing & Fast Path · Local Responder · YOLO · Projects & Dispatch · Autonomy & Agents · Mesh & Network ·
Shared Folder & Files · Screen Control & Desktop · Connectors · Apps & App Store · Updates & Merge · Privacy & Security ·
Experimental.** Inside a category, items carry a `group` (a rounded box of rows in the window).

## The item model

| Field | Meaning |
| --- | --- |
| `id` | the config path for a config.json setting (`quick.local.enabled`), `ui.<name>` for a UI pref, `action.<name>` for an action |
| `label`, `help` | what the window shows |
| `control` | `switch` · `select` · `slider` · `number` · `text` · `list` (several values; a subset of `values` when it has them) · `secret-status` · `action` |
| `values` / `choices` | static choices (`[value]` or `[{ value, label }]`) / a dynamic source the window fills (`CHOICES`: `machines`, `providers`, `models:<provider or provider item>`, `efforts:<…>`, `ollamaModels`, `voices`, `themes`) |
| `min`, `max`, `step`, `unit`, `integer`, `pattern` | ranges and formats `validateValue` enforces |
| `default` | the default as the code applies it (the test checks it against `defaults()`) |
| `scope` | `global` · `machine` · `synced` · `browser` — derived, see below |
| `config` | where it lives in config.json (config items) |
| `writer` | which existing setter saves it (`WRITERS`, by longest prefix); absent = read-only here |
| `pref` | `{ key, format: raw\|json\|flag, field?, on?, off?, invert?, dom?, via }` for a localStorage pref |
| `action` | `{ api: 'POST shared/sync' }` (relative to the machine's API base; `/api/…` is absolute) or `{ open: <UI surface> }`, plus `confirm?` |
| `readOnly`, `secret`, `restart`, `reload`, `env`, `cli`, `phone: false` | shown, not changeable here · value never leaves the server · applies after a daemon restart · after a page reload · environment variable that overrides or supplies it · equivalent `rigs` command · not on phones |

Helpers (all pure, unit-tested): `itemById`, `categoryById`, `serverItems`, `prefItems`, `isWritable`, `searchItems`,
`validateValue`, `planPatch`, `secretStatus`, `formatSecret`, `valuesById`, `decodePref`, `encodePref`, `getPath`,
`setPath`, `configScope`, `writerFor`, `configCoverage`, `prefCoverage`.

## Scopes and mesh-global settings

- **global** — one value for the whole mesh: the config paths under `GLOBAL_PATHS` (`brain.core`, `brain.chat`,
  `brain.home`, `brain.compact`, `router` minus `jev.url` / `jev.apiKey`, `routing`, `quick`, `yolo`). A change stamps
  `config.globalRev = { rev, by }` (`nextRev`), the server pushes `{ rev, by, settings }` to every peer, and a peer adopts
  it when it is newer (`adoptGlobal`; equal revisions break ties by machine name). The schema mirrors `GLOBAL_PATHS` and
  the test keeps them equal.
- **machine** — this machine's own config.json (everything else). Another machine is reached through
  `/api/nodes/<id>/settings`.
- **synced** — UI prefs in the daemon's ui-layout store (`rigs.docking`, `rigs.scaling`, `rigs.appdock`; `src/uilayout.js`
  `KEYS`), followed live by every JARVIS on the mesh through `synced-storage.js`.
- **browser** — localStorage of the JARVIS page in this browser.

## Secrets

Secret items: `meshToken`, `desktop.sunshinePass`, `router.jev.apiKey`, `connectors.slack.token`,
`connectors.slack.userToken`, `connectors.googleDrive.clientSecret`, `linear.apiKey`, `comfyui.authHeader`.

- **Never** returned, logged or echoed in an error. GET answers `{ "set": true, "len": 32, "source": "config" | "env" }`
  (`secretStatus`); the window shows `set · len=32` (`formatSecret`). `source: "env"` when only the environment variable
  (`env`) supplies it.
- POST: a string sets it; `null` or `""` clears it (the item's `clear` — `{ clearKey: true }`, `{ clearAuth: true }`,
  `{ clearSecret: true }` — or an empty value); the mask `"••••"` keeps it unchanged.
- Read-only secrets (`meshToken`, `desktop.sunshinePass`, the Slack tokens) have no write path here: the mesh token and
  Sunshine password are identity, the Slack tokens are set in config.json or the daemon's environment.

## API contract: `/api/local/settings`

Implemented in `src/settings-api.js` (routes in `src/server.js`, tests in `test/settings-api.test.js`). Authentication is that of every `/api/local/*` route (`src/auth.js`: loopback, same-owner tailnet
devices, the mesh token). `/api/nodes/<id>/settings` reaches another machine through the existing peer proxy
(`src/proxy.js`, `/api/nodes/<id>/*` → peer `/api/local/*`).

### GET

Every server-side item (`serverItems()`: the items with a `config` path), grouped by category, with its current value:

```json
{
  "node": "macbookpro",
  "schemaVersion": 1,
  "global": { "rev": 1792535182538, "by": "macbookpro", "home": "macbookpro" },
  "categories": [
    { "id": "routing", "items": [
      { "id": "router.preroute", "value": true, "scope": "global", "readOnly": false },
      { "id": "router.jev.apiKey", "secret": { "set": true, "len": 32, "source": "config" }, "scope": "machine", "readOnly": false },
      { "id": "quick.enabled", "value": true, "scope": "global", "readOnly": false }
    ] },
    { "id": "mesh", "items": [
      { "id": "peers", "value": ["http://192.168.1.20:4719"], "scope": "machine", "readOnly": false, "env": "RIGS_PEERS", "overridden": true }
    ] }
  ]
}
```

- `value` is the **effective** value: read through the writer's normaliser (`WRITERS[w].read`: `routerSettings`,
  `quickSettings` + `localSettings`, `yoloSettings`, exhibits / starnet `settings()`, the connectors' `loadSettings`), and
  the item's `default` when nothing is stored (e.g. `quick.local.*` before the responder was ever configured).
- A secret item has `secret` instead of `value`, never both.
- `env` + `overridden: true` when that environment variable is set for the daemon (the stored value is then not what
  runs).
- `global` is `currentGlobal()` plus `homeNode()`. Browser prefs and action-only items are not in the response: the window
  has them from the schema.
- `valuesById(res)` flattens the response into `{ [id]: entry }` for the window.

### POST

```json
{ "values": { "quick.enabled": false, "router.engine": "rules", "linear.apiKey": null } }
```

1. **Plan.** `planPatch(values, { current })` (`current(path)` reads the current config) checks every id against the
   schema — unknown id, browser pref, action, read-only item, wrong type, value outside `values`, number outside
   `min`–`max`, malformed `pattern` — and groups the accepted values per writer into the body that writer's endpoint
   takes. Any error → **400** `{ "error": "<first message>", "errors": [{ "id", "error" }] }` and **nothing is written**.
   Error messages never contain a secret's value.
2. **Whitelist.** Exactly the items with a `writer` (`isWritable(id)`). The `config` writer never receives a key in
   `PATCH_BLOCKED` (`src/config.js`: `nodeId`, `meshToken`, `desktop`, `comfyui`, `linear`, `connectors`, `control`;
   the test checks the schema never routes one there).
3. **Apply.** Each write goes through the same code as the endpoint it mirrors (see the Writers table), in `WRITERS`
   order, so validation and side effects stay exactly as today: `applyQuickPatch` (a local responder switched on without a
   host gets this machine; switching it on warms the model), `applyRouterPatch`, `applyYoloPatch`, the brain endpoints
   (`whole` writers get the fields not in the patch from the current value; `brain/home` checks the machine against
   discovery; `claude-ollama` remembers its model), `exhibits.saveSettings`, `starnet.saveSettings` (open UIs switch at
   once), the connectors' `saveSettings` / `setConfig`, and `patchConfig` for everything else. A setter's own validation
   error → 400 with its message; the writes before it stay applied and the answer lists them in `applied`.
4. **Stamp.** A write that touched a mesh-global path is stamped and pushed once (`markGlobalChanged` /
   `patchConfig`), exactly as the old endpoint does. Every change under `quick` is stamped, here and in
   `POST /api/local/quick` (so `rigs quick on|off` and the tray's fast-path toggle reach the peers too).
5. **Answer.** The fresh GET payload plus `"applied": ["quick.enabled", …]` (and `"restart": [ids]` for items with
   `restart: true`, so the window can say so). Log the ids that changed, never the values of secret items.

Never through this API: screen control (`control.*` — only the Access & control panel, a confirmed human surface,
switches it on; `src/control.js`), browser prefs, actions (the window calls their own endpoints), and identity
(`name`, `nodeId`, `port`, `bind`, `meshToken`).

CLI: `rigs settings [get [id] | set <id> <value>] [--node <machine>] [--json]` over the same two calls. A secret is never an argument: `rigs settings set <id>` asks for it (or reads stdin), `--clear` removes it.

The error answer also carries `errors` (and `applied` when a setter refused after earlier writes).

## UI prefs (browser and synced)

Read and written in the browser, never through the API. `decodePref(item, raw)` / `encodePref(item, value, prev)`
convert between the stored string and the item's value exactly as the existing code does (raw strings, JSON, `1`/`0`
flags, `true`/`false`, `h12`/`h24`, `hidden`/`shown`, inverted `rigs.muted`, a field inside the `rigs.askPanel` and
`rigs.appdock` JSON). Writing storage alone is not enough for most of them: the window must call the function in
`pref.via` (e.g. `applyTheme`, `setCloud`, `setScaling`, `voice.setMuted`, the app dock's `act(setSettings)`) so the
change shows at once and synced keys reach the other machines, and keep the left panel's control (`pref.dom`) in step.
`phone: false` items are not offered on phones (docking, smart scaling, the menu bar, the Ask field's place). `reload`
items take effect on the next page load.

## Actions

`action.api` is a request on the selected machine's API base (`/api/local/` or `/api/nodes/<id>/`), or an absolute
`/api/mesh/…` path; `confirm` is the question to ask first. `action.open` names an existing UI surface (`UI_SURFACES`:
the routing rules editor, the Tools and Connectors tabs, Access & control, the App Store, the apps list, Top hubs).
Lists of objects managed by their own UIs — `routing.rules`, `pinnedProjects`, `apps`, `capabilities` — are action items
with a `config` path: GET reports their value, the action opens their editor.

## Found during the audit

- **Quick fast path not stamped mesh-global** by `POST /api/local/quick` unless the patch had `local` — fixed in the
  review (t4): the endpoint now stamps every quick change (see POST, step 4).
- **`agents.commitOtherProjects` is dead**: nothing reads it since audit A1 (`docs/audits/self-optimize-projects.md`);
  listed in `HIDDEN`.
- **Settings outside `defaults()`**: about forty keys are read with defaults spread across their modules (see "What was
  swept"). The schema records their effective defaults; declaring them in `defaults()` would make config.json
  self-describing.
- **Slack tokens have no write endpoint** (config.json or `SLACK_BOT_TOKEN` / `SLACK_USER_TOKEN` only): shown as status.
- **`control.*` knobs other than enabled/input** (`allowFrom`, rate limits, lease, announce, hotkey) can only be changed
  in config.json; `patchConfig` blocks `control`, by design.
- **The persona is per machine**, not mesh-global: the assistant's name, address and humor can differ between
  machines.
- **After a restart only**: `shared.*` (the sync engine is built at boot), `keepAwake`, `update.intervalMin`, `port`,
  `bind`.

## Adding a setting

1. Give it a default (in `defaults()`, or its module's defaults) and read it where it is used.
2. Add an item to the right category of `ui/src/settings-model.js` (or a `HIDDEN` entry with a reason). A config item's
   scope and writer follow from its path; give it a `default` equal to the real one.
3. If it has its own validated endpoint, add a `WRITERS` entry with its prefix.
4. `node scripts/settings-doc.js` to regenerate the inventory below, then `npm test`.

## Inventory

<!-- settings-inventory:start (generated by scripts/settings-doc.js — do not edit by hand) -->
### Writers

Each writable config item is saved by the writer whose prefix is the longest match of its path.

| Writer | Config prefix | Endpoint it mirrors | Setter | Reads with |
| --- | --- | --- | --- | --- |
| `router` | `router` | `POST /api/local/router` | applyRouterPatch (src/router.js), then markGlobalChanged | routerSettings(config().router) |
| `quick` | `quick` | `POST /api/local/quick` | applyQuickPatch (src/quick.js) · local switched on without a node gets this machine as host; a local change warms the responder. Every quick change stamps globalRev (quick is in GLOBAL_PATHS). | quickSettings(config().quick), local: localSettings(config().quick.local) |
| `yolo` | `yolo` | `POST /api/local/yolo/config` | applyYoloPatch (src/yolo.js), then markGlobalChanged | yoloSettings(config().yolo) |
| `brainHome` | `brain.home` | `POST /api/local/brain/home` | server.js brain/home (machine checked against discovery), patchConfig | homeNode(config()) |
| `brainChat` | `brain.chat` | `POST /api/local/brain/chat` | server.js brain/chat (claude-ollama remembers its model), patchConfig · whole object: provider, model, effort | config().brain.chat |
| `brainCore` | `brain.core` | `POST /api/local/brain/core` | server.js brain/core (node '' = this machine), patchConfig · whole object: provider, model, effort, node | config().brain.core |
| `compact` | `brain.compact` | `POST /api/local/compact` | applyCompactPatch (src/compact.js), then markGlobalChanged | compactSettings(config().brain.compact) |
| `exhibits` | `exhibits` | `POST /api/local/exhibits/config` | saveSettings (src/exhibits.js) | settings() (src/exhibits.js) |
| `starnet` | `experimental.starnet` | `POST /api/local/starnet/config` | saveSettings (src/starnet.js), emits config to open UIs | settings() (src/starnet.js) |
| `comfyui` | `comfyui` | `POST /api/local/comfyui/config` | saveSettings (src/comfyui.js) | loadSettings() (src/comfyui.js) |
| `linear` | `linear` | `POST /api/local/linear/config` | setConfig (src/linear.js) | loadSettings() (src/linear.js) |
| `googleDrive` | `connectors.googleDrive` | `POST /api/local/connectors/google-drive/config` | saveSettings (src/connectors/google-drive.js) | loadSettings() (src/connectors/google-drive.js) |
| `config` | (everything else) | `POST /api/local/config` | patchConfig (src/config.js): merge, stamps globalRev when it touches GLOBAL_PATHS | config() |

### ⚙️ General

Who JARVIS is and this machine's identity.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| JARVIS › **Assistant name** `persona.name` | text | machine | `persona.name` → `POST /api/local/config` | default `"J.A.R.V.I.S."` |
| JARVIS › **Calls you** `persona.address` | text | machine | `persona.address` → `POST /api/local/config` | default `"sir"` |
| JARVIS › **Humor** `persona.humor` | slider 0–100 % | machine | `persona.humor` → `POST /api/local/config` | default `60` |
| JARVIS › **Answer at once with a thinking phrase** `persona.thinkingPhrases` | switch | machine | `persona.thinkingPhrases` → `POST /api/local/config` | default `true` |
| JARVIS › **Personality** `persona.soul` | switch | machine | `persona.soul` → `POST /api/local/config` | default `true` |
| This machine › **Machine name** `name` | text | machine | `name` | read-only · env `RIGS_NAME` · `rigs setup --name <name>` |
| This machine › **Machine id** `nodeId` | text | machine | `nodeId` | read-only |
| This machine › **Keep this machine awake** `keepAwake` | switch | machine | `keepAwake` → `POST /api/local/config` | default `true` · after restart · env `RIGS_NO_KEEPAWAKE` |

### 🎨 Appearance & Display

Theme, the galaxy, windows and the dock.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Look › **Theme** `ui.theme` | select: ‹themes› | browser | localStorage `rigs.theme` (`#d-theme`) | default `"jarvis"` |
| Look › **JARVIS face** `ui.face` | switch | browser | localStorage `rigs.face` | default `true` |
| Look › **Hide the menu bar** `ui.menubarHidden` | switch | browser | localStorage `rigs.menubar` | default `false` · not on phones |
| Look › **12-hour clock** `ui.clock12` | switch | browser | localStorage `rigs.clock12` | default `false` |
| Look › **Ask field** `ui.askPlacement` | select: In the menu bar · Floating panel · Docked panel · Hidden (⌘K shows it) | browser | localStorage `rigs.askPanel` › `mode` | default `"topbar"` · not on phones |
| Galaxy › **Show the galaxy** `ui.cloud` | switch | browser | localStorage `rigs.cloud` (`#d-cloud`) | default `true` |
| Galaxy › **Labels** `ui.labels` | switch | browser | localStorage `rigs.d-labels` (`#d-labels`) | default `true` |
| Galaxy › **Traffic** `ui.traffic` | switch | browser | localStorage `rigs.d-particles` (`#d-particles`) | default `true` |
| Galaxy › **Orbit** `ui.orbit` | switch | browser | localStorage `rigs.d-rotate` (`#d-rotate`) | default `true` |
| Galaxy › **Repel** `ui.repel` | slider 20–400 | browser | localStorage `rigs.repel` (`#repel`) | default `120` |
| Galaxy › **Link length** `ui.linkLength` | slider 8–80 | browser | localStorage `rigs.linklen` (`#linklen`) | default `24` |
| Galaxy › **Exhibit animations** `ui.exhibitAnim` | select: off · auto · always | browser | localStorage `rigs.exhibitAnim` (`#d-exanim`) | default `"auto"` |
| Windows › **Docking layout** `ui.docking` | switch | synced | localStorage `rigs.docking` | default `false` · not on phones |
| Windows › **Smart scaling** `ui.scaling` | switch | synced | localStorage `rigs.scaling` | default `false` · not on phones |
| Dock › **Position on screen** `ui.dock.position` | select: Left · Bottom · Right | synced | localStorage `rigs.appdock` › `settings.position` | default `"bottom"` |
| Dock › **Automatically hide and show** `ui.dock.autoHide` | switch | synced | localStorage `rigs.appdock` › `settings.autoHide` | default `false` |
| Dock › **Magnification** `ui.dock.magnification` | switch | synced | localStorage `rigs.appdock` › `settings.magnification` | default `true` |
| Dock › **Magnification size** `ui.dock.magnifyStrength` | select: Small · Medium · Large | synced | localStorage `rigs.appdock` › `settings.magnifyStrength` | default `0.6` |
| Dock › **Dock new panels and windows** `ui.dock.autoDock` | switch | synced | localStorage `rigs.appdock` › `settings.autoDock` | default `false` |
| Dock › **Tab auto-opened terminals together** `ui.dock.autoTabTerminals` | switch | synced | localStorage `rigs.appdock` › `settings.autoTabTerminals` | default `false` |
| Dock › **Group new apps and machines** `ui.dock.autoGroup` | switch | synced | localStorage `rigs.appdock` › `settings.autoGroup` | default `true` |

### 🔔 Notifications

Toasts, the attention banner and agent sessions that pop up.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| **Notifications** `ui.notifications` | switch | browser | localStorage `rigs.notifications` (`#d-notify`) | default `true` |
| **"Agent needs you" banner** `ui.attnBanner` | switch | browser | localStorage `rigs.attnBanner` (`#d-attnbanner`) | default `true` |
| **Auto-open new agent sessions** `ui.autoOpenSessions` | switch | browser | localStorage `rigs.autoOpenSessions` (`#d-autosess`) | default `true` |
| **Speak on this machine's speakers** `persona.speakAloud` | select: auto · never | machine | `persona.speakAloud` → `POST /api/local/config` | default `"auto"` |

### 🎙 JARVIS Voice & Hearing

How JARVIS speaks and listens.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| In this browser › **Speak replies aloud** `ui.speak` | switch | browser | localStorage `rigs.muted` | default `true` |
| In this browser › **Voice** `ui.voice` | select: ‹voices› | browser | localStorage `rigs.voice` | default `""` |
| In this browser › **Hearing** `ui.stt` | select: Automatic · Mesh Whisper (server) · Browser speech recognition | browser | localStorage `rigs.stt` | default `""` · after reload |
| Speech on this machine › **Speech engine** `persona.tts.engine` | select: auto · neural · piper · local | machine | `persona.tts.engine` → `POST /api/local/config` | default `"auto"` |
| Speech on this machine › **Neural voice (Kokoro)** `persona.neural` | switch | machine | `persona.neural` → `POST /api/local/config` | default `true` |
| Speech on this machine › **Neural voice app** `persona.voiceApp` | text | machine | `persona.voiceApp` → `POST /api/local/config` | default `"jarvis-voice"` |
| Speech on this machine › **Piper voice URL** `persona.tts.piperUrl` | text | machine | `persona.tts.piperUrl` → `POST /api/local/config` | default `"http://127.0.0.1:8210"` |
| Speech on this machine › **Trim silence** `persona.tts.trim` | switch | machine | `persona.tts.trim` → `POST /api/local/config` | default `true` |
| Speech on this machine › **System voice** `persona.voice` | text | machine | `persona.voice` → `POST /api/local/config` | default `""` |
| Hearing and senses on this machine › **Hearing app** `persona.hearingApp` | text | machine | `persona.hearingApp` → `POST /api/local/config` | default `"jarvis-voice"` |
| Hearing and senses on this machine › **Emotion app** `persona.emotionApp` | text | machine | `persona.emotionApp` → `POST /api/local/config` | default `"localjev"` |

### 🧠 Brain & Models

Which model thinks, where, and how hard.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Main brain (whole mesh) › **Main-brain machine** `brain.home` | select: ‹machines› | global | `brain.home` → `POST /api/local/brain/home` | default `""` |
| Main brain (whole mesh) › **Provider** `brain.chat.provider` | select: ‹providers› | global | `brain.chat.provider` → `POST /api/local/brain/chat` | default `"claude"` |
| Main brain (whole mesh) › **Model** `brain.chat.model` | text: ‹models:brain.chat.provider› | global | `brain.chat.model` → `POST /api/local/brain/chat` | default `"claude-haiku-5-5"` |
| Main brain (whole mesh) › **Effort** `brain.chat.effort` | select: ‹efforts:brain.chat.provider› | global | `brain.chat.effort` → `POST /api/local/brain/chat` | default `"low"` |
| Core brain (project planning) › **Provider** `brain.core.provider` | select: ‹providers› | global | `brain.core.provider` → `POST /api/local/brain/core` | default `"claude"` |
| Core brain (project planning) › **Model** `brain.core.model` | text: ‹models:brain.core.provider› | global | `brain.core.model` → `POST /api/local/brain/core` | default `"claude-opus-5-5"` |
| Core brain (project planning) › **Effort** `brain.core.effort` | select: ‹efforts:brain.core.provider› | global | `brain.core.effort` → `POST /api/local/brain/core` | default `"high"` |
| Core brain (project planning) › **Planning machine** `brain.core.node` | select: ‹machines› | global | `brain.core.node` → `POST /api/local/brain/core` | default `""` |
| Self-compaction (whole mesh) › **Compact the JARVIS thread** `brain.compact.enabled` | switch | global | `brain.compact.enabled` → `POST /api/local/compact` | default `true` · `rigs compact on\|off` |
| Self-compaction (whole mesh) › **Compact at** `brain.compact.atTokens` | number 1000–2000000 tokens | global | `brain.compact.atTokens` → `POST /api/local/compact` | default `100000` · `rigs compact at <tokens>` |
| Self-compaction (whole mesh) › **Keep last messages** `brain.compact.keepMessages` | number 0–200 | global | `brain.compact.keepMessages` → `POST /api/local/compact` | default `12` · `rigs compact keep <messages>` |
| Self-compaction (whole mesh) › **Summary model** `brain.compact.model` | text: ‹models:claude› | global | `brain.compact.model` → `POST /api/local/compact` | default `"claude-sonnet-5-5"` |
| Local models on this machine › **Ollama URL** `brain.ollamaUrl` | text | machine | `brain.ollamaUrl` → `POST /api/local/config` | default `"http://127.0.0.1:11434"` · env `RIGS_OLLAMA_URL` |
| Local models on this machine › **Claude via Ollama model** `brain.claudeOllama.model` | select: ‹ollamaModels› | machine | `brain.claudeOllama.model` → `POST /api/local/config` | default `""` |
| Local models on this machine › **Claude via Ollama URL** `brain.claudeOllama.url` | text | machine | `brain.claudeOllama.url` → `POST /api/local/config` | default `""` |
| Model catalog › **Extra Claude models** `models.claude` | list | machine | `models.claude` → `POST /api/local/config` | default `[]` |
| Model catalog › **Extra Codex models** `models.codex` | list | machine | `models.codex` → `POST /api/local/config` | default `[]` |

### 🧭 Routing & Fast Path

How a request is classified and how quick answers run.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Pre-routing › **Pre-routing** `router.preroute` | switch | global | `router.preroute` → `POST /api/local/router` | default `true` · `rigs preroute on\|off` |
| Pre-routing › **Engine** `router.engine` | select: LocalJev · Claude (Haiku) · Keyword rules | global | `router.engine` → `POST /api/local/router` | default `"jev"` · `rigs preroute engine jev\|claude\|rules` |
| Pre-routing › **Fallback** `router.fallback` | select: Claude · Keyword rules | global | `router.fallback` → `POST /api/local/router` | default `"claude"` |
| Pre-routing › **Claude router model** `router.claudeModel` | text: ‹models:claude› | global | `router.claudeModel` → `POST /api/local/router` | default `"claude-haiku-5-5"` |
| Pre-routing › **LocalJev URL** `router.jev.url` | text | machine | `router.jev.url` → `POST /api/local/router` | default `""` |
| Pre-routing › **LocalJev app** `router.jev.appId` | text | global | `router.jev.appId` → `POST /api/local/router` | default `"localjev"` |
| Pre-routing › **LocalJev model** `router.jev.model` | text | global | `router.jev.model` → `POST /api/local/router` | default `"jev-latest"` |
| Pre-routing › **LocalJev API key** `router.jev.apiKey` | secret-status | machine | `router.jev.apiKey` → `POST /api/local/router` | secret |
| Pre-routing › **LocalJev timeout** `router.jev.timeoutMs` | number 500–60000 ms | global | `router.jev.timeoutMs` → `POST /api/local/router` | default `8000` |
| Pre-routing › **Minimum confidence** `router.jev.minProb` | slider 0–1 | global | `router.jev.minProb` → `POST /api/local/router` | default `0.55` |
| Pre-routing › **Baseline: answers** `router.baselineMs.answer` | number 0–3600000 ms | global | `router.baselineMs.answer` → `POST /api/local/router` | default `0` |
| Pre-routing › **Baseline: work** `router.baselineMs.work` | number 0–3600000 ms | global | `router.baselineMs.work` → `POST /api/local/router` | default `0` |
| Quick fast path › **Quick fast path** `quick.enabled` | switch | global | `quick.enabled` → `POST /api/local/quick` | default `true` · `rigs quick on\|off` |
| Quick fast path › **Simple asks: provider** `quick.simple.provider` | select: claude | global | `quick.simple.provider` → `POST /api/local/quick` | default `"claude"` |
| Quick fast path › **Simple asks: model** `quick.simple.model` | text: ‹models:claude› | global | `quick.simple.model` → `POST /api/local/quick` | default `"claude-haiku-5-5"` |
| Quick fast path › **Simple asks: effort** `quick.simple.effort` | select: ‹efforts:claude› | global | `quick.simple.effort` → `POST /api/local/quick` | default `"low"` |
| Quick fast path › **Research and reports: provider** `quick.standard.provider` | select: claude | global | `quick.standard.provider` → `POST /api/local/quick` | default `"claude"` |
| Quick fast path › **Research and reports: model** `quick.standard.model` | text: ‹models:claude› | global | `quick.standard.model` → `POST /api/local/quick` | default `"claude-sonnet-5-5"` |
| Quick fast path › **Research and reports: effort** `quick.standard.effort` | select: ‹efforts:claude› | global | `quick.standard.effort` → `POST /api/local/quick` | default `"medium"` |
| Quick fast path › **Max tool turns** `quick.maxTurns` | number 1–50 | global | `quick.maxTurns` → `POST /api/local/quick` | default `8` |
| Quick fast path › **Timeout** `quick.timeoutMs` | number 5000–600000 ms | global | `quick.timeoutMs` → `POST /api/local/quick` | default `90000` |

### 🗣 Local Responder

A model on a machine's own Ollama answers the fast path, with read-only tools.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| **Local responder** `quick.local.enabled` | switch | global | `quick.local.enabled` → `POST /api/local/quick` | default `false` · `rigs quick local on\|off` |
| **Host machine** `quick.local.node` | select: ‹machines› | global | `quick.local.node` → `POST /api/local/quick` | default `""` · `rigs quick local node <machine>` |
| **Model** `quick.local.model` | text: ‹ollamaModels› | global | `quick.local.model` → `POST /api/local/quick` | default `"qwen3:8b"` · `rigs quick local model <model>` |
| **Answers these tiers** `quick.local.tiers` | list: haiku · sonnet | global | `quick.local.tiers` → `POST /api/local/quick` | default `["haiku"]` |
| **Tools** `quick.local.tools` | list: mesh_status · mesh_sessions · mesh_apps · project_list · mesh_processes · usage_report · trace_list · ui_open | global | `quick.local.tools` → `POST /api/local/quick` | default [8 items] |
| **Thinking** `quick.local.think` | switch | global | `quick.local.think` → `POST /api/local/quick` | default `false` |
| **Context size** `quick.local.numCtx` | number 2048–131072 | global | `quick.local.numCtx` → `POST /api/local/quick` | default `16384` |
| **Keep loaded** `quick.local.keepAlive` | text | global | `quick.local.keepAlive` → `POST /api/local/quick` | default `"30m"` |
| **Max tool rounds** `quick.local.maxRounds` | number 1–10 | global | `quick.local.maxRounds` → `POST /api/local/quick` | default `4` |
| **Guard** `quick.local.guard` | switch | global | `quick.local.guard` → `POST /api/local/quick` | default `true` |
| **First-word deadline** `quick.local.firstTokenMs` | number 200–60000 ms | global | `quick.local.firstTokenMs` → `POST /api/local/quick` | default `2500` |
| **Timeout** `quick.local.timeoutMs` | number 2000–600000 ms | global | `quick.local.timeoutMs` → `POST /api/local/quick` | default `30000` |
| **Warm up now** `action.responderWarm` | action | machine | `POST responder/warm` | `rigs quick local warm` |

### 🚀 YOLO

"yolo …" builds a page live in a sandbox window: no project, review, commit or merge.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| **YOLO mode** `yolo.enabled` | switch | global | `yolo.enabled` → `POST /api/local/yolo/config` | default `true` · `rigs yolo on\|off` |
| **Provider** `yolo.provider` | select: claude | global | `yolo.provider` → `POST /api/local/yolo/config` | default `"claude"` |
| **Model** `yolo.model` | text: ‹models:claude› | global | `yolo.model` → `POST /api/local/yolo/config` | default `"claude-sonnet-5-5"` |
| **Effort** `yolo.effort` | select: ‹efforts:claude› | global | `yolo.effort` → `POST /api/local/yolo/config` | default `"low"` |
| **Max turns** `yolo.maxTurns` | number 1–100 | global | `yolo.maxTurns` → `POST /api/local/yolo/config` | default `20` |
| **Timeout** `yolo.timeoutMs` | number 10000–1800000 ms | global | `yolo.timeoutMs` → `POST /api/local/yolo/config` | default `180000` |
| **Runs kept** `yolo.keep` | number 1–1000 | global | `yolo.keep` → `POST /api/local/yolo/config` | default `50` |

### 📋 Projects & Dispatch

How projects are planned, routed to machines and run.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Routing policy (whole mesh) › **Routing rules** `routing.rules` | action | global | `routing.rules` | read-only |
| Routing policy (whole mesh) › **Planner suggestions** `routing.plannerPicks` | select: Machines only · Machines, provider and model · Ignore its suggestions | global | `routing.plannerPicks` → `POST /api/local/config` | default `"machine"` |
| Routing policy (whole mesh) › **Default dispatch** `routing.dispatch` | select: Auto (OpenRig when available) · OpenRig · Direct agent sessions | global | `routing.dispatch` → `POST /api/local/config` | default `"auto"` |
| Routing policy (whole mesh) › **Tasks per machine** `routing.maxTasksPerMachine` | number 1–32 | global | `routing.maxTasksPerMachine` → `POST /api/local/config` | default `4` |
| Routing policy (whole mesh) › **Providers switched off** `routing.avoid` | list: claude · codex · ollama | global | `routing.avoid` → `POST /api/local/config` | default `[]` |
| Pinned projects and hubs › **Pinned projects** `pinnedProjects` | action | machine | `pinnedProjects` | read-only |
| Pinned projects and hubs › **Project hubs** `openrig.hubs.enabled` | switch | machine | `openrig.hubs.enabled` → `POST /api/local/config` | default `true` |
| Pinned projects and hubs › **JARVIS rig** `openrig.hubs.jarvis` | switch | machine | `openrig.hubs.jarvis` → `POST /api/local/config` | default `true` |
| Pinned projects and hubs › **Stop idle workers after** `openrig.hubs.idleMinutes` | number 1–1440 min | machine | `openrig.hubs.idleMinutes` → `POST /api/local/config` | default `20` |
| Pinned projects and hubs › **Lead seat: provider** `openrig.hubs.lead.provider` | select: ‹providers› | machine | `openrig.hubs.lead.provider` → `POST /api/local/config` | default `"claude"` |
| Pinned projects and hubs › **Lead seat: model** `openrig.hubs.lead.model` | text: ‹models:openrig.hubs.lead.provider› | machine | `openrig.hubs.lead.model` → `POST /api/local/config` | default `"claude-sonnet-5-5"` |
| Pinned projects and hubs › **Lead seat: effort** `openrig.hubs.lead.effort` | select: ‹efforts:openrig.hubs.lead.provider› | machine | `openrig.hubs.lead.effort` → `POST /api/local/config` | default `"medium"` |
| Pinned projects and hubs › **Overseer seat: provider** `openrig.hubs.overseer.provider` | select: ‹providers› | machine | `openrig.hubs.overseer.provider` → `POST /api/local/config` | default `"claude"` |
| Pinned projects and hubs › **Overseer seat: model** `openrig.hubs.overseer.model` | text: ‹models:openrig.hubs.overseer.provider› | machine | `openrig.hubs.overseer.model` → `POST /api/local/config` | default `"claude-sonnet-5-5"` |
| Pinned projects and hubs › **Overseer seat: effort** `openrig.hubs.overseer.effort` | select: ‹efforts:openrig.hubs.overseer.provider› | machine | `openrig.hubs.overseer.effort` → `POST /api/local/config` | default `"medium"` |
| OpenRig › **Register peers as OpenRig hosts** `openrig.registerPeers` | switch | machine | `openrig.registerPeers` → `POST /api/local/config` | default `true` |
| OpenRig › **Keep the OpenRig daemon running** `openrig.keepDaemon` | switch | machine | `openrig.keepDaemon` → `POST /api/local/config` | default `true` |
| Workspaces › **Extra project folders** `workspaces.roots` | list | machine | `workspaces.roots` → `POST /api/local/config` | default `[]` |

### 🤖 Autonomy & Agents

How unattended work retries, and the permissions agents run with.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Completion loop › **Completion loop** `autonomy.enabled` | switch | machine | `autonomy.enabled` → `POST /api/local/config` | default `true` |
| Completion loop › **Attempts per task** `autonomy.maxAttempts` | number 1–10 | machine | `autonomy.maxAttempts` → `POST /api/local/config` | default `3` |
| Completion loop › **Model ladder** `autonomy.ladder` | list | machine | `autonomy.ladder` | default `[]` · read-only |
| Completion loop › **Stalled after** `autonomy.stallMinutes` | number 1–1440 min | machine | `autonomy.stallMinutes` → `POST /api/local/config` | default `60` |
| Completion loop › **Answer agent questions after** `autonomy.answerAfterSec` | number 0–3600 s | machine | `autonomy.answerAfterSec` → `POST /api/local/config` | default `90` |
| Completion loop › **Self-answers per attempt** `autonomy.maxSelfAnswers` | number 0–20 | machine | `autonomy.maxSelfAnswers` → `POST /api/local/config` | default `3` |
| Completion loop › **Retry delay** `autonomy.retryDelaySec` | number 0–3600 s | machine | `autonomy.retryDelaySec` → `POST /api/local/config` | default `60` |
| Agents RIGS starts on this machine › **Claude permission mode** `agents.claudePermissionMode` | select: auto · acceptEdits · manual · dontAsk · bypassPermissions · plan | machine | `agents.claudePermissionMode` → `POST /api/local/config` | default `"auto"` |
| Agents RIGS starts on this machine › **Codex sandbox** `agents.codexSandbox` | select: read-only · workspace-write (home) · danger-full-access | machine | `agents.codexSandbox` → `POST /api/local/config` | default `"workspace-write"` |
| Agents RIGS starts on this machine › **Codex approvals** `agents.codexApproval` | select: untrusted · on-failure · on-request · never | machine | `agents.codexApproval` → `POST /api/local/config` | default `"on-request"` |
| Agents RIGS starts on this machine › **Codex network access** `agents.codexNetwork` | switch | machine | `agents.codexNetwork` → `POST /api/local/config` | default `true` |
| Agents RIGS starts on this machine › **OpenRig permission policy** `agents.rigPolicy` | select: builtin:auto · builtin:standard · builtin:yolo | machine | `agents.rigPolicy` → `POST /api/local/config` | default `"builtin:auto"` |
| JARVIS chat on this machine › **JARVIS works in** `brain.workRoot` | text | machine | `brain.workRoot` → `POST /api/local/config` | default `"~"` |
| JARVIS chat on this machine › **Claude chat permission mode** `brain.claudePermissionMode` | select: auto · acceptEdits · manual · dontAsk · bypassPermissions · plan | machine | `brain.claudePermissionMode` → `POST /api/local/config` | default `"auto"` |
| JARVIS chat on this machine › **Claude chat tools** `brain.claudeAllowedTools` | list | machine | `brain.claudeAllowedTools` → `POST /api/local/config` | default [12 items] |
| JARVIS chat on this machine › **Codex chat sandbox** `brain.codexSandbox` | select: read-only · workspace-write (home) · danger-full-access | machine | `brain.codexSandbox` → `POST /api/local/config` | default `"workspace-write"` |

### 🌐 Mesh & Network

How this machine finds and reaches its peers.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Peers › **Extra peers** `peers` | list | machine | `peers` → `POST /api/local/config` | default `[]` · env `RIGS_PEERS` |
| Peers › **Port** `port` | number 1–65535 | machine | `port` | default `4719` · read-only · after restart · env `RIGS_PORT` |
| Peers › **Listen on** `bind` | text | machine | `bind` | default `"auto"` · read-only · after restart · env `RIGS_BIND` |
| Peers › **Mesh token** `meshToken` | secret-status | machine | `meshToken` | read-only · secret · env `RIGS_MESH_TOKEN` |
| SSH › **Authorize mesh peers** `ssh.autoAuthorize` | switch | machine | `ssh.autoAuthorize` → `POST /api/local/config` | default `true` |
| SSH › **Manage ~/.ssh/config** `ssh.manageConfig` | switch | machine | `ssh.manageConfig` → `POST /api/local/config` | default `true` |
| SSH › **Authorize token peers** `ssh.authorizeStaticPeers` | switch | machine | `ssh.authorizeStaticPeers` → `POST /api/local/config` | default `false` |
| SSH › **Sync SSH now** `action.sshSync` | action | machine | `POST ssh/sync` |  |

### 📁 Shared Folder & Files

The folder every machine keeps in sync, and the file browser.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Shared folder › **Shared folder** `shared.enabled` | switch | machine | `shared.enabled` → `POST /api/local/config` | default `true` · after restart |
| Shared folder › **Location** `shared.path` | text | machine | `shared.path` → `POST /api/local/config` | default `""` · after restart · `rigs shared path` |
| Shared folder › **Sync every** `shared.intervalSec` | number 5–86400 s | machine | `shared.intervalSec` → `POST /api/local/config` | default `60` · after restart |
| Shared folder › **Largest file** `shared.maxFileMb` | number 1–100000 MB | machine | `shared.maxFileMb` → `POST /api/local/config` | default `256` · after restart |
| Shared folder › **Ignore** `shared.ignore` | list | machine | `shared.ignore` → `POST /api/local/config` | default `[]` · after restart |
| Shared folder › **Sync now** `action.sharedSync` | action | machine | `POST shared/sync` | `rigs shared sync` |
| Files › **Show hidden files** `files.showHidden` | switch | machine | `files.showHidden` → `POST /api/local/config` | default `false` |
| Files › **Zip size limit** `files.zip.maxBytes` | number 1024–4294967296 bytes | machine | `files.zip.maxBytes` → `POST /api/local/config` | default `536870912` |
| Files › **Zip entry limit** `files.zip.maxEntries` | number 1–1000000 | machine | `files.zip.maxEntries` → `POST /api/local/config` | default `20000` |

### 🖥 Screen Control & Desktop

Screen access, input control and remote desktop.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Screen access and control › **Screen access** `control.enabled` | switch | machine | `control.enabled` | default `true` · read-only |
| Screen access and control › **Full control** `control.input` | switch | machine | `control.input` | default `true` · read-only |
| Screen access and control › **Backend** `control.backend` | text | machine | `control.backend` | default `"auto"` · read-only |
| Screen access and control › **Allowed from** `control.allowFrom` | list | machine | `control.allowFrom` | default `[]` · read-only |
| Screen access and control › **Lease idle timeout** `control.leaseIdleSec` | number 1–3600 s | machine | `control.leaseIdleSec` | default `60` · read-only |
| Screen access and control › **Actions per minute** `control.maxActionsPerMin` | number 1–10000 | machine | `control.maxActionsPerMin` | default `120` · read-only |
| Screen access and control › **Screenshots per minute** `control.maxShotsPerMin` | number 1–10000 | machine | `control.maxShotsPerMin` | default `30` · read-only |
| Screen access and control › **Stream frames per minute** `control.maxStreamFramesPerMin` | number 1–100000 | machine | `control.maxStreamFramesPerMin` | default `600` · read-only |
| Screen access and control › **Announce** `control.announce` | text | machine | `control.announce` | default `"lease"` · read-only |
| Screen access and control › **Kill hotkey** `control.killHotkey` | text | machine | `control.killHotkey` | default `"default"` · read-only |
| Screen access and control › **Audit preview** `control.auditPreview` | number 0–1000 | machine | `control.auditPreview` | default `64` · read-only |
| Screen access and control › **Access & control…** `action.openControl` | action | browser | opens `control` |  |
| Screen access and control › **Stop control on this machine** `action.controlKill` | action | machine | `POST control/kill` | `rigs control off` · confirms first |
| Remote desktop › **Sunshine user** `desktop.sunshineUser` | text | machine | `desktop.sunshineUser` | default `"rigs"` · read-only |
| Remote desktop › **Sunshine password** `desktop.sunshinePass` | secret-status | machine | `desktop.sunshinePass` | read-only · secret |

### 🔌 Connectors

Slack, Google Drive, Linear and ComfyUI on this machine.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Slack › **Bot token** `connectors.slack.token` | secret-status | machine | `connectors.slack.token` | read-only · secret · env `SLACK_BOT_TOKEN` · `rigs connectors slack status` |
| Slack › **User token (search)** `connectors.slack.userToken` | secret-status | machine | `connectors.slack.userToken` | read-only · secret · env `SLACK_USER_TOKEN` |
| Google Drive › **OAuth client id** `connectors.googleDrive.clientId` | text | machine | `connectors.googleDrive.clientId` → `POST /api/local/connectors/google-drive/config` | default `""` |
| Google Drive › **OAuth client secret** `connectors.googleDrive.clientSecret` | secret-status | machine | `connectors.googleDrive.clientSecret` → `POST /api/local/connectors/google-drive/config` | secret |
| Google Drive › **Redirect URI** `connectors.googleDrive.redirectUri` | text | machine | `connectors.googleDrive.redirectUri` → `POST /api/local/connectors/google-drive/config` | default `""` |
| Google Drive › **Largest file read** `connectors.googleDrive.maxBytes` | number 1–10485760 bytes | machine | `connectors.googleDrive.maxBytes` → `POST /api/local/connectors/google-drive/config` | default `1048576` |
| Google Drive › **Connect Google Drive…** `action.driveConnect` | action | browser | opens `mesh.connectors` |  |
| Google Drive › **Disconnect** `action.driveDisconnect` | action | machine | `POST connectors/google-drive/disconnect` | confirms first |
| Linear › **API key** `linear.apiKey` | secret-status | machine | `linear.apiKey` → `POST /api/local/linear/config` | secret · env `LINEAR_API_KEY` · `rigs linear key [--clear]` |
| Linear › **API URL** `linear.url` | text | machine | `linear.url` → `POST /api/local/linear/config` | default `""` |
| Linear › **Timeout** `linear.timeoutMs` | number 1000–120000 ms | machine | `linear.timeoutMs` → `POST /api/local/linear/config` | default `15000` |
| ComfyUI › **ComfyUI URL** `comfyui.url` | text | machine | `comfyui.url` → `POST /api/local/comfyui/config` | default `""` |
| ComfyUI › **Auth header** `comfyui.authHeader` | secret-status | machine | `comfyui.authHeader` → `POST /api/local/comfyui/config` | secret |
| ComfyUI › **GPU overseer** `comfyui.gpuOverseer` | text | machine | `comfyui.gpuOverseer` → `POST /api/local/comfyui/config` | default `"auto"` |
| ComfyUI › **GPU memory needed** `comfyui.gpuNeedMb` | number 0–512000 MB | machine | `comfyui.gpuNeedMb` → `POST /api/local/comfyui/config` | default `18000` |
| ComfyUI › **Job timeout** `comfyui.timeoutSec` | number 10–7200 s | machine | `comfyui.timeoutSec` → `POST /api/local/comfyui/config` | default `900` |

### ▦ Apps & App Store

Apps this machine shares with the mesh, and where installed apps live.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| **App Cloud apps** `apps` | action | machine | `apps` | read-only |
| **Machine tools** `capabilities` | action | machine | `capabilities` | read-only |
| **App Store…** `action.appStore` | action | browser | opens `appstore` |  |
| **Installed apps folder** `appstore.appsDir` | text | machine | `appstore.appsDir` → `POST /api/local/config` | default `""` · env `RIGS_APPS_DIR` |
| **GPU Overseer clients file** `appstore.gpuOverseerClients` | text | machine | `appstore.gpuOverseerClients` → `POST /api/local/config` | default `""` · env `RIGS_GPU_OVERSEER_CLIENTS` |

### ⟳ Updates & Merge

Self-updates from GitHub and the merge steward.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Software update › **Update automatically** `update.auto` | switch | machine | `update.auto` → `POST /api/local/config` | default `true` |
| Software update › **Check every** `update.intervalMin` | number 2–1440 min | machine | `update.intervalMin` → `POST /api/local/config` | default `10` · after restart |
| Software update › **Remote** `update.remote` | text | machine | `update.remote` | default `"origin"` · read-only |
| Software update › **Branch** `update.branch` | text | machine | `update.branch` | default `"main"` · read-only |
| Software update › **Update this machine** `action.updateNow` | action | machine | `POST update` | `rigs update` · confirms first |
| Software update › **Update every machine** `action.updateAll` | action | global | `POST /api/mesh/update` | `rigs update --all` · confirms first |
| Change policy › **Merge steward** `merge.steward` | select: ‹machines› | machine | `merge.steward` → `POST /api/local/config` | default `""` |
| Change policy › **Merge queue…** `action.mergeQueue` | action | browser | opens `mesh.changes` | `rigs merge` |

### 🛡 Privacy & Security

Who may use this machine and what is recorded.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Access › **Allowed Tailscale users** `allowedUsers` | list | machine | `allowedUsers` → `POST /api/local/config` | default `[]` |
| Access › **Allow tagged devices** `allowTaggedDevices` | switch | machine | `allowTaggedDevices` → `POST /api/local/config` | default `true` |
| Request traces › **Record request traces** `traces.enabled` | switch | machine | `traces.enabled` → `POST /api/local/config` | default `true` |
| Request traces › **Keep traces for** `traces.days` | number 1–3650 days | machine | `traces.days` → `POST /api/local/config` | default `14` |
| Request traces › **Field size cap** `traces.maxField` | number 200–1000000 chars | machine | `traces.maxField` → `POST /api/local/config` | default `8000` |

### 🧪 Experimental

Features that are still being tried out.

| Setting | Control | Scope | Lives in | Notes |
| --- | --- | --- | --- | --- |
| Exhibits › **Exhibits** `exhibits.enabled` | switch | machine | `exhibits.enabled` → `POST /api/local/exhibits/config` | default `false` |
| Exhibits › **Images** `exhibits.images` | select: auto · svg · comfyui · off | machine | `exhibits.images` → `POST /api/local/exhibits/config` | default `"auto"` |
| Exhibits › **Entries per document** `exhibits.maxPerDoc` | number 5–500 | machine | `exhibits.maxPerDoc` → `POST /api/local/exhibits/config` | default `60` |
| Exhibits › **Documents kept** `exhibits.maxDocs` | number 10–5000 | machine | `exhibits.maxDocs` → `POST /api/local/exhibits/config` | default `200` |
| StarNet space station › **Space station view** `experimental.starnet.enabled` | switch | machine | `experimental.starnet.enabled` → `POST /api/local/starnet/config` | default `false` · `rigs starnet on\|off` |
| StarNet space station › **StarNet commit** `experimental.starnet.ref` | text | machine | `experimental.starnet.ref` | default `""` · read-only · `rigs starnet install` |
| StarNet space station › **StarNet folder** `experimental.starnet.dir` | text | machine | `experimental.starnet.dir` | default `""` · read-only |
| StarNet space station › **Install StarNet** `action.starnetInstall` | action | machine | `POST starnet/install` | `rigs starnet install` |

### Hidden on purpose

| Config path / localStorage key | Why it is not in the window |
| --- | --- |
| config `globalRev` | Revision stamp of the mesh-global settings, written by RIGS (src/globalbrain.js), not a preference. |
| config `routing.rulesVersion` | Bookkeeping: lets non-customized machines pick up new default rules (RULES_VERSION). |
| config `routing.customized` | Set when the rules are saved and cleared by "Reset to defaults" in the routing rules editor. |
| config `agents.commitOtherProjects` | No longer read by any code (audit A1, docs/audits/self-optimize-projects.md): task agents never commit outside a RIGS dev worktree (src/autonomy.js guardBrief). |
| config `brain.compact.timeoutMs` | Time limit of the summarisation call (src/compact.js); not exposed by POST /api/local/compact or rigs compact. |
| config `persona.overseer` | Internal pointer to JARVIS's overseer session (default tmux jarvis-overseer), set by RIGS. |
| localStorage `rigs.dock` | The dock layout itself (arranged by dragging; reset in the Panels menu), not a preference. |
| localStorage `rigs.panels` | Legacy dock layout, migrated into rigs.dock. |
| localStorage `rigs.spaces` | The virtual desktops (Spaces) and which desktop each window is on, arranged from the menu bar desktop indicator, not a preference. |
| localStorage `rigs.spaces.active` | The desktop this browser was last on (Spaces, switched with Ctrl+arrows or the menu bar indicator), not a preference. |
| localStorage `rigs.sync` | Bookkeeping of the synced storage (revisions of rigs.dock and friends). |
| localStorage `rigs.removed` | Removed panels and apps with their undo history; restored from the Window menu. |
| localStorage `rigs.agents.dismissed` | Agent cards you dismissed: state, not a preference. |
| localStorage `rigs.askHistory` | History of what you asked: data, not a preference. |
| localStorage `rigs.chat` | The open conversation: state. |
| localStorage `rigs.chatTarget` | The session the conversation is sent to: state. |
| localStorage `rigs.brain` | This browser's cache of the main brain; the window shows the mesh-global brain.home and brain.chat instead. |
| localStorage `rigs.brainv` | One-time migration marker of rigs.brain. |
| localStorage `rigs.hidden` | Node types hidden in the Filters legend: a view filter toggled in the legend. |
| localStorage `rigs.graphify.view` | Which view the Graphify window shows: remembered window state. |
| localStorage `rigs.finder` | The file browser's view (icons, list, columns), sort and sidebar/preview widths, set in the window itself (finder-model.js): remembered window state. |
| localStorage `rigs.media` | The media player's volume, mute and speed, set with its own controls: remembered player state. |
| localStorage `rigs.usage.range` | Time range of the Tokens & time panel: remembered panel state. |
| localStorage `rigs.traces.*` | Request traces panel and explorer view state (range, view, lane, size, even, limit). |
| localStorage `rigs.exhibits.*` | Exhibit window view state (cards or document). |
| localStorage `rigs.desktop.pos.*` | Where you dragged the desktop icons, per folder (desktop.js positionsKey): layout state, not a preference. |
<!-- settings-inventory:end -->
