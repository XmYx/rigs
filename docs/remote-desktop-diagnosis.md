# Remote desktop (screen access) across the mesh — diagnosis

Run 2026-10-18 13:38–13:46Z from `macbookpro`, read-only. Nothing was switched, granted or configured; no `mesh_control`
input was sent (see "Not tested").

Nodes: `macbookpro` (macOS 25.3, Quartz), `mac` (macOS 25.5, Quartz), `magix-system` (Ubuntu 26.04, GNOME Wayland).
All three run RIGS `07f01e5` (`git -C ~/.rigs/app log -1`, all identical: "Merge work/magix-system/reusable-tool-and-applet-registry-017a").
Screen access and input are switched **on** (`enabled:true, input:true, killed:null`) on all three. rig CLI differs
(macbookpro/magix 0.6.10, mac 0.6.11) but is unrelated to the screen path. There is no daemon version skew.

## Matrix (source → target, observed)

Each cell: `mesh_access` / `mesh_screen` / `mesh_windows`. Same result through the rigs MCP tools and through the HTTP
endpoints (`/api/nodes/<target>/control/…` on the source's daemon; the diagonal is the node's own daemon).

| source ↓ / target → | macbookpro | mac | magix-system |
| --- | --- | --- | --- |
| **macbookpro** | access 200, `ready.see/act=false` · screenshot **412** needs-permission · windows **412** | access 200 `ready=false` · screenshot **412** · windows **412** | access 200 `ready=true` · screenshot **200** PNG · windows **200** (6 windows) |
| **mac** | access 200 `ready=false` · **412** · **412** | access 200 `ready=false` · **412** · **412** | access 200 `ready=true` · **200** PNG 76 159 B 600×338 · **200** |
| **magix-system** | access 200 `ready=false` · **412** · **412** | access 200 `ready=false` · **412** · **412** | access 200 `ready=true` · **200** PNG 72 978 B 600×338 · **200** |

Result: **every source reaches every target and gets the target's truthful answer. Only `magix-system` as target works.**
Both Macs as target fail with `needs-permission` (HTTP 412) for screen capture, and `mesh_access` shows Accessibility and
input missing as well. The proxy, auth and the Wayland backend are fine. Wherever a result is a 412 or a 200, the source
node relays the target's status code and JSON body unchanged, so the failure is in the target backend, not in transport.

## Versions and OS grant state

| node | RIGS commit | backend (capture/input/windows) | helper | screenCapture | accessibility | input (CGEventPost) |
| --- | --- | --- | --- | --- | --- | --- |
| macbookpro | `07f01e5` | mac-helper | `RIGS Control.app` pid 26592 (running ~10 h), ad-hoc signed `dev.rigs.control`, built 05:37 | **false** (CGPreflightScreenCaptureAccess) | **false** (AXIsProcessTrusted) | **false** |
| mac | `07f01e5` | mac-helper | `RIGS Control.app` pid 51832 (started ~9 min before the probe), ad-hoc signed, built 15:32 (the rollout) | **false** | **false** | **false** |
| magix-system | `07f01e5` | mutter / mutter / rigs-extension | python helper, GNOME extension `rigs-control@rigs.dev` enabled | true (mutter) | true (at-spi, partial: misses Firefox/Unity, window list needs the extension — which is present) | true (mutter) |

The grants are held by the LaunchAgent helper `RIGS Control.app` (src/control-mac-helper.js:11-12), not by the daemon's
`node`, and that is the process whose answer is reported (`via: "RIGS Control · CGPreflightScreenCaptureAccess"`).
The user TCC database cannot be read from an agent (`sqlite3 …/TCC.db: authorization denied`, no Full Disk Access), so the
helper's own preflight answer is the evidence. Both fix hints carry the "a new build: click Grant first" text, which is only
added when `regrant` is set (src/access.js:147; set at src/control-mac-helper.js:144 when the helper was rebuilt), so on
both Macs the helper is a build whose grant was never made or was cleared.

## Root causes

1. **macOS helper lacks Screen Recording + Accessibility on `macbookpro` and `mac` — needs-Sir.** `perform` reaches
   `permission?.ok === false` and throws `needs-permission` (src/control.js:206-208) → HTTP 412 (src/control-api.js, status
   from `ControlError`). Fix is only a person in System Settings > Privacy & Security: Screen Recording and Accessibility → switch on
   "RIGS Control" (an agent can start the step with `mesh_access grant:"screenCapture"|"accessibility"` but a person has to confirm; I
   did not call it because it changes machine state). Because the helper is ad-hoc signed (`Signature=adhoc`), every rebuild changes the
   cdhash and invalidates the previous grant, so the rollout of `07f01e5` rebuilt the helper on `mac` (15:32) and the grant must be redone
   there; on `macbookpro` the build is older (05:37) and its grant is simply absent. Also possible: after granting Screen
   Recording macOS may need the helper restarted before `CGPreflightScreenCaptureAccess` flips (the helper works around it by running
   `screencapture` as a child, scripts/control/macos/RigsControl.swift:147-150, but status still preflights).
   Tag: **needs-Sir**.

