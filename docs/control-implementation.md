# Control module: integration and verification (t3)

Task `t3`, project `2ed3c75b03`, 2026-10-17. Public API: `src/control.js`.

The default instance uses the current configuration and `RIGS_HOME`. `createControl()` accepts isolated
configuration, a clock, permission probes and an adapter for tests. The adapter owns platform operations;
the public module owns authorization, the lease, deadlines, rate limits, screenshot transforms and audit.
Configuration defaults remain off. This task never enabled the installed daemon's control configuration.

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
  `locked`, or `restore-token` events; the first three kill control, the last persists the token.

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
- macOS socket behavior is tested against a local fixture; actual native operations/permissions wait for
  the dedicated Swift helper, which is **not yet present in this branch**. t6 must supply/install that
  helper or route its implementation before macOS live acceptance. The optional `mac-jxa` backend is not
  implemented and remains unavailable.
- Windows GDI/SendInput/EnumWindows/focus operations are implemented in the PowerShell/C# helper but
  **not live verified** (no Windows node available). UIPI, secure desktop and foreground restrictions apply.
- Portal fallback, wlroots, X11, GNOME extension, native hotkey setup and Windows were not exercised on
  the owner's desktop. Automatic system shortcut installation is not part of this task's live proof.
  Portal pointer motion requires a preceding capture of that display to establish pixel/logical scale.

Reference for the compositor distinction: [Mutter ScreenCast interface](https://github.com/GNOME/mutter/blob/main/data/dbus-interfaces/org.gnome.Mutter.ScreenCast.xml)
describes stream parameters in compositor coordinates. Input/capture effects above were measured locally;
the private Mutter API can differ between versions.
