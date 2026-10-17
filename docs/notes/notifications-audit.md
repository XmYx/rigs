# JARVIS centre notifications — audit and rules

Sir: the notifications in the top-centre of the JARVIS UI are too prominent. This note inventories
everything that lands in the `#toasts` column and fixes the rules the implementation tasks follow.
BEFORE screenshots: `img/before-1440x900.png`, `img/before-390x844.png`.

## 1. What lives in `#toasts`

`#toasts` (`ui/src/styles.css:216`): `position: fixed; top: 60px; left: 50%` centred column, `gap: 6px`,
`z-index: 9999`, `pointer-events: none` (children re-enable). It is created lazily by `toast()`
(`ui/src/api.js:85`) or `renderAttention()` (`ui/src/main.js:124`). The attention banner is always
prepended, so toasts stack under it.

| # | Element | Source (file:line) | Trigger / callers | Duration | Size | Colour | Animation |
|---|---------|--------------------|-------------------|----------|------|--------|-----------|
| 1 | `.toast` (info, default level) | `toast()` `ui/src/api.js:84-91`, css `styles.css:217` | ~80 call sites with no level: "New conversation", "Copied: ssh …", "Updating X…", "Copying … →", "Brain → …", "Hands-free…", "Stream ended", etc. | **5000 ms** (default `ms`), then 400 ms fade | padding 8×14, 12.5px, max-width 620px, one line | `--panel-solid` #0a1017 bg, `--line-strong` border (teal 32%) | opacity/translateY(-8px) fade-out (`.out`, 0.4s); shadow `0 8px 24px` |
| 2 | `.toast.ok` | same; css `styles.css:218` | success results: "Pinned …", "Uploaded …", "Moved to trash", update results, pairing OK; WS `notify` non-error (`main.js:214`) | 5000 ms default; callers pass 7000 (files.js:163), 8000 (mesh.js:68), 9000 (WS notify, main.js:214/451), 12000 (mesh.js:87, main.js:154/158) | as #1 | green border `rgba(74,222,128,.5)` | as #1 |
| 3 | `.toast.error` | same; css `styles.css:219` | every `catch (e) { toast(e.message,'error') }` (≈35 sites), "Gateway unreachable" (`main.js:196`), "X is offline" (`main.js:424`), WS notify with `level:'error'` | 5000 ms default; 8000 (`main.js:800,1060`), 9000, 10000 (`main.js:843`), 12000 (`main.js:756`) | as #1 | red border `rgba(248,113,113,.6)`, text `#fecaca` | as #1 |
| 4 | `.toast.info` explicit | `mesh.js:68` passes `'info'` | no CSS rule — renders identical to #1 | 8000 ms | as #1 | default | as #1 |
| 5 | `.toast` + action button | `toast(..., action)` `api.js:87`; `.toast-btn` `styles.css:255` | `attentionNotify` (`main.js:168`, "Answer"), WS notify with `action.type==='run'` (`main.js:213-214`, "Run"), Sunshine install (`main.js:451`, "Finish install") | 60000 ms for attn and run-actions; 9000 for "Finish install" | toast + `.btn.primary` button, margin-left 10px | as level | as level. Button click removes the toast and runs the action. |
| 6 | `.toast.attn` (60 s attention toast) | `attentionNotify()` `main.js:165-176`; css `styles.css:297` | WS `notify` with `level:'attention'` (`main.js:208-209`), emitted by `server.js:968-972` for each *new* attention item; also fires OS `Notification` (requireInteraction) when tab hidden | **60000 ms** | as #1 + "Answer" button | amber border `rgba(245,158,11,.85)`, text `#fde68a` | fade-out only (no glow on the toast itself) |
| 7 | `#attn` attention banner | `renderAttention()` `main.js:120-140`, css `styles.css:289-305` | `refreshAttention()` (`main.js:113`): `/api/mesh/attention` poll + on every attention notify; one banner for **all** waiting agents/blocked tasks | **Never expires**: shown while `attnItems().length > 0`, no way to close | width `min(640px, 100vw-32px)` (measured 640×134 at 1440, 358×186 at 390 with 2 items), up to 5 rows each with "⌨ Answer" + "◎" buttons | bg `rgba(28,17,3,.94)`, amber border `rgba(245,158,11,.7)`, head `#fbbf24` mono 12px | **`attn-glow` 1.1s infinite** (box-shadow 10→34px + border colour pulse); disabled only under `prefers-reduced-motion` (`styles.css:304`) |
| 8 | WS `notify` (normal) → toast | `connectEvents()` `main.js:207-215` | `/api/*/notify` (`server.js:741`, `mesh_notify`, planner, merge steward, update restarts). Level `error` → `.error`, anything else → `.ok`. Also `showSubtitle` + optional TTS | 9000 ms; 60000 ms if it carries a `run` action | as #1 | ok / error | as #1 |
| 9 | WS `notify` with `session` | `popups.handle(m)` `ui/src/popups.js:16-31`, `main.js:207` | Opens a terminal window for a new background agent session. **No toast of its own**; the same message still produces #8 (text) | n/a | n/a | n/a | window opens staggered 350 ms (`STAGGER_MS`) |

Not in `#toasts` but part of the same "agent needs you" signal and left alone by the first pass:
`#orb-wrap.alert canvas` pulse (`orb-alert`, 1.1s infinite), `.nlabel.attn` blink (`attn-blink`) on the
galaxy, and the `(n) ⚠` tab title. Only the banner glow is in scope.

### Why it feels too prominent
- Centre of the screen, directly over the galaxy, 620–640 px wide, opaque panel with heavy shadow.
- The attention banner glows continuously and never goes away; each new attention item also spawns a
  60 s toast with the same message → the same item is shown twice for a minute.
