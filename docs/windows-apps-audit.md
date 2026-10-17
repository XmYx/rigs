# Windows audit of published apps (App Cloud)

Audited 2026-10-17 from `mesh_apps` and each host's `config.json` (read only; nothing re-registered).
Launch recipes use the per-OS shape from `src/apps.js`: `launch: { linux: {systemd|command}, windows: { command, cwd, env } }`.
Status: **ready** (works as is), **fixed** (changed in this branch), **needs-external-change** (source outside this repo; proposal only).

| id | host | status | Windows command | remaining issues |
| --- | --- | --- | --- | --- |
| navigation | magix-system | ready | `"{node}" "{appDir}\applets\navigation\server.js"` (cwd `{rigsApp}`; in `catalog/navigation.json` and `applets/navigation/store.json`) | none. Plain Node, `path.join`, `/healthz`, relative URLs. Only the `.service.tmpl` is Linux-only, and Windows does not use it. |
| live-video-comfy | macbookpro, magix-system | fixed | `{"windows":{"command":"node \"<RIGS>\\applets\\live-video\\server.js\"","cwd":"<RIGS>"}}` | The migration `2026-10-17-live-video-applet` quoted the path with `JSON.stringify`, which doubles backslashes. It now writes a `windows` recipe with plain quotes. Needs a user-supplied ComfyUI. |
| krea-studio (applet, `applets/krea-studio`) | none registered | ready | `node "<RIGS>\applets\krea-studio\server.js"` (cwd `<RIGS>`) | none. Same shape as the other Node applets. Only the `.service` file is Linux-only. |
| krea-studio (catalog, Python) | magix-system | ready, Linux-only by hardware | `{python} {appDir}\server.py --host 127.0.0.1 --port {port} --comfy http://127.0.0.1:8188` (from `launch.command`) | The manifest says `platforms: ["linux"]`. It is stdlib Python and uses `expanduser`, so it should run on Windows. The ComfyUI paths `{home}/ai/ComfyUI` are a convention, so a Windows install needs a manifest copy with its own `COMFYUI_DIR`. The `.exe` check was not run on Windows. |
| live-video (catalog, Python) | magix-system | fixed | `{python} {appDir}\server.py ...` (from `launch.command`) | `server.py` hard-coded `.venv/bin/python` and ran `systemctl`. It now picks `Scripts\python.exe` on Windows and skips the systemd pause. Still `platforms: ["linux"]`: `torch.compile` needs a C compiler (MSVC, triton-windows), and the pinned torch 2.12 cu130 wheels have not been tried on Windows. |
| acestep-studio | magix-system | fixed | `{python} {appDir}\studio\server.py --host 127.0.0.1 --port {port}` (cwd `{appDir}\studio`) | The jukebox looked for `claude` only at `~/.local/bin/claude` and defaulted PATH to `/usr/bin:/bin`. It now also checks `claude.exe` and uses `os.defpath`. Still `platforms: ["linux"]` until the ACE-Step 1.5 dependencies (flash-attn, `nano-vllm` or the pt LM backend) are checked on Windows. |
| body-matching | macbookpro | needs-external-change | none. The app is `launchctl`-only and its source is outside this repo. | Launch is a macOS LaunchAgent (`com.rigs.body-matching-host`), currently down (HTTP 503). A Windows host needs `{"windows":{"command":"python \"<dir>\\host.py\" --port 8766","cwd":"<dir>"}}` once its source has been checked. |
| gpu-overseer | magix-system | needs-external-change | `python <dir>\overseer.py --port 8195` (proposal) | systemd unit only. It probably uses `nvidia-smi` and `systemctl` to stop services. On Windows it needs `nvidia-smi.exe` on PATH and a different way to stop apps (`taskkill`). |
| grok-agent | magix-system | needs-external-change | `python <dir>\server.py --port 8196` (proposal) | systemd unit only; source not in this repo. |
| jarvis-voice | magix-system | needs-external-change | `<venv>\Scripts\python.exe <dir>\server.py --port 8197` (proposal) | systemd unit only. It uses about 16 GB of RAM and is stopped through `systemctl` by live-video; that path is skipped on Windows. |
| localjev | magix-system | needs-external-change | `python <dir>\server.py --port 8198` (proposal) | systemd unit only; source not in this repo. |
| props-studio | magix-system | needs-external-change | `python <dir>\server.py --port 8797` (proposal) | systemd unit only; source not in this repo. |
| szuf | magix-system | needs-external-change | `python <dir>\server.py --port 8787` (proposal) | systemd unit only; source not in this repo. |
| worldview | magix-system | needs-external-change | `python <dir>\server.py --port 8199` (proposal) | systemd unit only; source not in this repo. |

## How the external apps were checked

Only their launch recipes are visible from this repo (`systemd` or `launchctl`). Their source was not read, and their commands above are proposals, not tested.
For each one, the owner should check:
- `/healthz` exists and every URL is relative, so the app works under `/api/nodes/<node>/apps/<id>/`.
- Paths use `os.path` or `pathlib`, not `/home`, `~/.local` or `/tmp`.
- The venv python is `.venv\Scripts\python.exe` and the command is `python`, not `python3`.
- Nothing uses `systemctl`, `fork`, `SIGKILL`/`SIGTERM` handlers or Unix sockets.
Register the Windows recipe with `mesh_app_register ... launch={"linux":{"systemd":"x.service"},"windows":{"command":"...","cwd":"..."}}`.

## Not changed on purpose

- `platforms: ["linux"]` stays on the three GPU catalog entries. The CUDA stacks (torch, flash-attn, triton) are unverified on Windows, and the install should keep refusing them there until someone has run one.
- The `.service` files stay as they are. Windows uses the recipes, not a wrapper script.

## Tests

`npm test`: 336 of 337 pass. The one failure, `rig resolves outside the service PATH` in `test/hubs.test.js`, finds the real `~/.nvm` rig binary instead of the temp one. It is unrelated to this change.