2. **Two helpers share one bundle id on `macbookpro` — code-fixable, low severity.** `ps` shows `RIGS Control.app` pid 26592
   (`~/.rigs`) and pid 23258 from another dev worktree (`~/rigs-dev/finish-wayland-and-macos-full-cf14/.rigs-dev/mac/bin`), both
   `dev.rigs.control`. TCC keys the entry by bundle id plus code requirement, so two ad-hoc builds under one id fight over one grant and
   a click on "Grant" for one can clear the other's entry. Give dev worktree helpers a distinct bundle id (src/control-mac-helper.js
   `helperPaths`, scripts/control/macos/build.sh). Tag: **code-fixable**.

3. **Failed or refused calls still take the screen lease — code-fixable.** `gate()` calls `touchLease(caller)` (src/control.js:159-166)
   *before* inspect/permission checks (src/control.js:206-208), so a call that ends 412 or 409 still creates/renews a 60 s lease
   (`leaseIdleSec`) held by that caller. The lease key is `[from, agent, session, seat, who]` (src/control.js:69), so the same
   person calling from the UI/CLI/curl (`human:true`, no session) and an MCP agent on the same source are different holders, and different
   source machines are different holders. Observed: my curl probes on `mac` blocked my own MCP `mesh_windows`/`mesh_screen` on all
   three targets with `409 {"code":"busy","error":"Screen lease is held by miklos.mnagy@gmail.com on macbookpro"}`, and a probe fired
   from `mac` blocked `magix-system`'s probe on every target, including `magix-system`, whose backend was perfectly healthy. Any two agents (or an agent
   and Sir's UI polling) hitting the same machine within a minute lock each other out, and a permission-denied call on a Mac that
   cannot succeed still holds the lease for 60 s. Fix: check permission/readiness before
   `touchLease`, and do not renew a lease for a call that fails before touching the desktop. Tag: **code-fixable**.

4. **Lease key includes the transport identity — code-fixable, observation.** The same agent reached via a different path gets a different
   `who` (`peer` for the token path vs `miklos.mnagy@gmail.com` for tailscale) so even a single agent can be refused by its own lease
   (`Screen lease is held by local on macbookpro`, src/control.js:69 and src/control-api.js:22-38). Consider keying on
   `session`/`seat` when present. Tag: **code-fixable**.

5. **No harmless read-only `mesh_control` op — code-fixable gap (not a failure).** `mesh_control` has `move/click/double/right/scroll/
   drag/type/key/focus` only (src/mcp.js:434-450); every one moves or changes something, and a "get cursor position" does not exist. I
   therefore sent no `mesh_control` call. Adding a `cursor` action would allow a safe input-path check. Tag: **code-fixable**.

6. **Working path, for the record.** `magix-system` (Wayland): capture/input via mutter, windows via the GNOME `rigs-control`
   extension. `ready.see/act` true, 6 windows listed, screenshot 3840×2160 display DP-1 scaled to 600–800 px (`x-rigs-scale` 4.8–6.4).
   No portal/grim fallback was needed. Remaining caveat: `accessibility.partial:true` — AT-SPI misses Firefox and Unity.

Not causes (checked): auth (all same-owner tailnet calls pass `authorize`, src/auth.js:40-56; the audit log shows the callers as
`tailscale`/`token`), proxy forwarding (src/proxy.js:17-50 sets `x-rigs-via` and relays status/body; observed latency 0.01–0.2 s),
payload size/timeout (largest image 150 kB, a screenshot completes in ≈0.16–0.2 s vs the 60 s MCP and 10 s control timeouts), daemon version skew (identical
`07f01e5`), Wayland backend missing (mutter + extension present).

Also seen: one `mesh_screen`/`mesh_exec` call was refused by the agent permission classifier (not a RIGS error); it succeeded on retry
or with a plain command, so it is not part of the product failure.

## Fix plan

