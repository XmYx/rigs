# App Store end-to-end install test (t4)

Run on magix-system, 2026-10-17, from the dev worktree, against a **scratch** server:
`RIGS_HOME=<scratch>/home RIGS_APPS_DIR=<scratch>/apps RIGS_PORT=17433 node bin/rigs.js serve` (plus `RIGS_NO_SYSTEMD=1`
for the first runs), installs sent with `{"suffix":"-test","port":<18xxx>}`. The live `~/.rigs`, the running apps and
their units were never written to; `~/.rigs/config.json` has none of the test ports/ids. (It did change during the run:
the live daemon applied `migration 2026-10-17-live-video-applet`, a sibling project's rollout.)
The App Cloud proxy route is `/api/nodes/<node>/apps/<id>/…` (not `/api/local/apps/…`).

## Machine limits that shaped the test
| | |
|---|---|
| root disk | 140–206 MB free of 1.8 TB (`df`), so nothing big could be written there; scratch lived on `/tmp` (tmpfs, 26 GB) |
| RAM | ~4 GB available (ComfyUI holds 19 GB, Ollama 5 GB) — a 6–8 GB torch venv in tmpfs was not safe |
| VRAM | 8 GB free of 24 (ComfyUI 11 GB) — Live Video leases 18 GB, so it could not be launched |

So **Live Video was installed for real up to the venv, and its deps/models/launch were planned, not run** (see below).

## Results
| App | What ran | Result |
|---|---|---|
| Navigation | full install from scratch, no systemd | all 9 steps ok, **job 1.0 s** (3 s wall), `curl /api/nodes/magix-system/apps/navigation/healthz` → `{"ok":true}` |
| Navigation | full install with a **real user unit** `rigs-app-navigation-test.service` (enabled, active), then uninstall | healthz `{"ok":true}`; uninstall stopped + disabled + removed the unit (found bug 2) |
| Live Video | real: check, fetch (copy of vendored source, 6.7 MB, hash 82bb80c683), venv (uv, Python 3.14.4); dry run of the rest; `uv pip install --dry-run -r requirements.txt -c constraints.txt torch==2.12.0 --extra-index-url …/cu130` | resolves to torch 2.12.0+cu130, triton 3.7.0, transformers 5.9.0 (the comfyenv pins) in 2.3 s; both models detected in the real HF cache (`HF_HOME=~/.cache/huggingface`, read-only), nothing downloaded; dry run plans unit, registration and a GPU Overseer client |
| Krea Studio | full install on port 18741 | 9 steps ok, 3 models detected in `~/ai/ComfyUI/models`, `…/apps/krea-studio/healthz` → `{"ok": true}` |
| ACE-Step | install dry run; manual: shallow fetch of the pinned commit, `uv venv --python 3.12`, `uv pip install --dry-run . torch==2.10.0 … --constraint constraints.txt`, Hub tree listing of both pinned model revisions | check refuses: `needs 37 GB of disk (26.2 GB free)` (correct). Fetch 1.0 s / 30 MB, Python 3.12.13, 139 pinned versions resolve; model file lists 28 files 10.09 GB and 11 files 19.95 GB = manifest 9.399 / 18.583 GiB |
| scratch app `mini-test` (git source, uv venv + huggingface_hub, 605 MB model) | install, interrupt twice, resume | see below; full run incl. venv 36 s; healthz `{"ok":true,"app":"mini"}` |

## Interrupted download: found, fixed
Before the fix the HF path shelled out to `hf download` and the comment claimed it resumed. It does not: `huggingface_hub`
2.2.0 writes each attempt to a fresh `<etag>.<random>.incomplete` file (`file_download.py`, "process-unique temporary file").
Measured: three interrupted attempts left three `.incomplete` files (48 KB, 262 MB, 555 MB) and each new run started at byte 0
— with and without xet (`HF_HUB_DISABLE_XET=1`). The real catalog models (23 GB Live Video, 28 GB ACE-Step) are xet files.

Fix (`dd57ad5`, follow-up commit): a model with a pinned 40-char `revision` and no `include` globs is downloaded by the
installer itself with `downloadFile` (HTTP Range on `<blob>.part`, sha256 against the LFS etag), into `dest`, or into the
standard hub cache layout (`blobs/<etag>` + `snapshots/<rev>/<file>` symlink). A whole-repo model lists its files from
the Hub tree API first (paged). Everything else still uses the hub CLI.
Verified: cancel at 134,565,743 bytes → resumed install continued the same `.part` and finished at 605,123,003 bytes
(sha256 ok); `hf_hub_download(..., local_files_only=True)` then resolves the snapshot, so apps find the model.
A whole-repo pinned model (`sshleifer/tiny-gpt2`, dest) downloaded through the tree API. Unit tests added for both.

## Other bugs found
2. Uninstall failed with `EXDEV` when the systemd unit dir (`~/.config/systemd/user`) is on another disk than the
   trash and the apps dir: `moveToTrash` fell back to `<appsDir>/.trash`, which was also another disk. Now it copies into
   the trash and removes the original as a last resort. Verified with the real unit above.
3. Running a scratch `rigs serve` from a dev worktree makes the updater strip OpenRig managed blocks from the worktree's
   `CLAUDE.md` ("updater: removed OpenRig managed blocks from CLAUDE.md in the install"). Harmless, not committed, but surprising.

## Open problems
- **Not done:** Live Video deps (torch cu130, ~8 GB) install, model download step and launch, and ACE-Step venv *install* /
  model download: this machine has no room (disk, RAM, VRAM above). Everything up to those steps ran or resolved; re-run on
  a machine with ~40 GB free disk, and a clean `HF_HOME`, to prove the full path and the download timing.
- The installer's first-run disk check counts models already present in `HF_HOME`; with an empty scratch `HF_HOME` Live Video
  is refused (`needs 29.6 GB`), as intended.
- `npm test` flaked once (2 failures, ports/registry shared with the scratch run's apps); 257/257 and 258/258 on every later run.

## Cleanup
Test apps uninstalled through the store (files moved to the scratch trash, units disabled); `systemctl --user list-units
--all '*-test*'` and `~/.config/systemd/user/*test*` are empty; no listeners on 17433/187xx/189xx/1821x. The scratch
tree (`/tmp/claude-1000/…/scratchpad`, tmpfs) holds the moved dirs; they were not moved to `~/.rigs/trash` because that
is on the full root disk.
