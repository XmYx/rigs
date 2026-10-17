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

**Placeholders** (allowed in `launch`, `env`, `postInstall`, model `dest`, `gpuOverseer` and `runtime.pipArgs`). An
unknown placeholder is a validation error.

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

**Pinning a venv:** list the direct deps (`requirements` or the project's own `pyproject.toml`) and add a
constraints file generated from a working venv (`uv pip freeze`, minus editable and local entries). A source in RIGS
can reference it from its requirements file (`-c constraints.txt`); a git source uses
`"pipArgs": ["--constraint", "{rigsApp}/appstore/sources/<id>/constraints.txt"]`. A file named in `pipArgs` is
part of the deps step's key, so editing it reinstalls.

**Apps without a public repo** are vendored in `appstore/sources/<id>/` and use
`{ "type": "rigs", "path": "appstore/sources/<id>", "copy": true }`: the folder is copied to
`~/.rigs/apps/<id>/app`, so it can write next to itself. Its content is part of the fetch key, so a RIGS update
that changes the folder is copied again on the next install. `postInstall` reruns when the manifest `version`
changes, for steps that copy files from outside the source.

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
| Live Video (`live-video`) | vendored: `appstore/sources/live-video` (copied) | Python 3.14, torch 2.12.0 from cu130, `requirements.txt` + `constraints.txt` (comfyenv); 2 models, 23.6 GB in the HF cache |
| ACE-Step Studio (`acestep-studio`) | git `ace-step/ACE-Step-1.5` @ `ca1e85f`; studio UI vendored in `appstore/sources/acestep-studio`, copied to `<checkout>/studio` by `postInstall` | Python 3.12, torch 2.10.0 from cu128, the project's `pyproject.toml` + `constraints.txt`; 2 models, 28.0 GB in `<checkout>/checkpoints` |
| Krea Studio (`krea-studio`) | vendored: `appstore/sources/krea-studio` (copied) | stdlib Python, no venv; drives ComfyUI on :8188; 3 models, 17.4 GB into `~/ai/ComfyUI/models` |

How each one runs on magix-system (audited 2026-10-17) and what a fresh install gets:

**Live Video** — live: `/home/magix/PycharmProjects/magix/livevideo` (untracked in the `XmYx/magix` repo), unit
`livevideo.service`, port 8211, a bare Python 3.14.4 venv whose `.pth` points into ComfyUI's comfyenv. `server.py`
(aiohttp, no CUDA) spawns `engine.py` (LTX-Video 2B on the GPU), which runs `text_encoder.py` (T5-XXL, CPU only).

| Model | Source | Size | Where |
| --- | --- | --- | --- |
| LTX-Video 2B 0.9.6 distilled | `Lightricks/LTX-Video` `ltxv-2b-0.9.6-distilled-04-25.safetensors` | 5.9 GB | HF cache (`hf_hub_download`) |
| T5-XXL encoder + tokenizer + scheduler | `Lightricks/LTX-Video` `text_encoder/*`, `tokenizer/*`, `scheduler/*` | 17.7 GB | HF cache (`snapshot_download`) |

Both are pinned to revision `8984fa25…`, the one cached on magix-system (`LTX_REVISION`). VRAM: 16.5 GB lease,
~18 GB reserved at 1280x704. GPU Overseer: client `live-video`, match `{appDir}/engine.py`, unload `api/unload`,
busy `api/busy`. Changes in the vendored copy: the HF cache is found through `huggingface_hub` (honours `HF_HOME`)
instead of `~/.cache/huggingface`; `GPU_OVERSEER`, `GPU_OVERSEER_CLIENT`, `OLLAMA_HOST_URL` and `LIVEVIDEO_ROOT`
(where `api/record` may write) are env vars. System needs: NVIDIA driver ≥ 580 (CUDA 13.0), gcc (`torch.compile`),
~10 GB free RAM for T5, ffmpeg for recordings.

**ACE-Step Studio** — live: `/home/magix/apps/acestep-studio/server.py` (no repo) on the ACE-Step 1.5 checkout
`/home/magix/PycharmProjects/MadMaxUnity/audio/ace15` (clean, `ca1e85f`), its uv venv (Python 3.12.13, torch
2.10.0+cu128, editable `acestep` + vendored `nano-vllm`), unit `acestep-studio.service`, port 8191.

| Model | Source | Size | Where |
| --- | --- | --- | --- |
| turbo DiT, VAE, Qwen3-Embedding-0.6B, 5Hz LM 1.7B | `ACE-Step/Ace-Step1.5` (whole repo) | 9.4 GB | `<checkout>/checkpoints` |
| XL turbo DiT (the studio's default `config_path`) | `ACE-Step/acestep-v15-xl-turbo` (whole repo) | 18.6 GB | `<checkout>/checkpoints/acestep-v15-xl-turbo` |

Pinned to the current Hub revisions (`19671f40…`, `d4a0b288…`); the live checkpoints were downloaded earlier and are
not tagged with a revision. VRAM: DiT 12.8 GB + LM 5 GB (`ACESTEP_VRAM_DIT_MB`, `ACESTEP_VRAM_LM_MB`). GPU Overseer:
client `acestep-studio`, match `{appDir}/studio/server.py`, unload `api/unload`, busy `api/status`. Changes in the
vendored studio: `ACESTEP_ROOT` defaults to the folder above `studio/`; `GPU_OVERSEER_CLIENT` is an env var.

**Krea Studio** — live: `/home/magix/apps/krea-studio/server.py` (no repo, stdlib only, system `python3`), unit
`krea-studio.service` (wants `comfyui.service`), port 8190. It sends a Krea 2 Turbo graph to ComfyUI and reads the
images from ComfyUI's `output/krea_studio`.

| Model | Source | Size | Where (ComfyUI loader) |
| --- | --- | --- | --- |
| Krea 2 Turbo fp8 scaled | `Comfy-Org/Krea-2` `diffusion_models/krea2_turbo_fp8_scaled.safetensors` | 12.2 GB | `~/ai/ComfyUI/models/diffusion_models` (`UNETLoader`) |
| Qwen3-VL 4B fp8 scaled | `Comfy-Org/Krea-2` `text_encoders/qwen3vl_4b_fp8_scaled.safetensors` | 4.9 GB | `~/ai/ComfyUI/models/text_encoders` (`CLIPLoader`, type `krea2`) |
| Qwen-Image VAE | `Comfy-Org/Krea-2` `vae/qwen_image_vae.safetensors` | 0.2 GB | `~/ai/ComfyUI/models/vae` (`VAELoader`) |

Pinned to `1171f4dc…`; the byte sizes match the files on magix-system. VRAM is held by ComfyUI (Krea Studio asks the
overseer for 18 GB as client `comfyui`). Change in the vendored copy: `COMFYUI_DIR` (default `~/ai/ComfyUI`).

Sizes are GiB (1024³ bytes), as the installer counts them.

### Open questions and blockers

- **No public source for Live Video, ACE-Step Studio or Krea Studio.** They are vendored in `appstore/sources/` for
  now. If they should live in their own repos, create them and switch `source` to `git`; no URL is invented here.
  Parallel projects are building `applets/live-video` and `applets/krea-studio` (ComfyUI-based) in RIGS; once they
  merge, those manifests can move to `{ "type": "rigs", "path": "applets/…" }`.
- **Krea Studio needs ComfyUI**, which is not in the catalog: v0.35.0+ (krea2 `CLIPLoader` type, `TextGenerate`
  node) on `127.0.0.1:8188`, installed in `~/ai/ComfyUI`. Elsewhere, override the manifest in
  `~/.rigs/appstore/catalog/` with other model dests and `COMFYUI_DIR`.
- **The GPU Overseer** (`~/apps/gpu-overseer`, port 8195) is not in the catalog either. All three GPU apps work
  without it (they load without a lease); with it they get VRAM arbitration.
- **No gated models**: none of the repos needs a Hugging Face login. Licenses: LTX-Video Open Weights License 0.X,
  ACE-Step MIT, Krea 2 under Krea's own license (`LICENSE.pdf` in `Comfy-Org/Krea-2`).
- **Disk**: the three GPU apps download 69 GB of models plus ~15 GB of environments.
- **Linux only**: the torch builds are CUDA wheels and the apps use `systemctl --user`; macOS/Windows are not offered.