| # | change | who | fixed |
| --- | --- | --- | --- |
| 1 | Grant Screen Recording and Accessibility to "RIGS Control" on `macbookpro` and `mac`, then re-run `mesh_access` | **Sir** (OS permission) | **open, needs Sir** (see "Needs Sir" below). `mesh_access` and every 412 now name the grant, the app path and the machine |
| 2 | Distinct bundle id for dev-worktree helpers | code | **already in place, no change.** Re-checked (t2): the dev helper runs as `dev.rigs.control.6c5a13de` (`launchctl list`, `codesign -dv`, its `source.sha256` stamp, LaunchAgent `dev.rigs.control.6c5a13de.plist`), the real one as `dev.rigs.control`. `helperLabel` (src/control-mac-helper.js:24) already gives every non-default home its own id, covered by test/control-mac-helper.test.js "helperLabel". t1 read the id off the process path, not the bundle |
| 3 | Check permissions before taking the lease; do not take it on a refused call | code (src/control.js `gate`/`perform`) | **fixed.** `gate()` only checks the lease; `perform()` takes it after lock, backend, OS permission and rate checks pass. Refusals no longer use up the rate budget, and a refusal after the helper was opened stops it when no lease would idle it out. Tests: test/control-remote-desktop.test.js (first two tests; both fail on 07f01e5) |
| 4 | Key the lease on session/seat when available | code (src/control.js:69) | **fixed.** `holderKey` = entry node + agent session (or seat), or "human"; `who` (the transport: `local`/`peer`/tailnet login) is no longer part of it. Test: "the lease follows the agent session, not the transport" (fails on 07f01e5 with `busy`) |
| 5 | Add a read-only cursor action to `mesh_control` | code (src/mcp.js, src/control.js) | **fixed differently:** `mesh_control action:"check"` (`GET control/check?op=`) runs the real gate for an op (switches, allowFrom, lease, lock, backend, OS permission) and stops: no lease, no input, audited as `check`. A cursor read would have meant changing RigsControl.swift, and any change there rebuilds the ad-hoc-signed helper and drops the grants on every Mac at rollout (cause 1). Tests: "check runs the real gate read-only", "check honours the switches", "control API exposes GET control/check" |
| 6 | (new) `mesh_access` / 412 say exactly what is missing | code (src/access.js, src/control.js, src/mcp.js) | **fixed.** `status().needs` (`missingGrants`): one entry per grant with app path, how, settings URL and the `mesh_access grant:"…"` step; fix text names the app path; the 412 message is "screenshot needs Screen Recording for RIGS Control.app (/Users/mix/.rigs/bin/RIGS Control.app), which is not granted on macbookpro" instead of "Permission required for screenshot". Tests: "permissionMessage …", "missingGrants …", "status reports needs" |

Proxy and auth needed no change (t1). test/control-remote-desktop.test.js now also pins the relay: a 2 MB PNG through
`forwardHttp` arrives byte for byte with its `x-rigs-*` headers, the agent's `x-rigs-caller` reaches the target, the caller's
token and cookie are replaced/stripped, and a 412 arrives with its JSON body.

## After the fix (t2, 2026-10-18 13:56Z)

