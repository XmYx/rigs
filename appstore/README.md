# App Store

The App Store is the catalog of apps a machine can install into the App Cloud. JARVIS lists them, and
`POST /api/local/appstore/<id>/install` (or the MCP tool `appstore_install`) installs one on the machine:

1. fetches the source
2. creates its Python venv or installs its node deps
3. downloads its models
4. sets up a `systemctl --user` unit (Linux) or a launcher
5. registers it as an App Cloud app and waits until it answers its health check

The code is `src/appstore.js`.

- **Catalog:** one JSON manifest per app, in `appstore/catalog/` (ships with RIGS) and
  `~/.rigs/appstore/catalog/` (local additions; a later file with the same `id` replaces an earlier one).
  A manifest that fails validation is reported in `errors` of `GET /api/local/appstore` and is not offered.
- **Install location:** `~/.rigs/apps/<id>/` (config `appstore.appsDir`). It holds `app/` (the source),
  `venv/`, `install.json` (step state) and `install.log`. A `rigs` source runs in place from the RIGS
  checkout; only its venv, state and log live there.
- **Uninstall** unregisters the app, disables its unit and moves `~/.rigs/apps/<id>` and the unit file into
  `~/.rigs/trash`. Nothing is deleted. Models outside the app folder (the Hugging Face cache, absolute
  `dest`) stay and are listed.

## Manifest

```jsonc
{
  "id": "live-video",                 // a-z 0-9 - _ ; also the App Cloud app id
  "name": "Live Video",
  "icon": "🎬",
  "description": "Live LTX-Video text/image-to-video.",
  "version": "1.0.0",                 // shown as the installed version; a new version offers an update
  "homepage": "", "license": "", "notes": "",   // free text (notes: caveats, e.g. a gated model)
  "platforms": ["linux"],             // linux | mac | windows; default all three
  "needs": {
    "gpu": "nvidia",                  // false | true (any GPU) | "nvidia" (CUDA)
    "vramGB": 12,                     // checked against nvidia-smi; a Mac compares unified memory
    "diskGB": 8,                      // source + environment; model sizes are added on top
    "python": "3.11"                  // python runtime only; uv fetches it if the machine lacks it
  },

  "source": { "type": "git", "url": "https://github.com/org/app.git", "ref": "v1.2", "subdir": "" },
  //      | { "type": "rigs", "path": "applets/navigation", "copy": false }   // in this repo; copy:true copies it out
  //      | { "type": "tarball", "url": "https://…/app.tar.gz", "sha256": "…", "subdir": "" }   // .tar.gz .tar.xz .tgz .zip

  "runtime": {
    "type": "python",                 // python | node | none
    "requirements": ["requirements.txt"],          // relative to the app folder
    "packages": ["huggingface_hub>=0.30"],         // extra pip specs
    "torch": { "index": "https://download.pytorch.org/whl/cu128", "packages": ["torch==2.7.1", "torchvision"] },
    "project": false, "extras": ["gpu"],           // pip install the app folder itself (with extras)
    "pipArgs": []                                  // extra pip flags
  },
  //       { "type": "node", "npm": "auto" }       // npm ci with a lockfile, else npm install; false = skip

  "models": [
    { "name": "LTX-Video 2B", "kind": "hf", "repo": "Lightricks/LTX-Video",
      "files": ["ltxv-2b-0.9.8-distilled.safetensors"],   // or "include": ["*.safetensors"]; none = whole repo
      "revision": "main", "dest": "models/ltx",           // no dest = the Hugging Face cache (HF_HOME)
      "sizeGB": 6.3, "gated": false },                    // gated: needs `hf auth login` (checked first)
    { "name": "VAE", "kind": "url", "url": "https://…/vae.pt", "dest": "models/vae.pt", "sizeGB": 0.3, "sha256": "…" }
  ],

  "port": 8211, "healthPath": "/healthz", "healthTimeoutSec": 180,
  "env": { "LV_PORT": "{port}", "LV_MODELS": "{appDir}/models" },
  "launch": {
    "command": ["{python}", "{appDir}/server.py", "--host", "127.0.0.1", "--port", "{port}"],
    "cwd": "",                                            // default: the app folder
    "systemd": { "unit": "livevideo", "after": ["gpu-overseer.service"], "wants": [], "service": { "KillMode": "mixed" } }
  },
  "gpuOverseer": {                                        // optional: join the GPU Overseer (VRAM arbitration)
    "match": "{venv}/",                                   // default: the venv (python) or app folder path
    "unload": { "url": "http://127.0.0.1:{port}/api/unload", "body": {} },
    "busy": { "url": "http://127.0.0.1:{port}/api/busy", "method": "GET" }
  },
  "postInstall": [{ "name": "build assets", "run": ["{python}", "scripts/build.py"], "cwd": "", "timeoutSec": 600 }],
  "rewrite": { "rootRelative": true }                     // App Cloud proxy hints, as in src/apps.js
}
```