- Toasts have no close button and a fixed 5 s timer you cannot pause; `ok`/`error` toasts with
  long messages (stack of several) pile up down the middle.
- On a phone (390 px) the banner is 186 px tall and the toasts are full-width over the orb and dock.

## 2. Rules (target behaviour)

### Timeouts (auto-dismiss)
| Level | Default | Notes |
|-------|---------|-------|
| `info` (default) | **4 s** | |
| `ok` | **4 s** | |
| `error` | **8 s** | |
| `attn` toast | **20 s** | down from 60 s |
| any toast with an action button | **20 s** minimum | so the button is reachable; explicit longer `ms` passed by a caller is capped at 30 s |
| Callers passing `ms` | respected, but clamped to 3 s … 30 s | the 9000/12000 call sites keep working |

`toast()` keeps its signature `toast(text, level, ms, action)`; `ms == null` picks the level default
(change the default parameter from `5000` to `undefined`). `ms === 0` is not supported (no sticky toasts).

### Close
- Every toast gets a small **×** button (top-right, 16 px hit-area ≥ 24 px on touch) that dismisses
  immediately with the same fade-out. `Esc` is not bound (it belongs to windows).
- Clicking an action button also dismisses (unchanged).
- The attention banner gets the same **×**: it dismisses the banner only (not the agents' waiting state,
  the orb alert, tab title or galaxy highlights).

### Hover / focus pause
- Hovering a toast **pauses** its timer; leaving restarts it with the *full* remaining-time reset to
  **2 s minimum** (`max(remaining, 2000)`). Keyboard focus inside the toast pauses the same way.
- On touch devices (no hover) the timer is not paused; the × and a swipe-free tap are enough.
- Fade-out stays 300 ms; reduced-motion users get no translate, opacity only.

### Attention banner re-show
- Dismissing records the set of item `key`s currently shown (`dismissedKeys`, in memory, per session).
- The banner stays hidden while the current attention set is a **subset** of the dismissed keys.
- It comes back **only when a new item arrives** (a key that was not dismissed). Items that resolve
  and later re-wait count as new when their `since` differs from the dismissed one (store `key@since`).
- It also resets on page reload. It never re-shows on a timer.
- A new attention item still triggers the `attn` toast (20 s) so the arrival is visible even with the
  banner dismissed; the toast and the banner are not both fully visible for the same item: when the
  banner is showing, suppress the `attn` toast for items already in the banner (toast only when the
  banner is dismissed or the tab is hidden → OS notification as today).

### Stacking limit
- Max **4** visible toasts; the oldest is dismissed when a fifth arrives. Identical consecutive text
  within 2 s is coalesced (resets the timer instead of stacking).

### Target visual spec
- **Position:** top-right, `top: 12px; right: 12px`, column, `align-items: flex-end`; clear of the
  left panel and the filter panel at right (`top-right filters panel` starts ~12 px, so on desktop
  place the column under it: `top: 56px; right: 12px`, width ≤ 320 px; mobile: full width minus 16 px,
  `top: 8px`, centred). Not the middle of the screen any more.
- **Toast:** 12 px text, padding 6×10, `max-width: 320px` (mobile `calc(100vw - 16px)`), radius 8 px,
  background `rgba(10,16,23,.72)` with `backdrop-filter: blur(6px)`, 1 px border at ~35 % of the level
  colour, shadow `0 2px 8px rgba(0,0,0,.35)`, text clamped to 3 lines. Slide/fade in 180 ms, out 300 ms.
- **Close ×:** 14 px glyph, muted `#9fb2bf` at 70 % → 100 % on hover.
- **Attention banner:** same width as toasts (≤ 320 px), translucent `rgba(28,17,3,.72)`, 1 px amber
  border at 45 %, **no `attn-glow`** (static border), header 11 px, max **3** rows (`+N more` line),
  buttons `⌨ Answer` and `◎` kept but smaller (24 px). One calm 1.2 s fade-in only.
- **Motion:** no infinite animation anywhere in `#toasts`; the orb/galaxy attention pulses stay as the
  ambient signal. `prefers-reduced-motion` removes the slide.
- **Levels:** colour only on the border/left accent; text stays `#e6edf3`, except error `#fecaca` at
  90 % to keep contrast ≥ 4.5:1 on the translucent panel.

## 3. Implementation pointers (for the follow-up tasks)
- `ui/src/api.js:84` `toast()` — level default timeouts, ×, hover pause, stack cap, clamp.
- `ui/src/main.js:120` `renderAttention()` — × button, `dismissedKeys` logic; `main.js:165` `attentionNotify()` — 20 s, suppress when banner visible; `main.js:213` WS notify — pass `undefined` instead of 9000 for non-action.
- `ui/src/styles.css:216-220, 255, 289-305` — new position / translucency, remove `animation: attn-glow` from `#attn` (keep the keyframe unused or delete).
- Add a small pure helper (e.g. `ui/src/toasts.js`) for timeout/dismiss bookkeeping so it can be unit-tested like `popups.js`.

## 4. How the BEFORE screenshots were taken
`npm run build`, then `RIGS_PORT=4790 RIGS_HOME=$PWD/.rigs-dev RIGS_NO_AUTOUPDATE=1 RIGS_NO_MIGRATIONS=1 node bin/rigs.js serve`
(port 4719 was taken by the live daemon). Headless Chrome at 1440×900 and 390×844 (mobile emulation).
`/api/mesh/attention` was stubbed in the page with two waiting agents so the banner shows, and the
info / ok / error / attn toasts were inserted into `#toasts` with exactly the markup `toast()` produces
(`div.toast.<level>`, plus `button.btn.primary.toast-btn` for the action), because `toast` is not a
global and the headless WebSocket did not connect to push real `notify` messages.
