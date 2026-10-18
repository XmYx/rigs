# Full access and control: independent review (t4)

Branch `work/macbookpro/finish-wayland-and-macos-full-cf14` at 16bb193, reviewed against main af0efad
(15 commits, 19 files, +1860/-71). Reviewed 2026-10-18 on macbookpro by team-review-opus. This replaces the t9 review
of the magix-system branch (723db04, still in git history). Its open issue 1, "the macOS helper does not exist", is
closed by this branch.

Goal: full access and opt-in full control on Wayland and macOS. X11 and Windows must degrade gracefully, and
nothing may break.

## Checks re-run

- `npm test` on macbookpro: 453 tests, 452 pass, 0 fail, 1 skipped. The skip is the Linux-only test "Linux helper
  fixes both scaled dimensions…", which skips on macOS.
- `npm run build`: UI built to ui/dist, exit 0.
- `src/migrations.js`: unchanged on this branch, so the append-only rule holds.
- Home isolation: I recorded mtimes of `~/.ssh/*` and `~/.codex/*` before and after the test run, and none changed.
  `test/control-mac-helper.test.js` uses a `mkdtemp` RIGS_HOME and an injected `launchAgents` dir and runner, so no
  real LaunchAgent, `launchctl` or `tccutil` runs. The only changes under `~/.claude` came from this review's own
  Claude Code session.
- Live macOS re-run: **not possible.** The Mac was locked, and `rigs control helper status` with the dev home shows
  the dev helper `dev.rigs.control.6c5a13de` running (pid 23258) with
  `grants: {screen: false, ax: false, post: false, listen: false}` and `locked: true`.
  `scripts/control/macos/live-check.js` would stop at its readiness check.
- t2 evidence re-checked on magix-system:
  - `/tmp/rigs-wayland-service-shot.png`: 2.58 MB.
  - `/tmp/rigs-wayland-service-typed.png`: viewed. The "RIGS Control service check" window shows
    "RIGS wayland service check 2026-10-18T03:30:40".
  - `/tmp/rigs-wayland-service-journal.txt`: 47 lines.
  - `/tmp/rigs-t2-home/logs/control.jsonl`: the Unicode `type` is refused with `unsupported` (backend mutter), the
    46-character `type` succeeds, and the 3840×2160 DP-1 screenshot succeeds. The caller and lease are recorded on
    each line.
- t1 evidence: `/tmp/rigs-mac-shot.png` (1.9 MB, 2026-10-17 22:29) is still on macbookpro. It comes from the earlier
  build (see t1). The current build has no grants.
- Mesh: no Windows or X11 machine is in the mesh (`mesh_status`: macbookpro, magix-system, an iPhone, and an offline
  Mac).

## Verdict by goal point