Worktree server on macbookpro (`RIGS_PORT=4799`, scratch `RIGS_HOME`, `RIGS_NO_MIGRATIONS/AUTOUPDATE/OPENRIG=1`, static peers at
the live daemons' `:4719`), calling `/api/nodes/<id>/control`, `/control/windows` and `/control/screenshot?maxWidth=800`. The targets still
run `07f01e5`: the target-side fixes (lease, `check`, `needs`, messages) reach them only with the rollout after merge. Raw output:
`docs/remote-desktop-evidence/relay-matrix.txt`.

| source → target | before (07f01e5, t1) | after: worktree build as source, live target | after: worktree code as target |
| --- | --- | --- | --- |
| macbookpro → magix-system | 200 / 200 (409 busy while another caller's probe held the lease) | access 200 `ready.see/act=true` · windows **200** (6) · screenshot **200** 800×450, 137 kB, scale 4.8 → `docs/remote-desktop-evidence/magix-system.png` | refused calls no longer lock it (unit tests) |
| macbookpro → mac | 412 / 412 "Permission required for …" | 412 / 412 (helper has no grants; target still on 07f01e5, so the old message) | — (not deployed on `mac`) |
| macbookpro → macbookpro | 412 / 412 | 412 / 412 via the live daemon | **412 / 412 with "screenshot needs Screen Recording for RIGS Control.app (/Users/mix/.rigs/bin/RIGS Control.app), which is not granted on macbookpro"**, `needs` = Screen Recording + Accessibility for that app, `check` → same 412, lease after the refused calls: `null` (`docs/remote-desktop-evidence/macbookpro-new-code.txt`: the worktree's src/control.js driving the running helper read-only, audit in a scratch home) |

`mac` and `magix-system` as sources are unchanged from t1 (they relay byte for byte, see the matrix above); they run the new code only
after the rollout. Every pair whose only causes were code-fixable (all pairs to `magix-system`, which failed only through lease contention)
works; the pairs to the two Macs stay blocked on cause 1 alone.

## Needs Sir

| machine | grant | app to switch on | how |
| --- | --- | --- | --- |
| macbookpro | Screen Recording | RIGS Control — `/Users/mix/.rigs/bin/RIGS Control.app` (bundle `dev.rigs.control`) | System Settings > Privacy & Security > Screen Recording → switch on "RIGS Control". It is a new build: click Grant in JARVIS → Access & control first (or `mesh_access grant:"screenCapture"`), which clears an entry left by an older build |
| macbookpro | Accessibility (input + window focus) | same app | System Settings > Privacy & Security > Accessibility → switch on "RIGS Control" (`mesh_access grant:"accessibility"`) |
| mac | Screen Recording | RIGS Control — `/Users/miklosnagy/.rigs/bin/RIGS Control.app` | as above, on `mac` |
| mac | Accessibility | same app | as above, on `mac` |

Grant it to RIGS Control, not to `node`. Then `mesh_access` on each Mac should show `needs: []` and `ready.see/act: true`. Each rebuild
of the helper (a change to scripts/control/macos) changes its ad-hoc cdhash and needs the grant again.

## Appendix — raw responses (trimmed)

macbookpro → macbookpro / mac (identical shape; paths differ `/Users/mix` vs `/Users/miklosnagy`):

```
GET /api/nodes/macbookpro/control/   200  {"node":"macbookpro","platform":"mac","session":"quartz","enabled":true,"input":true,"killed":null,
  "backend":{"capture":"mac-helper","input":"mac-helper","windows":"mac-helper","missing":[],"helper":{"kind":"mac-helper","bundleId":"dev.rigs.control","version":"1","running":true,"pid":26592,"path":"/Users/mix/.rigs/bin/RIGS Control.app"}},
  "permissions":{"screenCapture":{"ok":false,"via":"RIGS Control · CGPreflightScreenCaptureAccess","fix":{…Privacy_ScreenCapture…}},
                 "input":{"ok":false,"via":"RIGS Control · CGEventPost","requires":"accessibility"},
                 "accessibility":{"ok":false,"via":"RIGS Control · AXIsProcessTrusted"}},"ready":{"see":false,"act":false}}
GET …/control/windows     412  {"error":"Permission required for windows","code":"needs-permission","fix":{"kind":"settings","permission":"screenCapture",…}}
GET …/control/screenshot  412  {"error":"Permission required for screenshot","code":"needs-permission","fix":{…}}
```

→ magix-system (from all three sources):

```
GET /api/nodes/magix-system/control/   200  {"node":"magix-system","platform":"linux","session":"wayland","desktop":"gnome","enabled":true,"input":true,"killed":null,
  "backend":{"capture":"mutter","input":"mutter","windows":"rigs-extension","missing":[],"helper":{"kind":"python","running":true}},
  "permissions":{"screenCapture":{"ok":true,"via":"mutter"},"input":{"ok":true,"via":"mutter"},
                 "accessibility":{"ok":true,"via":"at-spi","partial":true,"detail":"AT-SPI misses some apps (Firefox, Unity); no window list without the RIGS Shell extension"}},
  "ready":{"see":true,"act":true},"displays":[{"id":"DP-1","width":3840,"height":2160,"scale":1.5,"primary":true}],"locked":false}
GET …/control/windows     200  [{"id":"3668774480","title":"… — Mozilla Firefox","app":"Firefox","bounds":{"x":67,"y":32,"width":2493,"height":1408},…}, … 6 windows]
GET …/control/screenshot?maxWidth=600  200  image/png  72 978–76 159 B  x-rigs-scale: 6.4  x-rigs-display: DP-1  x-rigs-width: 600  x-rigs-height: 338
MCP mesh_screen (maxWidth 600)  → image 600×338, {"shot":"e648b139-…","scale":6.4,"display":"DP-1","width":600,"height":338}
```

Lease contention (caused by overlapping probes, not a machine fault):

```
GET …/control/windows      409  {"error":"Screen lease is held by miklos.mnagy@gmail.com on macbookpro","code":"busy"}
GET …/control/screenshot   409  {"error":"Screen lease is held by claude on macbookpro","code":"busy"}
MCP mesh_windows           error: Screen lease is held by local on macbookpro
audit (~/.rigs/logs/control.jsonl): {"op":"windows","ok":false,"caller":{"via":"tailscale","from":"magix-system","human":true},"error":{"code":"busy"}}
```

Re-run with all leases clear (all three cells per source observed with the final results in the matrix above):

```
magix → macbookpro   412 / 412      magix → mac   412 / 412      magix → magix-system   200 (windows) / 200 PNG 72 978 B
mac → macbookpro     412 / 412      mac → mac     412 / 412      mac → magix-system     200 (windows) / 200 PNG 76 159 B
```
