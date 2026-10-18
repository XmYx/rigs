# Control module: integration and verification (t3)

Task `t3`, project `2ed3c75b03`, 2026-10-17. Public API: `src/control.js`.

The default instance uses the current configuration and `RIGS_HOME`. `createControl()` accepts isolated
configuration, a clock, permission probes and an adapter for tests. The adapter owns platform operations;
the public module owns authorization, the lease, deadlines, rate limits, screenshot transforms and audit.
Configuration defaults were off during t3; since project d902921162 control is on by default (docs/full-access.md §7).
This task never enabled the installed daemon's control configuration.

## Integration contracts for t4–t6

- All API errors carry `code`, `status`, `message`, and optionally `fix` (`ControlError`).
- `enable({enabled,input,confirm}, caller)` accepts a grant only when `caller.human === true`, there is no
  agent/MCP marker, and `confirm` is exactly the configured machine name. The HTTP layer must derive
  `caller` from authenticated request provenance, not merge fields from the request body into it.
- Agents can disable or kill. Kill persists both disabled configuration and an independent kill marker
  in `control-state.json`; an external configuration edit cannot clear the marker.
- Operations are serialized. Every helper request checks revocation before and after awaiting its reply.
  Kill rejects the running API operation immediately, invalidates already queued actions, releases the
  lease and stops the adapter. An expired lease releases held input before admitting a new holder.
- `events` emits `action` (the audit record), `lease` (`phase: start|end`, `holder`, timestamps and action
  count), `change` (enabled/input/caller) and `kill` (at/by/reason/wasEnabled). The server/attention work in
  t4/t5 must connect these to WebSocket broadcasts, native notifications, spoken announcements and the
  attention feed. This module does not import or start an HTTP server.
- Audit: `RIGS_HOME/logs/control.jsonl`, mode 0600, rotated at 5 MiB with `.1` and `.2`. Successes and
  refusals are logged. Screenshot bytes are never logged; `secret: true` logs text length only, including
  on helper errors. The required audit destination is opened before touching the desktop.
- Private screenshots are created under `RIGS_HOME/run/shots` (0700), read from the daemon-selected path,
  then deleted. The last 20 transforms expire after five minutes. `scale` is **full-resolution display
  pixels per returned image pixel**, and region origins are included when transforming input coordinates.
- Platform helpers speak JSON lines `{id,op,...args}` / `{id,ok,result}` or `{id,ok:false,error}`. **`id` is
  reserved for correlation. Focus uses `windowId`.** Input is never replayed after an ambiguous failure.
- Linux/Windows use stdio. macOS uses `RIGS_HOME/run/control.sock`, with `token` from
  `RIGS_HOME/run/control.token` in every request. The macOS helper install/start/LaunchAgent/TCC flow is
  t6 work. Its `probe` reply should include `locked`, `displays`, and helper-owned `permissions` so node's
  unrelated TCC grants do not decide whether the independent helper may act.
- Helper operations: `probe`, `locked`, `shot {file,display?,window?,region?,maxWidth?,format,quality}`,
  `windows`, `focus {windowId}`, `move {x,y,display?}`, `button {button,down}`, `scroll {dx,dy}`,
  `key {key,down}`, `type {text,delayMs}`, `release`, and `stop`. Linux also receives `configure` with
  selected backends, known displays and the portal restore token. Helpers may emit `closed`, `hotkey`,
  `locked`, or `restore-token` events; the first three kill control, the last persists the token. The transport
  emits `exit` when a helper process goes away on its own (crash, logout): that ends the lease, it is not a kill.

## Verification evidence

- `node --test test/control.test.js`: policy, selection across all platform families, secret redaction,
  lock refresh, rates, leases, transforms, key release, immediate kill, queued cancellation, helper timeout,
  literal/stdin subprocess arguments, command abort, macOS authenticated socket protocol, and Linux
  downscale/non-ASCII regression checks. These use fixtures/injected runners and do not control a desktop.
- `npm test`: the initial sandbox run failed the existing home-writability smoke test (home was read-only
  under that sandbox). The final approved outside-sandbox rerun passed **157/157**, zero failures/skips,
  including **21 control tests**. Output: `/tmp/rigs-control-npm-test-full.log`.