| Goal | Verdict | Evidence |
|---|---|---|
| Wayland access | **Done (GNOME/Mutter)**, including service mode (systemd user unit, `XDG_SESSION_TYPE=tty`) | t2: `/tmp/rigs-wayland-service-shot.png` (3840×2160) and the audit lines above. Locked screen → 423 in 11–80 ms. 38cd719 and af16f7a, with tests in `test/control.test.js` (session detection) |
| Wayland control | **Done (GNOME, keysym/ASCII)**. Non-ASCII is refused with 501, never via `SetKeymap` | t2: 46 characters typed and read back from the window (`/tmp/rigs-wayland-service-typed.png`). Portal restore token persisted (unit test). KDE/wlroots are not live-verified |
| macOS access | **Built, not yet live-verified on the current build** | 4167c3f, f630aa3, b2d03b0 and 1e730f6: RIGS Control.app, own LaunchAgent, own TCC entry. On the earlier build, a non-blank 3360×2100 capture (`/tmp/rigs-mac-shot.png`). The current dev build holds no grants (see above). Fails closed: actions return `needs-permission` with the System Settings pane, and 423 while locked |
| macOS control | **Built, not verified**: window list, focus, pointer and typing were never run on any build | Blocked on Sir: grant "RIGS Control (dev)" Screen Recording + Accessibility, unlock, then run `node scripts/control/macos/live-check.js http://127.0.0.1:4791` against the scratch dev daemon (t1's env) |
| X11 degrades gracefully | **Logic-verified only** | `selectBackend` x11 tests, `XDG_SESSION_TYPE=tty`→`DISPLAY` fallback test (af16f7a). No X11 machine to run live |
| Windows degrades gracefully | **Unchanged on this branch, unverified live** | `src/control-win.js` not touched. `selectBackend` windows test. No Windows machine in the mesh |
| Nothing broken | **Holds** | 452/453 pass, 0 fail, build OK. The only shared change is `control.js`: `permissionFor`, `ready` honours permissions, and kill/off call `adapter.shutdown` when an adapter has one. Linux and Windows adapters have no `shutdown`, so they behave as before |
| Safety | **Mostly good. Two macOS gaps (issues 1 and 2)** | see next section |

## Safety posture

- **Default.** Control is on by default, not "off by default" as this brief says. That was Sir's decision in the
  earlier "roll-out OS control default-on" project (c258579, migration `2026-10-17-control-default-on`). The managed
  agent instructions say the same. A person or the kill switch turns it off, and only a confirmed human surface turns
  it back on. t3 raised the same mismatch; I treat the shipped default as intended. Sir: confirm.
- **No MCP enable tool.** `src/mcp.js` has `mesh_screen`, `mesh_windows`, `mesh_control` and `mesh_access`. None of
  them can reach `control/enable` or `control/kill`. `mesh_control` maps only to type/key/focus/pointer. `enable()`
  refuses any caller with `agent`, `via: mcp`, or without `confirm === <machine name>`. `control` is in the
  `patchConfig` blocked set.
- **Auth on routes.** `/api/local/control/*` goes through the usual `localApi` auth: loopback, same-owner tailnet, or
  mesh token. "Human" still means "no `x-rigs-caller` header", the documented trade-off from t9. Unchanged here.
- **Audit log.** `logs/control.jsonl` is mode 0600 and rotates at 5 MB. It must be writable before any action
  (fail-closed open). `type` errors drop the message, and `secret: true` drops the preview. Typed text is **still
  previewed by default** (`auditPreview: 64`; seen in the magix-system log). See issue 3.
- **Kill switch.** It is persistent (`control-state.json`, written before the config). On macOS, kill and off now also
  unload the LaunchAgent (`adapter.shutdown` → `stopMacHelper`). A second authenticated "watcher" connection forwards
  the ⌃⌥⌘⎋ hotkey between leases. The helper ends typing at the next character on stop, hotkey or SIGTERM. Boot setup
  skips the helper install when status is off or killed.
- **TCC.** The helper never bypasses TCC. It uses only `CGRequestScreenCaptureAccess`,
  `AXIsProcessTrustedWithOptions(prompt)` and `CGRequestPostEventAccess`, and a person flips the switch. The only
  `tccutil` call is `reset <service> <this home's bundle id>`, after a rebuild, and never for a grant the running
  build holds. It does not write to TCC.db, use `sudo` or run `osascript` for grants. A dev home has its own bundle
  id, so it cannot reset the real helper's grants (1e730f6, tested).

## Open issues

1. **High (macOS): the helper's socket is a same-user bypass of the gate.**
   - `RigsControl.swift` accepts any peer with the same uid (`getpeereid`, line 690) that presents the token from
     `RIGS_HOME/run/control.token`. Both the socket and the token are 0600, but agents run as that same user.
   - Verified on macbookpro: a 6-line Node script read the token and called `locked` on the dev helper's socket with
     no daemon running. It got `{"locked":true}`, and nothing was written to `control.jsonl`.
   - Once Screen Recording and Accessibility are granted, any agent can capture and inject input with no gate, lease,
     rate limit, lock check, audit or announcement. That contradicts the fix text ("the helper holds these rights so
     agents cannot bypass the control gate", `src/access.js` `helperFix`) and the UI guide.
   - On Linux the helper is a stdio child of the daemon and cannot be reached this way. A same-user process can still
     use Mutter or uinput directly there, so the Mac is not worse than Linux in absolute terms. It is worse than its
     own stated design.
   - Suggested fix: only the daemon may talk to the helper.
     - Check `LOCAL_PEERPID` against the daemon pid, which the daemon registers once over a channel the helper trusts.
       One option: launchd starts the helper with a one-shot pipe, or the helper writes the token to a file only the
       daemon's code-signed bundle can read.
     - At a minimum, do not leave the token in a world-of-same-user readable file. Document the residual risk
       honestly.
2. **Medium (macOS): a grant can restart the helper after a kill.**
   - `access.grant()` (`POST control/grant`, reachable from the MCP `mesh_access grant:"screenCapture"`) calls
     `installMacHelper()` without checking `control.enabled` or `killed`. So does `rigs control helper install`.
   - After `rigs control off`, the daemon gate stays shut, but the helper is running again with its grants. Combined
     with issue 1, that is a working capture/input path after the kill switch fired. AGENTS.md says "nothing a tool or
     agent does may turn control back on".
   - Suggested fix: refuse `grant` for screenCapture/accessibility, and `helper install`, while control is off or
     killed. Return a fix that says a person must switch control on first.
3. **Medium (all OS, carried over from t9): typed text is stored in the audit log by default.**
   - `auditPreview: 64` (`src/config.js:113`) keeps the first 64 characters of any `type` call without `secret: true`.
     The magix-system log shows the typed string in `preview`.
   - A credential typed by an agent that forgets `secret` lands in `control.jsonl`.
   - Suggested fix: default to 0, or redact anything password-like.
4. **Medium (macOS): window list, focus, pointer and typing were never run on any build.** This is acceptance
   criterion 3 of t1, and it is blocked on Sir:
   1. Unlock the Mac.
   2. Switch on "RIGS Control (dev)" in Screen Recording and Accessibility.
   3. Start the dev daemon (port 4791, scratch RIGS_HOME, `RIGS_NO_MIGRATIONS/AUTOUPDATE/OPENRIG=1`).
   4. Run `node scripts/control/macos/live-check.js http://127.0.0.1:4791`.
5. **Medium: no live X11, KDE, wlroots or Windows run** (no such machine in the mesh). Unchanged from t9.
6. **Low: t3's new agent-instruction text never reaches existing machines.**
   - 16bb193 changed the managed block in `src/setup.js` ("only Sir can switch it back on…"). The only path that
     rewrites existing machines is a migration, and `2026-10-17-control-instructions` has already run.
   - `~/.claude/CLAUDE.md` on macbookpro still has the old text.
   - Fix: append a migration (e.g. `2026-10-18-control-instructions`) that calls `writeInstructions()`.
7. **Low (macOS, operational): every change to the Swift sources means a re-grant on every Mac.** A rebuild changes
   the ad-hoc cdhash, so the old TCC entry stops applying, and each Mac also needs Xcode Command Line Tools
   (`swiftc`). This is documented, and it fails closed with a fix hint. Expect a re-grant after any helper update.
8. **Low (macOS): the kill hotkey is not persisted when the daemon is down.** The helper still stops input at once.
   Only the persistent `killed` marker needs the daemon's watcher connection.
9. **Info: leftovers from t1/t2.**
   - The dev LaunchAgent `dev.rigs.control.6c5a13de` is still loaded on macbookpro. Remove it with
     `RIGS_HOME=<worktree>/.rigs-dev/mac node bin/rigs.js control helper remove`.
   - A stale plain "RIGS Control" TCC entry from the old dev build is still there.
   - `/tmp/rigs-t2*` is still on magix-system.

## Recommendation

- **Linux/Wayland**: meets the goal on GNOME, verified live in service mode.
- **macOS**: built and fails closed, but not done.
  - Issues 1 and 2 should be fixed before Sir grants RIGS Control on any Mac. After a grant, the helper is an
    unaudited control path for any same-user process.
  - Issue 4 needs Sir at the Mac.
- **Branch**: safe to merge in its current state. No Mac holds a grant yet, so issue 1 has no effect until one does.
  The project goal is not complete until issues 1, 2 and 4 are closed.