**Placeholders** (allowed in `launch`, `env`, `postInstall`, model `dest` and `gpuOverseer`). An unknown
placeholder is a validation error.

| Placeholder | Value |
| --- | --- |
| `{id}` | the app id |
| `{root}` | `~/.rigs/apps/<id>` |
| `{appDir}` | the app's source folder |
| `{venv}` | the app's Python venv |
| `{python}` | the venv's Python (runtime `python`), else the system `python3` |
| `{node}` | the Node that runs RIGS |
| `{port}` | the app's port |
| `{home}` | the user's home |
| `{rigsApp}` | the RIGS checkout |
| `{modelsDir}` | `{root}/models` |
| `{hfHome}` | the Hugging Face home (`HF_HOME`) |

**Model `dest`** can be relative (inside the app folder), `~/…`, absolute, or start with a placeholder. A
`rigs` source that runs in place must not use a relative `dest`, so nothing is written into the RIGS checkout.

## The install job

| Step | Does | Skipped when |
| --- | --- | --- |
| check | platform, GPU/VRAM, free disk, git/uv/python present, gated-model login, no clash with a hand-registered app, port or unit | never (always runs) |
| fetch | `git init` + shallow `fetch` of `ref` (submodules too), tarball download (resumed) + extract, or copy | same source, already fetched |
| venv | `uv venv --seed --python X`, else `pythonX -m venv` | same Python version, venv present |
| deps | `uv pip install` (or the venv's pip) with torch from its index; `npm ci` / `npm install` | same requirements, files and source revision |
| models | `hf download … --local-dir` (or `snapshot_download`); URLs over HTTP with `Range` resume | each model whose files are already on disk |
| post | `postInstall` commands with the venv on `PATH` | same commands, source and deps |
| launch | writes `~/.config/systemd/user/<unit>` (`rigs-app-<id>` unless `launch.systemd.unit`) and enables it; else `<root>/launch.mjs` | same unit/launcher text |
| register | `config.apps` entry (`installedBy: "appstore"`) and the GPU Overseer client | same entry |
| health | starts it through the App Cloud (`startApp`) and waits for `healthPath` | never |

Installing again redoes only what changed. A failed or cancelled install resumes from the failed step.

**Install options** (body of `POST …/install`):

| Option | Effect |
| --- | --- |
| `port` | use another port |
| `suffix` | appended to the unit name and the GPU Overseer client id, so a test install can sit beside a live one |
| `dryRun` | check and plan only; changes nothing |
| `until: "<step>"` | stop after that step |
| `gpuOverseer: false` | do not add a GPU Overseer client |

The App Store never overwrites a unit file or GPU Overseer client it did not write. It refuses to install
over an app already registered by hand; that app shows as `external`.

## API

| Call | What |
| --- | --- |
| `GET /api/local/appstore` | catalog cards: needs, download size, `fit` for this machine, `install` state |
| `GET /api/local/appstore/<id>` | one card + its full manifest |
| `POST /api/local/appstore/<id>/install` | start or resume the job; returns it at once |
| `GET /api/local/appstore/<id>/job` | steps with status/percent/detail, overall percent, log tail |
| `POST /api/local/appstore/<id>/cancel` | stop the running job |
| `POST /api/local/appstore/<id>/uninstall` | unregister, disable, move to trash |

All of these also work as `/api/nodes/<node>/appstore…` for any machine. Job progress is broadcast on the UI
WebSocket as `{ type: "appstore", node, job }`.

**Install states:**

| State | Meaning |
| --- | --- |
| `not-installed` | not on this machine |
| `external` | registered by hand, not by the store |
| `installing` | running; has `step`, `percent` |
| `installed` | has `version`, `updateAvailable` |
| `partial` | stopped early with `until` |
| `failed` | has `error`, `failedStep`, `logTail` |

MCP: `appstore_list`, and `appstore_install` (`wait`, `dryRun`, `port`, `uninstall`).

**Testing:** set `RIGS_HOME`, `RIGS_NO_SYSTEMD=1` (launcher scripts instead of units), `RIGS_SYSTEMD_USER_DIR`
and `RIGS_GPU_OVERSEER_CLIENTS`, so nothing outside the scratch home is touched. Every entry point of
`src/appstore.js` also takes fake `deps` (see `test/appstore.test.js`).

## Catalog apps

| App | Source | Notes |
| --- | --- | --- |
| Navigation (`navigation`) | `applets/navigation` in RIGS, node, runs in place | no models, no venv |