- Live on `magix-system`, GNOME 50.1 / Wayland, isolated `RIGS_HOME=$PWD/.rigs-dev/control-proof-*`:
  - Mutter capture: 3840×2160 full-resolution PNG, then 1568×882 downscaled PNG. Non-blank image inspected.
  - Screenshot pixels and the helper's `sourceWidth` agree after fixing the logical/physical-size mix-up.
    Mutter's `Parameters.size` is 2560×1440 at scale 1.5; its actual PipeWire image is 3840×2160.
  - `listWindows()` found the temporary GTK scratch window through AT-SPI and confirmed it was focused.
  - `pointer({action:'click',x:800,y:474,shot})` using the downscaled shot reached the scratch entry.
    `key('ctrl+a')` then `typeText('RIGS Wayland control proof 2026-10-17')` produced that **exact string**
    in the scratch application's own output file (37 characters). The after screenshot was inspected.
  - Private evidence, deliberately not committed: `/tmp/rigs-control-shot.png`,
    `/tmp/rigs-control-full.png`, `/tmp/rigs-control-typed.png`,
    `/tmp/rigs-control-scratch-text.txt`. Screenshots may contain other desktop applications.
  - Every isolated run finished by calling `kill()`; no production enable or system setting change.

## Known limits and the failed Unicode experiment

**At 10:57:50 local time (08:57:50Z), an experimental Mutter `SetKeymap` Unicode call coincided with a
GNOME Shell core dump and session restart.** The helper got `org.freedesktop.DBus.Error.NoReply`; the user
journal records `org.gnome.Shell@ubuntu.service: Failed with result 'core-dump'`. The unsafe code was
removed completely. No further `SetKeymap` experiment should be run on the owner's desktop.

The earlier Unicode test showed that ordinary Mutter keysyms silently omit unmapped characters:
`árvíztűrő tükörfúrógép 日本語 🐈` became `rvztr tkrfrgp  `. The final helper therefore rejects non-ASCII
**before sending any text** on Mutter/portal. Coordinator `team-code-opus` agreed with this limitation.
`wtype` and the native macOS/Windows helpers can implement Unicode without this Mutter path. uinput text
is explicitly restricted to its US-layout table. There is no clipboard overwrite fallback.

Other limits are explicit errors, never silent substitutions:

- GNOME window focus/window-region capture require the RIGS Shell extension. AT-SPI supplies a partial
  list only; its Wayland bounds are not trustworthy for capture. No extension installation/relogin was
  performed by t3. Window capture of a window spanning displays is refused.
- wlroots uses grim, wtype, compositor commands, then uinput/portal as selected. The wlrctl path supports
  clicks/scroll and compositor absolute motion; held buttons/drag require uinput or portal.
- The X11 CLI fallback requires xdotool plus import/scrot and wmctrl. Capture is the whole X11 desktop;
  optional region/downscale capture is refused by this fallback. No native ctypes X11 fallback was added.
- macOS: the native helper exists since project 8eb2687046 (see "macOS helper" below). The optional `mac-jxa`
  backend is not implemented and remains unavailable.
- Windows GDI/SendInput/EnumWindows/focus operations are implemented in the PowerShell/C# helper but
  **not live verified** (no Windows node available). UIPI, secure desktop and foreground restrictions apply.
- Portal fallback, wlroots, X11, GNOME extension, native hotkey setup and Windows were not exercised on
  the owner's desktop. Automatic system shortcut installation is not part of this task's live proof.
  Portal pointer motion requires a preceding capture of that display to establish pixel/logical scale.

