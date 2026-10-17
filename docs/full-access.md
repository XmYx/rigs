# Full access and full control

Design for project `2ed3c75b03` ("wayland, add full access, and we may add full control, has to be macOS
compatible as well"), task t1. Written 2026-10-17 from a read of the code and live probes of
`magix-system` (Ubuntu 26.04, GNOME 50 on Wayland) and `macbookpro` (macOS 26.3.1). Tasks t2–t9 build
from this document; where it disagrees with an earlier task brief, this document wins (see
[Decisions that change the task briefs](#decisions-that-change-the-task-briefs)).

Two words, used precisely throughout:

- **Full access** — RIGS and the agents it serves can *see*: the whole home (exists today), protected app data
  (macOS Full Disk Access, exists today), the **screen** and the **window list** (new).
- **Full control** — on top of that they can *act*: **pointer**, **keyboard** and **window focus** (new).

Both are **off by default on every machine** and switched on per machine (`config.control.enabled` for access,
`config.control.input` for control).

---

## 1. What RIGS can see and do today

| Area | Module | macOS | Linux (Wayland / X11) | Windows |
| --- | --- | --- | --- | --- |
| Home read/write probe | `src/access.js` `status()` | probes Documents/Desktop/Downloads/Pictures/Music/Movies/iCloud Drive (TCC-protected folders) | plain Unix permissions | detects Defender *Controlled folder access* |
| Protected app data | `src/access.js` | Full Disk Access detected by reading `~/Library/Safari` or `~/Library/Mail`; `grantFullDiskAccess()` opens `Privacy_AllFiles` and reveals the node binary in Finder | n/a | n/a |
| Admin steps | `src/rootsteps.js` | one `sudo` bundle `~/.rigs/finish-root.sh` | same | `finish-root.ps1` (UAC); CFA allow-list step |
| Shell / files | `server.js` `exec`, `files.js` → `mesh_exec`, `mesh_*_file` | full user shell | full user shell | PowerShell |
| Remote desktop **for humans** | `src/desktop.js`, `src/desktop-install.js` | Sunshine (own LaunchAgent `dev.rigs.sunshine`, its own Screen Recording + Accessibility grants), Screen Sharing/VNC, RDP client | Sunshine (`setcap cap_sys_admin` KMS, or `capture = portal` on NVIDIA+GNOME), Moonlight AppImage | Sunshine (MSI), RDP |
| Capture-permission hint | `desktop.macCapturePermission()` | greps `sunshine.log` for "No screen capture permission"; UI links `Privacy_ScreenCapture` | n/a | n/a |
| Session detection | `system.js` `linuxDesktop()` | reports `quartz` | `XDG_SESSION_TYPE` / `XDG_CURRENT_DESKTOP` from the **daemon's** env only (no compositor, portal or lock state) | reports `windows` |
| GUI env for the service | `desktop.js` `refreshSessionEnv()` / `guiEnv()` (module-private) | n/a | reads `systemctl --user show-environment`, defaults `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` | n/a |
| "Needs you" feed | `src/attention.js` + `broadcastNotify` + `osnotify.js` | Claude self-reports, OpenRig needs-input, Codex hook, pane chrome, blocked tasks; spoken + OS notification | same (`notify-send`) | same (toast) |
| UI surfaces | `ui/src/mesh.js` (access/desktop/root-step chips), `ui/src/main.js` (machine inspector line `💾 home read/write…`, remote-desktop window) | | | |

**Gaps this project fills:** no agent-usable screenshot, window list, window focus or input injection on any OS;
no permission status for screen/input/accessibility; no notion of "an agent is driving this screen" in the
attention feed; no kill switch. Sunshine injects input only for a human Moonlight viewer.

## 2. Live facts

### magix-system (probed 2026-10-17, seat `team-architecture-opus`)

| Fact | Value | How it was probed |
| --- | --- | --- |
| OS / kernel | Ubuntu 26.04.1 LTS, Linux 7.0.0-38 | `/etc/os-release`, `uname -r` |
| Session | logind session 6, seat0, `Type=wayland`, `Service=gdm-password`, active, local | `loginctl show-session` |
| Compositor | **GNOME Shell 50.1** (`gnome-shell --mode=ubuntu`), Xwayland `:0` alongside | `ps`, `gnome-shell --version` |
| Session env | `XDG_SESSION_TYPE=wayland`, `XDG_CURRENT_DESKTOP=ubuntu:GNOME`, `WAYLAND_DISPLAY=wayland-0`, `DISPLAY=:0` | `systemctl --user show-environment` |
| Daemon env | `rigs.service` (systemd --user) **has** the full session env (`WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `DISPLAY`) | `/proc/<MainPID>/environ` |
| Agent env | this OpenRig seat has **no** `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` / `WAYLAND_DISPLAY` → cannot reach the desktop | `env` in the seat |
| Portal | xdg-desktop-portal 1.21.1, backend xdg-desktop-portal-gnome 50.0 (`default=gnome;gtk`) | `dpkg -l`, `portals.conf` |
| Portal interfaces | **RemoteDesktop v2** (devices 7 = keyboard+pointer+touch), **ScreenCast v5** (sources 7, cursor modes 7), **Screenshot v2**, InputCapture v1, Clipboard, GlobalShortcuts, … | `gdbus introspect` + `Properties.GetAll` on `/org/freedesktop/portal/desktop` |
| Mutter APIs | `org.gnome.Mutter.RemoteDesktop` (Version 1, devices 7) and `org.gnome.Mutter.ScreenCast` (Version 4) on the session bus | `Properties.GetAll` |
| Mutter access | `CreateSession` on both **succeeds for a plain session-bus client, no dialog**; sessions vanish when the client disconnects | `gdbus call … CreateSession`, re-introspect |
| **Capture works** | Mutter ScreenCast `RecordMonitor(DP-1)` → PipeWire node 154 in 46 ms → `gst-launch-1.0 pipewiresrc` one frame → **3840×2160 PNG, 1.39 MB, 245 ms**, no prompt (frame deleted unseen) | probe script (python3 + gi) |
| **Input works** | Mutter RemoteDesktop `Start` + `NotifyPointerMotionRelative(0,0)` accepted, no prompt | same probe |
| RemoteDesktop session methods | `NotifyKeyboardKeycode/Keysym`, `NotifyPointerButton/Axis/AxisDiscrete/MotionRelative/MotionAbsolute`, touch, clipboard (`EnableClipboard`, `SelectionRead/Write`), `ConnectToEIS`, `SetKeymap` | `Introspect` on a live session |
| ScreenCast session methods | `RecordMonitor`, `RecordWindow`, `RecordArea`, `RecordVirtual` | same |
| Shell APIs | `org.gnome.Shell.Introspect.GetWindows` / `GetRunningApplications` → **AccessDenied**; `org.gnome.Shell.Screenshot.Screenshot` → **AccessDenied**; `org.gnome.Shell.Eval` → `(false, '')` (allow-listed / unsafe-mode only) | `gdbus call` |
| GNOME settings | `development-tools=true`; there is no `introspect` key; `toolkit-accessibility=false`; user extensions: ding, tiling-assistant, ubuntu-dock, appindicators, snapd ones | `gsettings` |
| Displays | one monitor DP-1 (Samsung) 3840×2160@60, logical monitor at 0,0 **scale 1.5**, layout mode 1 (logical) | `org.gnome.Mutter.DisplayConfig.GetCurrentState` |
| Lock state | `org.gnome.ScreenSaver.GetActive` → `false` (callable) | `gdbus call` |
| **/dev/uinput** | `crw-rw----+ root input`, ACL `user:magix:rw-` → **writable by magix** through logind *uaccess*; user is **not** in `input` | `ls -l`, `getfacl`, `id`, `test -w` |
| uinput rules | `/usr/lib/udev/rules.d/60-sunshine.rules` (`GROUP="input", MODE="0660", TAG+="uaccess"`) and `/etc/udev/rules.d/70-snap.steam.rules` (`TAG+="uaccess"`); `CONFIG_INPUT_UINPUT=y` | `grep -r uinput` in rules dirs, `/boot/config-*` |
| CLI tools | **absent:** ydotool, ydotoold, dotool, wtype, wlrctl, grim, slurp, gnome-screenshot, spectacle, xdotool, wmctrl, xwd, import, maim, scrot. **present:** gdbus, busctl, gjs, python3 3.14.4, gst-launch-1.0, pw-cli, wl-copy/wl-paste, sunshine, moonlight | `command -v` |
| Python | `gi` 3.56.2, `dbus` 1.4.0, typelibs `Atspi-2.0` and `Gst-1.0` load; GStreamer `pipewiresrc` present; no `pyatspi`, `evdev`, `Xlib` | `python3 -I -c 'import …'`, `gst-inspect-1.0` |
| AT-SPI | `org.a11y.Bus` up; 16 apps registered (gnome-shell, Chromium ×2, Discord, claude-desktop, Nautilus, gnome-text-editor, …) but **Firefox and the Unity editor are missing** → partial window list only | `Atspi.get_desktop(0)` (names only) |

### macbookpro (probed 2026-10-17, read-only, no prompts triggered)

| Fact | Value | How it was probed |
| --- | --- | --- |
| OS | macOS 26.3.1 (25D2128), Apple M1, one screen 1680×1050 pt @2x | `sw_vers`, `NSScreen` via JXA |
| Daemon | LaunchAgent `dev.rigs.mesh`, program `/Users/mix/.nvm/versions/node/v22.23.3/bin/node`; process chain launchd → node (supervisor) → node (server) → `zsh -lc` for `exec` | `launchctl print`, `ps` |
| Node signature | Developer ID Application: **Node.js Foundation (HX7739G8FX)**, hardened runtime; designated requirement `identifier node and anchor apple generic … leaf[subject.OU] = HX7739G8FX` | `codesign -dv`, `codesign -d -r-` |
| Daemon's grants today | Swift preflight run as a daemon child: `CGPreflightScreenCaptureAccess=false`, `CGPreflightPostEventAccess=false`, `CGPreflightListenEventAccess=false`, `AXIsProcessTrusted=false`; FDA probe: no; user `TCC.db` unreadable ("authorization denied") | compiled with `swiftc`, run via `mesh_exec` |
| JXA bridge | `AXIsProcessTrusted()` **works**; `CGPreflightScreenCaptureAccess`, `CGPreflightPostEventAccess`, `CGPreflightListenEventAccess` are **missing** from the bridge (stale BridgeSupport) | `osascript -l JavaScript` |
| Screen Recording heuristic | `CGWindowListCopyWindowInfo` via JXA: 38 normal-layer windows of other apps, **0 with `kCGWindowName`**, consistent with "no Screen Recording" | JXA |
| Toolchain | `/usr/sbin/screencapture`, `osascript`, `swift`, `swiftc` present (full Xcode selected); no `cliclick` | `command -v`, `xcode-select -p` |

No Windows machine was online, so the Windows column below comes from documentation and is **unverified**.

## 3. Capability matrix

Legend: ✅ works with no prompt · 🔑 needs a one-time grant/consent at the machine · ⚠️ partial · ❌ not available.

| Capability / requirement | macOS | Wayland · GNOME | Wayland · wlroots / KDE | X11 | Windows |
| --- | --- | --- | --- | --- | --- |
| **Screenshot** | 🔑 Screen Recording → ScreenCaptureKit `SCScreenshotManager` (14+) or `screencapture -x` | ✅ Mutter ScreenCast → PipeWire frame (**verified**); 🔑 portal ScreenCast (restore token) / Screenshot; ❌ `org.gnome.Shell.Screenshot` (allow-listed) | wlr: ✅ `grim` (wlr-screencopy). KDE: 🔑 portal ScreenCast/Screenshot, or `spectacle -b -n` | ✅ `XGetImage` / `import` / `xwd` | ✅ GDI `BitBlt` / `CopyFromScreen` (per-monitor DPI aware) |
| **Window list** | 🔑 `CGWindowListCopyWindowInfo` (titles need Screen Recording) + AX | ❌ `Shell.Introspect` (AccessDenied); 🔑 RIGS Shell extension (one re-login); ⚠️ AT-SPI (misses Firefox, Unity) | wlr: ✅ `swaymsg -t get_tree` / `hyprctl clients -j`. KDE: ✅ KWin scripting over D-Bus | ✅ EWMH `_NET_CLIENT_LIST` (`wmctrl -lG`) | ✅ `EnumWindows` + `GetWindowText` |
| **Focus window** | 🔑 Accessibility: `AXRaise` + `NSRunningApplication.activate` | 🔑 RIGS Shell extension (`Meta.Window.activate`) | wlr: ✅ `swaymsg '[con_id=N] focus'` / `hyprctl dispatch focuswindow`. KDE: ✅ KWin script `workspace.activeWindow = w` | ✅ `_NET_ACTIVE_WINDOW` (`xdotool windowactivate`) | ⚠️ `SetForegroundWindow` (foreground-lock rules; AttachThreadInput / Alt workaround) |
| **Pointer move/click/scroll** | 🔑 Accessibility (PostEvent): `CGEventPost(kCGHIDEventTap)` | ✅ Mutter RemoteDesktop (**verified**); 🔑 portal RemoteDesktop v2 (restore token); 🔑 uinput | wlr: ✅ `wlrctl` (virtual-pointer). KDE: 🔑 portal RemoteDesktop. Both: 🔑 uinput | ✅ XTEST (`xdotool`) | ✅ `SendInput` (not into elevated windows: UIPI) |
| **Keys / combos** | 🔑 Accessibility: `CGEventCreateKeyboardEvent` | ✅ Mutter `NotifyKeyboardKeysym` / keycode | wlr: ✅ `wtype`. KDE: 🔑 portal. Both: 🔑 uinput | ✅ XTEST | ✅ `SendInput` |
| **Type Unicode text** | ✅ (with Accessibility) `CGEventKeyboardSetUnicodeString` (layout-independent) | ✅ keysyms (+ `SetKeymap` or clipboard paste for chars missing from the layout) | wlr: ✅ `wtype` (custom keymap). uinput: ⚠️ layout-dependent keycodes → paste fallback | ✅ `xdotool type` | ✅ `KEYEVENTF_UNICODE` |
| **Lock-state check** | `CGSessionCopyCurrentDictionary` → `CGSSessionScreenIsLocked` | ✅ `org.gnome.ScreenSaver.GetActive` (**verified**) / logind `LockedHint` | KDE: `org.freedesktop.ScreenSaver.GetActive`; wlr: `swaylock`/`hyprlock` running, logind `LockedHint` | logind `LockedHint`, `xdg-screensaver` | `OpenInputDesktop` fails / `LogonUI.exe` |
| **OS permission(s)** | Screen Recording, Accessibility (FDA, Automation optional — §8) | none for Mutter (same uid); uinput needs the *uaccess* udev rule | KDE: one portal consent; wlr: none for wlr protocols; uinput rule | none (`DISPLAY` + `XAUTHORITY`) | none (interactive session) |
| **Prompt behaviour** | system prompt once per permission; human must click (synthetic input cannot toggle TCC); macOS 15+ may periodically ask to re-confirm screen capture | Mutter: none. Portal: dialog at the machine on first session, then the restore token | KDE portal: dialog once per token | none | UAC only for elevation, never needed |
| **OS-visible indicator** | menu-bar screen-recording indicator while capturing | GNOME top-bar screen-share / remote-control indicator while a Mutter session runs (its **Stop** ends the session) | compositor-dependent | none | none |
| **Isolation from agents** | real: grants live on the RIGS Control helper, not on `node` (§5) | none within the same uid: any session-bus client can call Mutter | none within the same uid | none | none |

## 4. Chosen backend per platform, with fallbacks

The **daemon owns the desktop**, never the agent. Agents call `mesh_screen` / `mesh_control`, which reach
`/api/nodes/<node>/control/*` on the target daemon. Two reasons, both confirmed by the probes:

- the systemd/launchd service runs inside the user's graphical session (full env on `magix-system`), while
  agent seats run with a stripped env and cannot reach the session bus;
- one choke point is where the gate, audit log, announcements and kill switch live (§7).

Each platform has a **helper**: a long-lived process the daemon starts when control is enabled and
stops when it is disabled or killed. Linux and Windows talk to it over stdio, macOS over a Unix socket.
The protocol is JSON lines: a request `{ "id", "op", ...args }` gets back `{ "id", "ok": true, "result" }` or
`{ "id", "ok": false, "error": { "code", "message" } }`, and the helper can send events such as
`{ "event": "closed" | "hotkey" | "locked" }`. A screenshot comes back as a path in `~/.rigs/run/shots/` (0700),
which the daemon streams and then deletes.

Selection is a pure function, `selectBackend({ platform, session, desktop, available, force })`. Its result is
`{ capture, input, windows, missing: [...] }`, and it is unit-tested with fixtures for every column above.
`config.control.backend` can force a choice (`mutter`, `portal`, `uinput`, `wlroots`, `kde`, `x11`,
`mac-helper`, `mac-jxa`, `windows`), which is how t7 tests the fallbacks on `magix-system`.

### Linux · GNOME on Wayland (magix-system)

| Need | 1st (default) | 2nd | 3rd |
| --- | --- | --- | --- |
| Capture | **Mutter ScreenCast** linked to the control session, one PipeWire stream per monitor. A frame is taken from the stream with `gst-launch-1.0 -q pipewiresrc path=<node> num-buffers=1 ! videoconvert ! pngenc ! filesink` (verified: 3840×2160 in 0.3 s cold), or from a warm in-process pipeline `… ! pngenc ! appsink` pulled through the `pull-sample` action signal (core `Gst` typelib only; GstApp is not installed) | portal ScreenCast with `persist_mode=2` + restore token in `~/.rigs/control-state.json` (one dialog at the machine) | portal Screenshot (`interactive=false`; whether GNOME prompts host apps is unverified) |
| Input | **Mutter RemoteDesktop** session linked to the ScreenCast session (`remote-desktop-session-id`): `NotifyPointerMotionAbsolute(stream, x, y)` in stream pixels = screenshot pixels; keysyms for keys and text. Verified | portal RemoteDesktop v2 with restore token | **uinput** virtual keyboard + absolute pointer (QEMU-tablet style `ABS_X/ABS_Y` + buttons), written with `fcntl.ioctl` from Python stdlib |
| Windows | **RIGS Shell extension** `rigs-control@rigs.dev` exporting `dev.rigs.Control` (`ListWindows`, `FocusWindow`) on the session bus; installed per user, active after one log-out/in | AT-SPI frames (list only, partial) | — (`focusWindow` → `unsupported` with a fix hint) |
| Helper | `scripts/control/rigs-control-linux.py` (python3 stdlib + optional `gi`: Gio, Gst, Atspi) | | |

Why Mutter first: it is the only path verified on this machine that needs no prompt and no install, it is
what the GNOME portal backend itself drives, its sessions light GNOME's own sharing indicator (a free,
unforgeable "being controlled" signal with a Stop button), and capture and input share coordinates. The risk
is that it is a private, versioned GNOME API (`Version` property: RemoteDesktop 1, ScreenCast 4 today).
`selectBackend` checks the versions and falls back to the portal when the API is missing or refuses.

### Linux · KDE Plasma on Wayland

Capture: portal ScreenCast with restore token, then `spectacle -b -n -f -o <file>`. Input: portal RemoteDesktop
with restore token, then uinput. Windows: KWin scripting over D-Bus (`org.kde.KWin /Scripting loadScript`,
the `kdotool` technique) for both list and focus. Helper: the same Python helper (Gio for D-Bus).

### Linux · wlroots (Sway, Hyprland, river …)

Capture: `grim` (`-o <output>` / `-g <geometry>`). Input: `wlrctl pointer …` plus `wtype`, then uinput.
Windows: `swaymsg -t get_tree` and `[con_id=N] focus`, or `hyprctl clients -j` and `dispatch focuswindow`.
Packages (`grim wtype wlrctl`) go through a root step. xdg-desktop-portal-wlr has no RemoteDesktop.

### Linux · X11 (any desktop, including GNOME on Xorg)

XTEST, `XGetImage` and EWMH, called through `ctypes` (`libX11`, `libXtst`) in the same Python helper, with
`xdotool`/`import` used when present. The helper needs `DISPLAY` and `XAUTHORITY` from the session env.

### macOS

| Need | 1st (default) | Fallback (opt-in) |
| --- | --- | --- |
| Capture | **RIGS Control.app** helper: ScreenCaptureKit `SCScreenshotManager.captureImage` (macOS 14+), else `screencapture -x -t png [-D n] [-l windowid] [-R x,y,w,h]` spawned by the helper | `config.control.backend = "mac-jxa"`: `screencapture` spawned by the daemon (grant on `node`) |
| Input | helper: `CGEventCreateMouseEvent` / `CGEventCreateKeyboardEvent`, `CGEventKeyboardSetUnicodeString`, `CGEventPost(kCGHIDEventTap)`; points = pixels ÷ backing scale | JXA via `osascript -l JavaScript` (CGEvent through the ObjC bridge) on node's grants |
| Windows | helper: `CGWindowListCopyWindowInfo` (id, owner, pid, bounds, title) + AX (`AXUIElementCreateApplication` → `kAXWindowsAttribute` → `AXRaise`, `kAXMainAttribute`) + `NSRunningApplication.activate` | System Events via JXA (needs Automation **and** Accessibility) |
| Helper | `scripts/control/macos/RigsControl.swift` compiled with `swiftc` into `~/.rigs/bin/RIGS Control.app` (bundle id `dev.rigs.control`, ad-hoc signed), run as its **own LaunchAgent** `dev.rigs.control` (`ProcessType Interactive`, `LimitLoadToSessionType Aqua`), socket `~/.rigs/run/control.sock` (0600) + per-start token `~/.rigs/run/control.token` (0600) | |

Why a separate helper app. TCC attributes a request to the **responsible process**. For a launchd job that is
the job's own executable, and fork/exec children inherit it. So without a helper, every grant would land on
`/Users/mix/.nvm/versions/node/v22.23.3/bin/node`, which has three consequences:
- every agent and shell RIGS spawns could capture the screen and post events (`screencapture` from `mesh_exec`),
  which defeats "off by default";
- the grant is keyed to a versioned nvm path, so the next Node upgrade silently drops it;
- System Settings lists it as "node".

A helper app launched as its own LaunchAgent is its own responsible process. It shows as "RIGS Control", its
grants survive Node and RIGS updates, and while control is off it is not even loaded (`launchctl bootout`).
Sunshine already follows this model on the Mac (`dev.rigs.sunshine` holds its own grants). t6 verifies the
inheritance rule on macbookpro.

Signing caveat: with no Developer ID, the helper is ad-hoc signed, so TCC pins its grant to the **cdhash**.
RIGS rebuilds it **only when the Swift source hash changes**, and records the hash in
`~/.rigs/control-state.json`. When the hash changes, status says "helper updated — re-grant", and the grant
flow runs `tccutil reset ScreenCapture dev.rigs.control` and `tccutil reset Accessibility dev.rigs.control`
first; that only resets RIGS's own entries. A self-signed local code-signing identity or a Developer-ID-signed
CI build would make grants survive rebuilds; that is optional later work. With no `swiftc` (no Command Line
Tools), status gives the fix "run `xcode-select --install`", and the user may opt into `mac-jxa` knowing the
grant then covers all of `node`.

### Windows (unverified — no Windows node online)

Helper: a persistent `powershell.exe -NoProfile` running `scripts/control/rigs-control.ps1`, which loads a C#
class with `Add-Type` (built into Windows PowerShell 5.1, no toolchain). The class does
`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`, `EnumDisplayMonitors`, `BitBlt`/`CopyFromScreen`,
`SendInput` (Unicode text via `KEYEVENTF_UNICODE`), `EnumWindows`/`GetWindowText`/`GetWindowThreadProcessId`
and `SetForegroundWindow` with the `AttachThreadInput` workaround. RIGS runs as a logon Scheduled Task in the
interactive session, so no permission is needed. Hard limits: no input into elevated windows (UIPI), no
access to the secure desktop (UAC prompt, Ctrl+Alt+Del, lock screen), and a disconnected RDP session renders
black. If the helper fails to load, every call returns `unsupported` with the reason, and nothing hangs.

## 5. Module layout

```
agent ──MCP mesh_screen / mesh_windows / mesh_control / mesh_access──▶ local daemon
   (x-rigs-caller: {agent, session, seat, cwd})                         │ /api/nodes/<target>/control/*
                                                                         ▼  (proxy adds x-rigs-via)
target daemon: src/server.js routes ─▶ src/control.js  gate · lease · audit · announce · selectBackend
                                         │
                       ┌─────────────────┼──────────────────┐
             src/control-linux.js   src/control-mac.js   src/control-win.js     (adapters: start/stop helper, map ops)
                       │                 │                   │
     scripts/control/rigs-control-   RIGS Control.app     scripts/control/
     linux.py (+ gnome-extension/)   (LaunchAgent,        rigs-control.ps1
                                      unix socket)
```

- `src/control.js` is the public API (§6). It also holds the policy (§7) and the pure `selectBackend`.
- `src/control-{linux,mac,win}.js` start the helper, restart it once if it crashes, and translate ops.
- `src/access.js` (t2) owns the permission probes and grant helpers, and `control.status()` embeds its result.
- `refreshSessionEnv()` / `guiEnv()` move out of `desktop.js` into an exported helper so that `desktop.js` and
  `control-linux.js` share them. The daemon may have started before login (systemd linger), so its own env
  can lack `WAYLAND_DISPLAY`; always re-read it from the user manager.
- Helper sources live under `scripts/control/`. They are data files to the Node code, which spawns or builds
  them; nothing in `src/` gains a native dependency.

## 6. `src/control.js` API

All functions are async and take a `caller` that the server builds from `req.rigsAuth`, `x-rigs-via` and
`x-rigs-caller`: `{ via, who, from, agent, session, seat, cwd, human }`. Failures throw `ControlError`
`{ code, status, message, fix? }`, and the server sends that as the HTTP status with a JSON body.

| `code` | HTTP | When |
| --- | --- | --- |
| `off` | 403 | `control.enabled` is false (also after a kill; `killed` is then set in status) |
| `input-off` | 403 | input op while `control.input` is false |
| `not-allowed` | 403 | caller's node not in `control.allowFrom`, or an agent tried `enable` |
| `busy` | 409 | another caller holds the lease |
| `locked` | 423 | the screen is locked: never type into a lock screen |
| `rate` | 429 | over `maxActionsPerMin` / `maxShotsPerMin` |
| `needs-permission` | 412 | backend not ready; `fix` says what to do |
| `unsupported` | 501 | no backend for this op on this desktop |
| `no-session` | 503 | no graphical session (headless, logged out) |
| `timeout` | 504 | helper did not answer within 10 s (op aborted, held keys/buttons released) |
| `bad-args` | 400 | validation |

```js
/** Everything a UI or agent needs to decide what is possible. Cheap; cached 5 s unless force. */
export async function status({ force = false } = {}) → {
  node, platform: 'linux' | 'mac' | 'windows',
  session: 'wayland' | 'x11' | 'quartz' | 'windows' | 'none',
  desktop: 'gnome' | 'kde' | 'sway' | 'hyprland' | 'wlroots' | 'other' | '',
  enabled, input,                       // config.control.enabled / .input
  killed: { at, by, reason } | null,
  backend: { capture, input, windows, helper: { kind, version, running, pid } },
  permissions: {                        // shared shape with access.status() (t2)
    screenCapture, input, accessibility, automation, fullDiskAccess,
    // each: { ok: true | false | null, backend, detail, fix: { kind, title, url?, command?, rootStep? } | null }
  },
  ready: { see: boolean, act: boolean },
  displays: [{ id, name, x, y, width, height, scale, primary }],  // width/height = full-resolution screenshot pixels
  locked: boolean | null,
  lease: { holder: caller, since, lastAt, actions } | null,
}

/** One display, one window or a region. maxWidth downscales (agents: 1568). */
export async function screenshot({ display, window, region /* {x,y,width,height} */, maxWidth, format = 'png', quality = 80 } = {}, caller)
  → { shot, mime, data /* Buffer */, width, height, display, scale /* display px per image px */, region, at }

export async function listWindows(caller)
  → [{ id, title, app, pid, display, bounds: { x, y, width, height }, focused, minimized }]
  // id is opaque per backend: GNOME extension window id, CGWindowID, X11 XID, HWND (hex), AT-SPI path

export async function focusWindow(id, caller) → { ok, id, title }

/** action: move | click | down | up | scroll | drag. button: left | right | middle. count: 2 = double-click. */
export async function pointer({ action = 'move', x, y, display, shot, button = 'left', count = 1, dx = 0, dy = 0, to }, caller)
  → { ok, x, y, display }
  // scroll: dx/dy in wheel notches, +dy = down; drag: press at (x, y), move to `to`, release

/** Unicode text, max 4000 chars per call. secret: true keeps the text out of audit and feed. */
export async function typeText(text, { delayMs = 0, secret = false } = {}, caller)
  → { ok, typed, via: 'unicode' | 'keysym' | 'paste' }

/** combo: '+'-joined, case-insensitive: 'ctrl+shift+t', 'mod+c', 'alt+f4', 'enter', 'cmd+space'. */
export async function key(combo, { repeat = 1 } = {}, caller) → { ok, combo }

export async function enable({ enabled, input, confirm }, caller) → status   // §7 "Who may switch it on"
export async function kill({ reason = '' } = {}, caller) → { ok, wasEnabled, stopped: [...] }
export function selectBackend({ platform, session, desktop, available, force }) → { capture, input, windows, missing }  // pure
export function auditTail({ limit = 50 } = {}) → [line]
export const events;  // EventEmitter: 'action', 'lease', 'kill', 'change'
```

**Coordinates.** `x, y` are pixels **on one display** (default: primary), in the space of a full-resolution
screenshot of that display. On GNOME that is the Mutter stream space, so no conversion is needed. On macOS the
helper divides by the backing scale to get points. On Windows the helper is per-monitor DPI-aware and adds the
monitor origin. When an agent works from a downscaled shot, it passes `shot: <id>` and gives `x, y` in that
image. The daemon keeps the last 20 shot transforms for 5 minutes, so "click what you see" stays exact.

**Keys.** Modifiers are `ctrl`, `alt` (= `option`), `shift`, `super` (= `cmd` = `win` = `meta`, the
platform's logo/command key) and `mod` (`cmd` on macOS, `ctrl` elsewhere, for portable shortcuts). Named keys
are `enter`/`return`, `tab`, `esc`, `space`, `backspace`, `delete`, `insert`, `up`, `down`, `left`, `right`,
`home`, `end`, `pageup`, `pagedown`, `f1`–`f24`, `capslock`, `printscreen`, `menu`, and any single character.
Every `down` is paired with an `up`: helpers track what they hold and release it all on error, timeout and kill.

**HTTP (t4)** — `/api/local/…` on the machine itself and `/api/nodes/<id>/…` through the proxy:

| Route | Maps to |
| --- | --- |
| `GET control` | `status()` |
| `GET control/screenshot?display=&window=&region=x,y,w,h&maxWidth=&format=` | `screenshot()`: body is the image; headers `x-rigs-shot`, `x-rigs-scale`, `x-rigs-display` |
| `GET control/windows` | `listWindows()` |
| `POST control/focus {id}` | `focusWindow()` |
| `POST control/pointer {…}` | `pointer()` |
| `POST control/type {text, delayMs, secret}` | `typeText()` |
| `POST control/key {combo, repeat}` | `key()` |
| `POST control/enable {enabled, input, confirm}` | `enable()` |
| `POST control/kill {reason}` | `kill()` |
| `POST control/grant {permission}` | `access.grant*()` (opens the pane / queues the root step on that machine) |
| `GET control/audit?limit=` | `auditTail()` |
| `POST /api/mesh/control/kill {reason}` | `kill()` on every online node ("hands off everywhere") |

**MCP (t4)**:
- `mesh_screen {node, display?, window?, maxWidth? = 1568}` returns an **image content block** plus text
  `{shot, scale, display}`. `startMcp` has to pass through a tool result that already has `content`.
- `mesh_windows {node}`.
- `mesh_control {node, action: move|click|double|right|scroll|drag|type|key|focus, x?, y?, shot?, display?, dx?, dy?, to?, text?, secret?, combo?, id?}`.
- `mesh_access {node, grant?}` returns status and runs one grant step.
- There is **no MCP tool that enables control**. `mcp.js` sends `x-rigs-caller` on every request:
  `{ agent: 'claude' | 'codex' | …, session, seat: $OPENRIG seat if any, cwd, pid }`.

## 7. Safety model

### Defaults and config

```jsonc
"control": {
  "enabled": false,        // full access: screenshots + window list. Master switch; kill sets it false.
  "input": false,          // full control: pointer, keys, typing, focus. Needs enabled.
  "backend": "auto",       // or force one (§4)
  "allowFrom": [],         // node names whose agents/UIs may use it; [] = any authorized mesh member
  "leaseIdleSec": 60,      // a controller's lease ends after this long without an action
  "maxActionsPerMin": 120,
  "maxShotsPerMin": 30,
  "announce": "lease",     // speak at lease start/end ("every" = speak each action); the feed always shows every action
  "killHotkey": "default", // per OS, see below; "" disables
  "auditPreview": 64       // chars of typed text kept in the audit line (0 = none)
}
```

- `control` joins `nodeId`, `meshToken` and `desktop` in `patchConfig`'s blocked set, so a generic settings
  save, or an agent's `POST config`, cannot switch it on. It is exposed read-only in `publicConfig()`.
- Volatile state lives in `~/.rigs/control-state.json` (0600): `killedAt/By/reason`, the portal restore token
  and the macOS helper hash.
- No migration turns anything on. Defaults come from `config.js` `defaults()`, so every existing machine is
  off after the update. Root steps and the GNOME extension are registered only when someone enables control
  on that machine, never at update time.

### Who may switch it on

`enable()` is the only way to set `enabled`/`input` to true:
- The request must come from a **human surface**: the JARVIS UI on any machine, which proxies to the target,
  or `rigs control on [--input]` in an interactive terminal on the target. The CLI refuses without a TTY, so it
  does not work through `mesh_exec`.
- Requests that carry `x-rigs-caller` (the MCP marker) are refused with `not-allowed`.
- The body must contain `confirm: <the target machine's name>`; the UI asks the user to type or click it.
- Every enable is announced at once: spoken to every open UI, a native notification on the target, and an
  audit line.

Disabling and kill are open to every authorized caller, agents included.

Threat model, stated plainly: everything in the mesh is one owner's machines. Every authorized caller already
has `mesh_exec` (a full user shell), and agents run as the same uid. So no API check can *prove* a human, and
on Linux nothing stops a same-uid process from calling Mutter or `/dev/uinput` directly. The gate guards
against **accidents and unsanctioned use**, not a malicious local process. It makes every enable and action
**visible and attributable**, and a kill is always one click or one hotkey away. macOS is the exception: with
the grants on the helper, agents genuinely cannot capture or inject without going through RIGS.
`magix-system` already lets the logged-in user write `/dev/uinput` (from the Sunshine and Steam udev rules),
so any user process can already inject input there today.

### The gate (every call, in this order)

1. `enabled` (and `input` for act ops), else `off` / `input-off`.
2. `allowFrom`, else `not-allowed`.
3. **Lease**: one controller per machine. The first caller becomes the holder (key = from + agent + session).
   Others get `busy` with the holder named. The lease ends after `leaseIdleSec`, on kill, or when a human in
   the UI presses **Take over**.
4. **Lock screen**: act ops are refused with `locked`, and screenshots of a locked screen are refused too.
5. **Rate limits**: `rate`.
6. **Backend ready**, else `needs-permission` with `fix`.
7. **Run** with a 10 s timeout. On timeout or error, the helper releases everything it holds.
8. **Audit and announce**, for refusals as well as successes.

### Audit log

`~/.rigs/logs/control.jsonl`, mode 0600, append-only. It rotates at 5 MB (`.1`, `.2` kept). One line per call:

```json
{"ts":"2026-10-17T10:41:07.512Z","node":"magix-system","op":"type","ok":true,"ms":184,
 "caller":{"via":"token","from":"macbookpro","agent":"claude","seat":"team-code@rig-x","cwd":"~/proj"},
 "args":{"length":18,"preview":"hello from JARVIS "},"lease":"c-7f3a","backend":"mutter"}
```

- Screenshots log display, window, region and dimensions, never pixels.
- `secret: true` text logs `length` only.
- Coordinates and combos are logged verbatim.
- Refusals log `ok: false` with the error code.

### Announcements (the attention feed)

- **Lease start**:
  - `broadcastNotify({ level: 'attention', speak: true })`, e.g. "Claude on macbookpro is taking control of
    magix-system's screen", or "…is looking at…" when input is off;
  - `osNotify` on the controlled machine.
- **While a lease is held**:
  - `attention.list()` includes an item
    `{ key: 'control:<node>', kind: 'control', agent, title: 'JARVIS is controlling this screen' | 'JARVIS is watching this screen', reason: '<last action>', since, actions, session, stop: { method: 'POST', path: 'control/kill' } }`;
  - it blinks the machine's planet and appears in `/api/mesh/attention` everywhere;
  - the UI renders a **■ Stop** button on it (t5).
- **Every action**: a WebSocket event `{ type: 'control', node, op, summary, by }`, shown live in the
  Access & Control panel and not spoken unless `announce: 'every'`.
- **Lease end**: a short notify ("…released control after 23 actions").
- **OS indicators** come for free: on GNOME, Mutter sessions light the top-bar sharing/remote-control
  indicator; on macOS, capture lights the menu-bar recording indicator; Windows has none, hence the toast.

### Kill switch

`kill()` does the following:
1. sets `enabled = false` and `input = false` and records who, when and why;
2. ends the lease and aborts the in-flight op;
3. makes the helper release all held keys and buttons;
4. stops the backend sessions: Mutter `Stop`, the portal session closed, the macOS LaunchAgent booted out;
5. announces "Control of <node> stopped by <who>".

It **persists across restarts**, and only `enable()` from a human surface undoes it. Ways to trigger it:

| Where | How |
| --- | --- |
| Any JARVIS UI | **■ Stop** on the attention item or panel; **✋ Hands off** in Mesh control (all machines); voice "hands off" / "stop control" |
| API / agents | `POST control/kill`, `POST /api/mesh/control/kill` |
| The machine itself | `rigs control off` (also works with the daemon down: edits config and kills the helper by pidfile) |
| Hotkey on the machine | GNOME/KDE: a custom shortcut **Super+Shift+Esc** → `rigs control off`, added via `gsettings` custom keybinding when control is enabled and removed when disabled. macOS: **⌃⌥⌘⎋** registered by the helper with Carbon `RegisterEventHotKey` (no Input Monitoring needed). Windows: `RegisterHotKey` in the helper. `control.killHotkey` overrides |
| GNOME indicator | **Stop** on the top-bar sharing indicator closes the Mutter session; the helper's `closed` event is treated as a kill |

### Agent rules (t8 writes them into `setup.js` instructions and AGENTS.md)

- Control is opt-in per machine. Agents never enable it and never work around the gate: no `screencapture`,
  `grim` or uinput from a shell when `mesh_screen` / `mesh_control` exist.
- Ask Sir before using computer control, unless the task brief explicitly authorizes it for that machine.
- Pass `secret: true` when typing anything credential-like; better still, do not type credentials at all.

## 8. Permission-grant flow

`control.status().permissions` (backed by `access.status()`, t2) gives each permission
`ok: true | false | null` (`null` = cannot tell) and a `fix`. The UI renders the fix as a button that calls
`POST control/grant {permission}` on that machine. Grants are only offered once control has been enabled
there, or when the user asks for them from the panel.

### Linux

| Permission | Detect | Fix (kind) |
| --- | --- | --- |
| Session reachable | session bus at `$XDG_RUNTIME_DIR/bus` answers; `XDG_SESSION_TYPE` from `systemctl --user show-environment` | `relogin` if no graphical session |
| GNOME capture + input | `org.gnome.Mutter.ScreenCast`/`RemoteDesktop` on the bus with `Version` ≥ 4 / ≥ 1, plus `gi`, `Gst` and `pipewiresrc` import | `rootstep` `apt-get install -y python3-gi gir1.2-gstreamer-1.0 gir1.2-atspi-2.0 gstreamer1.0-pipewire` (all four present on magix-system; `gir1.2-gst-plugins-base-1.0`, which provides GstApp/GstVideo, is **not**, so the helper must not need it) |
| GNOME windows | `dev.rigs.Control` on the session bus | `extension`: copy `scripts/control/gnome-extension/rigs-control@rigs.dev` to `~/.local/share/gnome-shell/extensions/`, `gnome-extensions enable rigs-control@rigs.dev`; then `relogin` ("log out once"). No root |
| KDE portal | portal `RemoteDesktop.version ≥ 2`; restore token stored | `consent`: first session shows the KDE dialog at the machine; status shows "approve on <node>" |
| uinput (fallback input) | `fs.accessSync('/dev/uinput', W_OK)` | `rootstep` `uinput`: write `/etc/udev/rules.d/60-rigs-uinput.rules` = `KERNEL=="uinput", SUBSYSTEM=="misc", OPTIONS+="static_node=uinput", TAG+="uaccess"`, `echo uinput > /etc/modules-load.d/rigs-uinput.conf`, `modprobe uinput`, `udevadm control --reload-rules && udevadm trigger --name-match=uinput` |
| wlroots tools | `which grim wtype wlrctl` | `rootstep` `apt-get install -y grim wtype wlrctl` |
| X11 | `DISPLAY` + `XAUTHORITY` from the session env; `libXtst` loadable | `rootstep` `apt-get install -y libxtst6` (rarely missing) |

On uinput, use **`TAG+="uaccess"`**, never membership of the `input` group. `uaccess` gives the logged-in seat
user write access to `/dev/uinput` only. The `input` group also grants **read** access to every
`/dev/input/event*`, which amounts to a system-wide keylogger. Root steps go through `rootsteps.add()`, so the
user types one password: `tryUnattended()` runs them when sudo needs none, otherwise JARVIS offers "Finish
setup" in a terminal on that machine.

### macOS

Each permission has a System Settings deep link. RIGS already uses this URL form for FDA and Screen Recording.
t6 re-checks every anchor on macOS 26; the Ventura+ form
`x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_<X>` is the fallback.

| Permission (TCC service) | Needed for | System Settings pane URL | How RIGS detects it | How RIGS requests it |
| --- | --- | --- | --- | --- |
| **Screen Recording** (`kTCCServiceScreenCapture`) | screenshots; window titles | `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` | helper: `CGPreflightScreenCaptureAccess()`. JXA fallback: `CGWindowListCopyWindowInfo` shows `kCGWindowName` for other apps' windows only when granted (verified: 0 of 38 without it) | helper calls `CGRequestScreenCaptureAccess()` (system prompt, once), then `open <url>` + `open -R "~/.rigs/bin/RIGS Control.app"`; after the switch is on, `launchctl kickstart -k gui/<uid>/dev.rigs.control` (capture rights apply to new processes) |
| **Accessibility** (`kTCCServiceAccessibility`, includes PostEvent) | pointer, keys, typing (`CGEventPost`); AX window list, raise, focus | `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` | helper: `AXIsProcessTrusted()` and `CGPreflightPostEventAccess()`. JXA: `AXIsProcessTrusted()` (verified bridged) | helper: `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true})` (prompt + adds the entry), then `open <url>` |
| **Full Disk Access** (`kTCCServiceSystemPolicyAllFiles`) | full *file* access (Mail, Safari, Messages data). Not needed for control | `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` | existing `access.js`: `readdir ~/Library/Safari` or `~/Library/Mail` | cannot be requested in code: existing `grantFullDiskAccess()` opens the pane and reveals `process.execPath` (FDA belongs on the daemon's `node`, because agents need the files) |
| **Automation → System Events** (`kTCCServiceAppleEvents`) | only the `mac-jxa` fallback's window list/focus. Not needed by the helper | `x-apple.systempreferences:com.apple.preference.security?Privacy_Automation` | helper: `AEDeterminePermissionToAutomateTarget(com.apple.systemevents, typeWildCard, typeWildCard, askUserIfNeeded: false)` → `noErr` / `errAEEventNotPermitted (-1743)` / `errAEEventWouldRequireUserConsent (-1744)` | the first Apple Event prompts; there is no way to pre-add the entry, so it is only triggered from an explicit Grant click |
| Input Monitoring (`kTCCServiceListenEvent`) | **not needed**: RIGS never reads the user's input, and the kill hotkey uses `RegisterEventHotKey` | `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent` | `CGPreflightListenEventAccess()` (reported only) | — |
| Files & Folders | existing home probe | `x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders` | existing `access.js` folder probes | prompt on first access |

Notes for the macOS flow:
- **A human must be at the Mac.** TCC prompts and switches ignore synthetic input, so the panel shows
  "Waiting for you on macbookpro: switch on *RIGS Control* in Screen Recording and Accessibility" until the
  preflight turns true. Status polls every 3 s while the panel is open.
- **Build step**: `swiftc -O RigsControl.swift -o "RIGS Control.app/Contents/MacOS/rigs-control"` with
  `-framework ScreenCaptureKit -framework ApplicationServices`, an `Info.plist` with `CFBundleIdentifier`
  `dev.rigs.control` and `LSUIElement` true, then `codesign --force --sign - --identifier dev.rigs.control`.
  `swiftc` is present on macbookpro; elsewhere the fix is `xcode-select --install`.
- **macOS 15+** may periodically ask to re-confirm screen capture for apps that capture outside the system
  picker. That needs a human, and status reports it as `screenCapture.ok = false` with the same fix.
- **Grants stay on the right binary**: the daemon (`node`) keeps only FDA. Screen Recording and Accessibility
  go to RIGS Control. If a user has granted them to `node` (old manual setups), status warns: "node has screen
  access — every agent can bypass the control gate; remove node from Screen Recording/Accessibility".

### Windows

There are no grants. Status reports `ok: true` for capture and input when the helper loads. It reports
`input.detail = "elevated windows are out of reach"` when the foreground window belongs to an elevated
process, and `no-session` when the input desktop is not the default desktop (locked, UAC).

## 9. Setup steps per OS

Control stays off until someone switches it on. Enabling is done from JARVIS (the 🛡 Access & control panel,
or the machine inspector) with the machine's name typed as confirmation. An agent cannot do it. Disabling is
`rigs control off` on the machine, or **Stop** in any JARVIS.

### Linux · GNOME on Wayland (magix-system, GNOME 50)

1. Turn on **Screen access**. The panel shows what is missing and which step fixes it.
2. Grant the **GNOME capture + input** step. It installs `python3-gi`, `gir1.2-gstreamer-1.0`, `gir1.2-atspi-2.0`
   and `gstreamer1.0-pipewire` through a root step, so the user types one password in JARVIS.
3. Grant the **GNOME windows** step. It copies `scripts/control/gnome-extension/rigs-control@rigs.dev` to
   `~/.local/share/gnome-shell/extensions/` and runs `gnome-extensions enable rigs-control@rigs.dev`. No root.
4. Log out once (the **relogin** step), so GNOME Shell loads the extension.
5. Turn on **Full control** if you want input. Input uses Mutter RemoteDesktop. `uinput` is only a fallback.

### Linux · KDE Plasma on Wayland

1. Turn on **Screen access**, then **Full control**.
2. The first session shows the KDE portal dialog on the machine itself. Approve it there. The restore token is kept
   in `~/.rigs/control-state.json`, so later sessions do not ask again. Status reads "approve on <node>" until then.

### Linux · wlroots (Sway, Hyprland, river)

1. Grant the **wlroots tools** step (`grim`, `wtype`, `wlrctl`) through a root step.
2. Grant **uinput** (fallback input). Its rule is `TAG+="uaccess"`, never membership of the `input` group. The
   `input` group can read every `/dev/input/event*`. The rule file is `/etc/udev/rules.d/60-rigs-uinput.rules`, and
   the module loads from `/etc/modules-load.d/rigs-uinput.conf`.
3. Turn on **Full control**. Windows come from `swaymsg`, `hyprctl` or AT-SPI, whichever is installed.

### Linux · X11 (any desktop)

1. Confirm `DISPLAY` and `XAUTHORITY` are set in the user session, then grant **X11** (`libxtst6`) if it is missing.
2. Turn on **Screen access**, then **Full control**. Capture uses `import` or `scrot`. Input uses `xdotool`.
   Windows use `wmctrl` and `xdotool`.
3. Session type is read from `XDG_SESSION_TYPE` only when it is `wayland` or `x11`. Any other value, such as `tty`
   over SSH, falls back to `WAYLAND_DISPLAY` or `DISPLAY` (fixed in 38cd719).

### macOS (macbookpro, not verified end to end)

The macOS helper is **not built yet**. Until it is, `control.status()` reports every backend as null with
`ready: false`. Screenshot, key and type fail closed with `needs-permission: RIGS Control helper is not installed
or running`, and kill still works. Verified on macbookpro (arm64, node 26.12.0): `npm test` passes, with 1 expected skip.

Once the helper exists, the steps are:

1. Build `RIGS Control.app` from `scripts/control/macos/RigsControl.swift` (`swiftc -O`, with ScreenCaptureKit
   and ApplicationServices). Give it the bundle id `dev.rigs.control` and `LSUIElement` true, then ad-hoc sign it.
   Install the LaunchAgent `dev.rigs.control`. Its socket and token live under `~/.rigs/run`.
2. A human at the Mac grants **Screen Recording** and **Accessibility** to **RIGS Control**. Synthetic input cannot
   click those prompts. The panel shows "Waiting for you on macbookpro" until the preflight is true.
3. Restart the helper with `launchctl kickstart -k gui/<uid>/dev.rigs.control`, so the new capture rights apply.
4. Keep **Full Disk Access** on the daemon's `node`, not on RIGS Control. Screen Recording and Accessibility must not
   be granted to `node`, or every agent bypasses the gate. Status warns when this happens.
5. Re-run the macOS checks: ScreenCaptureKit capture, CGEvent input, window list and focus, the grant flow, lock
   detection, helper stop, and the ⌃⌥⌘⎋ kill hotkey. Live screen driving on macbookpro needs Sir's explicit OK.

### Windows (unverified)

No Windows node was online for t6 or t7. Setup is the `scripts/control/rigs-control.ps1` helper, with no grants
required. Status reports `input.detail = "elevated windows are out of reach"` for elevated foreground windows, and
`no-session` on the locked or UAC desktop. Treat the whole path as unverified until a Windows node runs it.

## Decisions that change the task briefs

1. **GNOME uses Mutter directly, the portal is the fallback** (t3, t7). On GNOME 50, Mutter ScreenCast and
   RemoteDesktop work with no prompt (verified), while `grim`, `gnome-screenshot`, `ydotool` and `xdotool` are
   not installed and `org.gnome.Shell.Introspect` / `Screenshot` are AccessDenied. t7's restore-token check
   applies to the forced `portal` backend (`config.control.backend = "portal"`), where the KDE path also lives.
2. **Window list/focus on GNOME is a RIGS Shell extension**, with AT-SPI as a partial list-only fallback
   (t3, t2). Shell introspection is not available.
3. **uinput access is a `uaccess` udev rule, never the `input` group** (t2).
4. **macOS uses a dedicated RIGS Control.app helper with its own grants**, AX instead of System Events, and no
   Automation permission (t2, t3, t6). JXA on `node` is an explicit opt-in fallback.
5. **Config is `control.enabled` (full access) + `control.input` (full control)**, both false (t3, t4, t5). The UI
   toggle (t5) calls `POST control/enable` with `confirm`, not the generic config patch, and MCP has no enable
   tool (t4).
6. **The kill switch persists** and only a human surface re-enables (t4, t5).