Reference for the compositor distinction: [Mutter ScreenCast interface](https://github.com/GNOME/mutter/blob/main/data/dbus-interfaces/org.gnome.Mutter.ScreenCast.xml)
describes stream parameters in compositor coordinates. Input/capture effects above were measured locally;
the private Mutter API can differ between versions.

## Wayland service mode (project 8eb2687046, task t2)

The daemon normally runs as `rigs.service` (systemd --user), and agents often reach the machine over SSH, where
`XDG_SESSION_TYPE=tty`. Two QA defects are fixed and covered by tests in `test/control.test.js`. First,
`control-linux.js` trusts only `wayland`/`x11` from `XDG_SESSION_TYPE`, then `WAYLAND_DISPLAY`, then `DISPLAY`
(38cd719, af16f7a). Second, `parseCombo('ctrl++')` is ctrl plus the `+` key (38cd719).

Live on `magix-system` (GNOME Shell 50.1, Wayland, DP-1 3840×2160 @1.5), 2026-10-18 03:05–03:31Z, scratch clone
`/tmp/rigs-t2` of this branch, dev daemon as a transient unit:

```bash
systemd-run --user --unit=rigs-t2-dev --working-directory=/tmp/rigs-t2 -E RIGS_HOME=/tmp/rigs-t2-home \
  -E RIGS_PORT=4793 -E RIGS_BIND=127.0.0.1 -E RIGS_NO_MIGRATIONS=1 -E RIGS_NO_AUTOUPDATE=1 -E RIGS_NO_OPENRIG=1 \
  -E RIGS_NAME=rigs-t2-dev /usr/bin/node bin/rigs.js start     # control + input on in /tmp/rigs-t2-home only
node scripts/control/linux/live-check.js http://127.0.0.1:4793
```

| Check | Result |
| --- | --- |
| Session env in service mode | status: `session wayland`, `desktop gnome`, backends `mutter`/`mutter`/`atspi`. The helper's `/proc/<pid>/environ` has `WAYLAND_DISPLAY=wayland-0` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus` |
| Same with the unit's own env stripped | a second unit (port 4794) with `XDG_SESSION_TYPE=tty WAYLAND_DISPLAY= DISPLAY= DBUS_SESSION_BUS_ADDRESS=` still reports `session wayland` with the same backends and helper env. `refreshSessionEnv` reads them from `systemctl --user show-environment` |
| Locked screen | `GET screenshot`, `POST type`, `POST key {ctrl++}`, `GET windows` → HTTP 423 `locked` "The screen is locked" in 11–80 ms |
| No backend / no session | the lock check answers first while locked, so this is covered by the unit test "no backend or no graphical session…": a forced backend with no tool → `unsupported` "No capture/input backend is available", session `none` → `no-session`, both before any input reaches the helper. A hung helper → `timeout` at the 10 s deadline (existing test). |
| Unicode | refused with `unsupported` before any key is sent (no `SetKeymap`, see below); the live check asserts this in the scratch window |
| Screenshot + typing into a scratch window | the screen had been locked for ~7 h. It was not unlocked from a script, which would bypass the owner's lock screen; Sir unlocked it when asked through JARVIS. At 03:30Z the live check passed every check: `/tmp/rigs-wayland-service-shot.png` 3840×2160 (2.58 MB, real desktop), the scratch window active per AT-SPI, Unicode `é` → 501 `unsupported` in 6 ms, 46 characters typed via keysym, the exact string `RIGS wayland service check 2026-10-18T03:30:40` read back from the window's output file and visible in `/tmp/rigs-wayland-service-typed.png` (viewed) |

`scripts/control/linux/live-check.js` runs both cases. When locked, it checks the 423s and exits 2. When unlocked, it
writes `/tmp/rigs-wayland-service-shot.png`, then opens its own GTK4 scratch window as a transient unit
(`rigs-live-check-scratch`). It waits until AT-SPI reports that window as the active one, and types nothing
otherwise. It then checks that Unicode is refused, types a timestamped ASCII line, and reads the line back from the
scratch window's own output file. Finally it writes `/tmp/rigs-wayland-service-typed.png`. Logs: `journalctl --user -u rigs-t2-dev`.

**Portal restore token.** GNOME uses Mutter's ScreenCast/RemoteDesktop. There is no dialog and no token, so a second
session needs no prompt by design (verified: every unit above captured the backends with no prompt). The token
matters only for the portal backend (KDE, or `config.control.backend = "portal"`). There the helper asks for
`persist_mode=2`, emits `restore-token`, and the daemon stores it in `control-state.json` and passes it back on
`configure`. The new unit test "a portal restore token is persisted and handed back to the helper after a daemon
restart" verifies the daemon side. "No second prompt" itself is **not verified live**: the first portal session
needs a person to approve the dialog at the machine, which an agent must not do on the owner's behalf. Without a
person, that first action ends with `timeout` at the 10 s deadline and the helper is stopped. To verify, with Sir at
the machine, set `backend: "portal"` in the scratch config, take a screenshot and approve once, then
`systemctl --user restart rigs-t2-dev` and take another: no dialog should appear.

## macOS helper (project 8eb2687046, task t1)

RIGS Control.app: `scripts/control/macos/RigsControl.swift` (+ `Info.plist`, `build.sh`), installed by
`src/control-mac-helper.js` (boot setup, the Grant button, or `rigs control helper install`). It speaks the socket
protocol above (`probe` also returns `grants` and `helper`; plus `hello`, `displays` and `grant {permission}`).
Verified on macbookpro, macOS 26.3.1 (25D2128), Apple M1, one display 1680×1050 pt @2x (3360×2100 px), toolchain
Xcode 13.3 (Swift 5.6, macOS 12.3 SDK). Dev daemon: `RIGS_HOME=<worktree>/.rigs-dev/mac`, port 4791,
`RIGS_NO_MIGRATIONS=1 RIGS_NO_AUTOUPDATE=1 RIGS_NO_OPENRIG=1`; helper job `dev.rigs.control.6c5a13de`. Since
2026-10-18 that label is also the dev build's bundle id, and System Settings lists it as "RIGS Control (dev)"; the
real home's helper stays `dev.rigs.control` / "RIGS Control".

### Grants needed (recorded live)

| Grant | To | Needed for | Prompt / where |
| --- | --- | --- | --- |
| Screen Recording | RIGS Control | `screenshot`, `windows` (`CGWindowList` titles) | `CGRequestScreenCaptureAccess()` adds the entry; System Settings > Privacy & Security > Screen Recording |
| "Bypass the system private window picker" | RIGS Control | `screencapture`-based capture on macOS 15+/26 | a system dialog on the first capture after the grant (Allow / Open System Settings). Capture already worked while it was still open; macOS may ask again periodically |
| Accessibility | RIGS Control | `focus`, `pointer`, `key`, `type` (AX + `CGEventPost`) | `AXIsProcessTrustedWithOptions(prompt)` adds the entry; System Settings > Privacy & Security > Accessibility |
| Automation, Input Monitoring, Full Disk Access | — | not needed by the helper | |

Screen Recording was switched on by Sir at the Mac and verified live for the 2026-10-17 build. Accessibility has not
been switched on for any build yet (see "Live check status"), so its row lists what the code and macOS require, not a
live observation. Nothing in RIGS clicks a TCC prompt or edits TCC.db; the only TCC call RIGS makes is
`tccutil reset <service> <its own bundle id>` before a grant after a build, for a grant that build does not hold.

### Live check status, 2026-10-17 build (bundle id `dev.rigs.control`), through `http://127.0.0.1:4791/api/local/control/*`

| Check | Result |
| --- | --- |
| `npm test` on macOS | 446 pass, 0 fail, 1 skipped |
| Screenshot | works: `/tmp/rigs-mac-shot.png`, 3360×2100 PNG of the real desktop; downscaled `maxWidth=1400` shots too |
| Screen Recording across a helper restart | kept (bootout + bootstrap without a rebuild, new pid 68840) |
| Accessibility missing → status | `ready {see: true, act: false}`; `input` and `accessibility` `ok: false` with `fix.kind: settings`, the `Privacy_Accessibility` pane URL, the app path and "switch on RIGS Control … not to node" |
| Accessibility missing → actions | `GET windows` and `POST type` → 412 `needs-permission` with the same fix |
| Window list, focus, pointer, typing into TextEdit | **not yet verified**: they need Accessibility, which no build of RIGS Control has held so far (the audit log has no successful `windows`, `focus`, `pointer`, `key` or `type`). Pending Sir switching it on |

### Live check status, 2026-10-18 build (bundle id `dev.rigs.control.6c5a13de`, "RIGS Control (dev)")

The review fixes below changed the Swift source and the bundle id, so this build (01:53Z) needs both grants anew.
The Mac had been idle for 5.5 h with the screen locked, so only checks that need neither a person nor an unlocked
screen were run:

| Check | Result |
| --- | --- |
| `npm test` on macOS | 450 tests: 449 pass, 0 fail, 1 skipped (one earlier full run hit the known-flaky `mobile-a11y` small-target check on `#subtitle`; it passes alone and on the rerun) |
| Build | `build.sh <app> dev.rigs.control.6c5a13de "RIGS Control (dev)"`: Info.plist and `codesign -dv` show the id, ad-hoc signature, stamp `<sha256> dev.rigs.control.6c5a13de`; `current: true` |
| Socket protocol | pipelined `hello, locked, type, stop, key, probe, release` on one connection: answered in order; `type`/`key` → `needs-permission` (Accessibility); a bad token → `not-allowed`, connection closed |
| SIGTERM | `rigs control helper stop` (bootout): the helper exited in 0.08 s and removed its socket; `install` restarted it without a rebuild |
| Status with no grants | `ready {see: false, act: false}`; each permission `ok: false` with `fix.kind: settings`, its pane URL, the app path and "switch on RIGS Control (dev) … not to node"; right after the build also "(a new build: click Grant first …)" |
| Actions while locked | `GET windows`, `POST type` → 423 `locked` (the lock check runs before the permission check) |
| Grant flow | `POST control/grant` for `screenCapture` and `accessibility`: reset only `dev.rigs.control.6c5a13de` (no grant held), the helper's prompts and both panes opened; `regrant` cleared |
| Screenshot, window list, focus, pointer, typing into TextEdit | **pending**: Sir switches on "RIGS Control (dev)" in Screen Recording and Accessibility (asked through JARVIS, 2026-10-18 01:58Z) |

The pending checks are one command with the dev daemon running and the Mac unlocked:
`node scripts/control/macos/live-check.js http://127.0.0.1:4791`. It checks the grants, takes
`/tmp/rigs-mac-shot.png`, saves the window list to `/tmp/rigs-mac-windows.json`, opens the scratch document
`/tmp/rigs-mac-textedit.txt` in TextEdit, focuses it, clicks into it, types a timestamped line, saves it with ⌘S,
reads the file back, and takes `/tmp/rigs-mac-textedit.png`. To check that the grants survive a restart, run
`rigs control helper stop`, then `install` (same `RIGS_HOME`), then run it again.

### Findings

- **Responsible process.** The same binary started from a terminal reported every grant as true (it inherits the
  terminal's grants: the bypass this design prevents). Started by launchd as its own LaunchAgent it reported its
  own state: all false before the grants. A dev daemon started from that terminal also triggers the `nodeGrants`
  warning, correctly.
- **Grants apply without a restart.** After Screen Recording was switched on, the running helper (same pid) reported
  `screen: true` through a fresh `--preflight` child, and captures (spawned `screencapture`) worked.
- **Grants survive restarts.** `rigs control helper stop` (bootout) then `install` (bootstrap, no rebuild) started a
  new pid that still had Screen Recording. A rebuild (new cdhash) loses them: the grant flow reset the old entries.
- **Bug found and fixed (f630aa3): "Quit & Reopen".** Switching on Screen Recording makes System Settings offer
  "Quit & Reopen". The first build quit (exit 0, so launchd's crash-only KeepAlive left the job stopped) and macOS
  reopened the bundle through LaunchServices without `--home`, so it served `~/.rigs/run/control.sock` (the
  installed daemon's path). It was stopped within minutes and its two files removed; the installed daemon never
  used it (no `~/.rigs/logs/control.jsonl`). The helper now declines quit requests, derives its home from its
  location, and exits when another instance already answers.
- **Review fixes (2026-10-18).** (1) The kill hotkey and SIGTERM handlers took the input lock on the main thread,
  and `type` held that lock for its whole text, so ⌃⌥⌘⎋ only took effect after typing finished (up to the 8 s
  budget). A hotkey press during a request waiting for the main thread (window list, focus, the first key) deadlocked
  the helper. Now a stop counter is bumped without the lock by `stop`, the hotkey, SIGTERM and the driving
  connection's close. Each connection runs its requests on its own queue, so a `stop` is read while typing runs,
  and typing ends at the next character with `off`. A status probe's connection closing no longer releases another
  caller's held input. (2) Every home's build had the bundle id `dev.rigs.control`, and TCC keeps one entry per bundle id, so a
  dev build shared (and its grant flow reset) the real helper's grants. A dev/scratch home now builds under its
  label. (3) `windows` was gated on Accessibility although the list is `CGWindowList` (Screen Recording for titles).
  (4) The stale-grant reset could take away a grant switched on by hand; it now skips grants the build holds.
- **Fix hints.** Helper not running → every permission and action error is `needs-permission` (412) with
  `fix.kind: helper` ("click Grant or run `rigs control helper install`"). Grant missing → 412 with the System
  Settings pane URL, the app path and "switch on RIGS Control … not to node". `ready.see/act` now also require the
  grants (they read true before).
