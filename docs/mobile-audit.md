# JARVIS UI — mobile & accessibility audit (baseline)

Project `e525365a44`, task t1. No product code was changed; this is the "before" picture for the fix tasks.

## How this was measured

- Build: `npm run build`; served with `RIGS_HOME=.rigs-dev RIGS_NO_MIGRATIONS=1 RIGS_NO_AUTOUPDATE=1 node bin/rigs.js serve` (port 4781 via `.rigs-dev/config.json`, because 4719 is the live daemon).
- Capture: `scripts/mobile-shots.js` (Playwright + Chromium headless-shell, `isMobile` + touch, DPR 1) at **390x844, 360x740** (portrait) and **844x390, 740x360** (landscape). Each view starts from a fresh browser context. Per view it saves a PNG, injects axe-core 4.14 and records layout/touch metrics into `report.json`.
- Re-run: `RIGS_AUDIT_TOOLS=<dir with playwright + axe-core> node scripts/mobile-shots.js --out docs/mobile-audit/after`. Playwright and axe-core are dev-only and are not in `package.json`.
- Screenshots: `docs/mobile-audit/before/<view>@<WxH>.png` (all 56 committed, ~6 MB). Raw data: `docs/mobile-audit/before/report.json`.
- Data was live (this machine's real mesh, 4 machines, ~50 sessions), so counts like "49 sessions" differ run to run.

Caveats: headless Chromium has no real touch keyboard, URL-bar collapse, notch or iOS Safari quirks, so safe-area, `100vh` and zoom-on-focus findings come from reading the CSS, not from pixels. The WebGL face renders via SwiftShader. The mic could not be granted, so voice views show the unsupported/permission state. The `overlaps` metric in the committed `report.json` includes the full-screen `#graph`; the script now excludes it, so ignore `#graph` pairs in the baseline file.

## Baseline axe-core violations

Each cell is **rules / affected nodes** (axe `violations` only, default ruleset).

| view | 390x844 | 360x740 | 844x390 | 740x360 |
| --- | --- | --- | --- | --- |
| orb-home | 2 / 15 | 2 / 15 | 2 / 15 | 2 / 15 |
| galaxy-graph | 1 / 10 | 1 / 10 | 1 / 10 | 1 / 10 |
| left-panel (search open) | 2 / 15 | 2 / 15 | 2 / 15 | 2 / 15 |
| panels-menu (☰) | 2 / 15 | 2 / 15 | 2 / 15 | 2 / 15 |
| brain-menu | 2 / 22 | 2 / 22 | 2 / 22 | 2 / 22 |
| window-files | 5 / 24 | 5 / 24 | 5 / 24 | 5 / 24 |
| terminal | 2 / 19 | 2 / 19 | 2 / 19 | 2 / 19 |
| projects | 2 / 19 | 2 / 19 | 2 / 19 | 2 / 19 |
| work-dashboard | 1 / 14 | 1 / 14 | 1 / 14 | 1 / 14 |
| sessions | 4 / 22 | 4 / 22 | 4 / 22 | 4 / 22 |
| apps-launcher | 2 / 18 | 2 / 18 | 2 / 18 | 2 / 18 |
| mesh-settings | 2 / 35 | 2 / 35 | 2 / 35 | 2 / 35 |
| stage-visual-cards | 2 / 18 | 2 / 18 | 2 / 18 | 2 / 18 |
| voice-controls | 2 / 16 | 2 / 15 | 2 / 16 | 2 / 16 |

axe results do not vary by viewport: the failures are semantic, not responsive. Rules seen:

| rule | impact | where |
| --- | --- | --- |
| `region` | moderate | every view: 10–34 nodes (graph canvas, `.scene-container` overlays, the whole fixed UI sits outside any landmark) |
| `landmark-unique` | moderate | every view with the side panel (`#left` is an `<aside>` and so is `#legend`/`#work`, none labelled) |
| `label` | **critical** | files window `.path-input` |
| `select-name` | **critical** | sessions window kind `<select>` |
| `label-title-only` | serious | files window `<select>` |
| `scrollable-region-focusable` | serious | `.file-list`, `.sess-list` (keyboard users cannot scroll them) |

Colour contrast was not reported: axe returns it as "incomplete" over the WebGL canvas and `backdrop-filter` panels. Findings A9 and A10 come from reading CSS values.

## Metrics worth knowing (390x844, orb-home)

- 47 visible interactive elements below 44x44 CSS px (51–66 in views with windows). Examples: panel collapse/close buttons 11x10 and 14x11, `.hub` rows 23 high, range sliders 16 high, checkboxes 13x13, `.round` toolbar buttons 34x34, `.win-btn` 24x22.
- 65 visible text nodes below 12px (up to 119 in the sessions window).
- No horizontal page scroll in any view (`html, body { overflow: hidden }` hides it rather than prevents it).
- `<meta name="viewport" content="width=device-width, initial-scale=1">` has no `viewport-fit=cover`; `safe-area-inset` appears nowhere in `ui/src/styles.css`.
- No page errors in any run.

## Issues

Severity: **High** = blocks a task on a phone, **Med** = hurts but has a workaround, **Low** = polish. Screenshot names are in `docs/mobile-audit/before/` (shorthand `@390` = `@390x844`, `@L` = `@844x390`).

### Layout

| # | Sev | Problem | Where | Screenshot | Fix |
| --- | --- | --- | --- | --- | --- |
| L1 | High | The side panel (`#left`) takes the top ~40% of the portrait screen and, in landscape, ~80% of the height and nearly the full width, leaving the galaxy a thin strip. The Inspector, Apps, Hubs, Forces and Display sections are all expanded on load. | `ui/src/styles.css:274-276` (`@media (max-width: 900px) #left { max-height: 38vh }`, no landscape rule); `#left` at `:32` | `orb-home@390`, `orb-home@844x390` | On narrow viewports start `#left` collapsed (panels.js already supports it) or make it a bottom/side sheet opened from a toolbar button. In landscape cap it to ~40vw. |
| L2 | High | Floating panels pile on top of each other: `#work` (top: 340px, fixed) sits on the graph under the side panel, the face (`#orb-wrap`) overlaps `#work`, the chat dock, the Brain badge and the toolbar. | `#work` `:386`; `#orb-wrap` `:79` + `:276`; `#chat-dock` `:96,:282` | `orb-home@390` | Define one mobile layout: a single stacked column or a small set of mutually exclusive sheets. Stop using fixed `top` values (`#work` at 340px) on small screens. |
| L3 | High | The orb panel's invisible resize handles (`.presize-*`) and the Brain badge sit on top of the toolbar buttons, so tapping 📋 Projects, 📊 Work and ▦ Apps does not hit the button. Playwright's tap failed with "`.presize-s` from `#orb-wrap` intercepts pointer events" for `#btn-proj`, `#btn-work`, `#btn-apps` and `#search`. | `ui/src/panels.js` `addResizeHandles` (8 handles per panel); `ui/src/styles.css:79,276,493-503` (`#orb-wrap` bottom: 120px overlaps `#bar`) | `projects@390`, `work-dashboard@390`, `apps-launcher@390` (the harness had to fall back to a DOM click) | Don't add resize handles (and drag grips) on coarse pointers: `@media (pointer: coarse) { .presize, .pgrip { display: none } }`. Move the orb above the toolbar and give it `pointer-events: none` except the canvas. |
| L4 | High | The bottom toolbar wraps into two rows (9 buttons + input) and the second row, with ⚙ and 🔊, is hidden behind or overlapped by the Brain badge (`#brain-badge`, `HAIKU-5-5 low · macb…`). Three buttons are partly covered. | `#bar` `:107-110,:278` (`flex-wrap`, `width: calc(100vw - 16px)`), `#brain-badge` `:83` | `orb-home@390`, `voice-controls@390` | Make the toolbar a single horizontally scrollable row or a "more" menu (✓ keep mic, hands-free, term, files, ⋯). Reserve the Brain badge its own row or move it into the ☰ menu. |
| L5 | Med | `#brain-menu` opens downwards (`top: 100%`) from the badge near the bottom edge and runs off the screen (bottom at 1048 vs viewport 844); the lower models are unreachable. | `ui/src/styles.css:84` (`#brain-menu { top: 100%; max-height: 50vh }`) | `brain-menu@390` | Anchor it upward (`bottom: 100%`) or as a bottom sheet with `max-height: calc(100dvh - …)`. |
| L6 | Med | Windows are clamped to `vw - 32` wide (no overflow at 360px; `clipped` is empty) but open at a cascading offset with height `vh - 140`, so they cover the chat dock and most of the toolbar and sit under the face. Maximize exists but is not the default. | `ui/src/wm.js:18-27`; `.win { min-width: 320px; min-height: 180px }` `styles.css:136` | `terminal@390`, `sessions@390`, `window-files@390` | On viewports ≤ 640px open every window maximized (`position: fixed; inset: 0` below a safe-area top) with a visible Close, and hide the drag-by-title behaviour. |
| L7 | Med | Landscape (≤ 400px tall) is poor: `#work` (top: 340px) runs to y=520 on a 390px-tall viewport and `#orb-wrap` starts at y=-4 (both reported in `metrics.clipped`), the side panel eats the screen (L1). No `orientation`/`max-height` media queries exist. | `styles.css` (only `max-width: 900px` and `640px`) | `orb-home@L`, `work-dashboard@L` | Add `@media (max-height: 480px)` rules: hide the face, collapse panels by default, make the toolbar a one-line rail. |
| L8 | Low | `#work` uses `100vh`; on mobile browsers `100vh` is taller than the visible area when the URL bar shows. | `styles.css:386`, `:100` (`30vh`) | — | Use `dvh` with `vh` fallback. |
| L9 | Low | No safe-area handling: with `viewport-fit=cover` unset iOS letterboxes landscape, and once it is set the bottom toolbar (`bottom: 10px`) and ☰ (`bottom: 10px`) would sit under the home indicator. | `ui/index.html:5`; `styles.css:107,351` | — (not reproducible headless) | Add `viewport-fit=cover` and `env(safe-area-inset-*)` padding on `#bar`, `#panels-btn`, windows. |

### Touch

| # | Sev | Problem | Where | Screenshot | Fix |
| --- | --- | --- | --- | --- | --- |
| T1 | High | Panel controls are 11x10–14x11 px (collapse ▾, close ✕, grip ⠿) at 35% opacity; the ✕ hides a panel until restored from ☰ (28x28, 55% opacity). Easy to hit by accident, impossible to hit on purpose. | `ui/src/panels.js` (`pctl`); `styles.css:338-343,351` | `orb-home@390` | Min 44x44 hit areas (padding), drop the 35% opacity on touch, or hide the panel chrome on touch devices and expose Close/Collapse via the ☰ menu. |
| T2 | High | Toolbar `.round` buttons are 34x34 with 6px gaps (< 44px recommended, 24px WCAG 2.2 AA minimum is met). Window title-bar buttons are 24x22 with an 8px gap; Maximize and Close sit next to each other. | `styles.css:111,141`; `ui/index.html:46-56` | `terminal@390`, `sessions@390` | 44px targets (`min-width/height: 44px` under `pointer: coarse`), enlarge Close and separate it from Maximize. |
| T3 | Med | List rows are 23px high (`.hub`, `.conn`, `.flt` with `padding: 3px 4px`), range sliders 16px, checkboxes 13px (`#d-labels`, `#d-particles`, `#d-rotate`). | `styles.css:52,57-59`; `ui/index.html:24-34` | `orb-home@390` | `@media (pointer: coarse)` padding for rows, bigger checkboxes (`width/height: 20px`) with labels as hit area, taller slider track. |
| T4 | Med | Drag/resize is pointer-only and the only way to move a panel is a 13px grip. Window drag uses `setPointerCapture` on `.win-bar` without `touch-action: none`, so a vertical drag on a title bar can scroll/pan the page instead of moving the window. | `ui/src/wm.js:41-55`; `styles.css:138` (`.win-bar` has no `touch-action`) | — (needs real touch) | Add `touch-action: none` to `.win-bar`; disable drag on small screens (see L6). |
| T5 | Med | Inputs are 13px (`#ask`, `.search`, `.path-input`, `.mini`): iOS Safari zooms the page on focus when font-size < 16px, and the fixed layout does not recover. | `styles.css:20,37,109,153,154` | — | `font-size: 16px` for inputs under `pointer: coarse`. |
| T6 | Low | Galaxy interactions are hover/click based (tooltips, `.scene-tooltip`), no tap hit slop on nodes, and labels are 11px. | `ui/src/graph.js`, `styles.css:114-133` | `galaxy-graph@390` | Increase node pick radius on touch; show node details in the Inspector on tap (already the case) and drop reliance on hover tooltips. |

### A11y semantics

| # | Sev | Problem | Where | Screenshot | Fix |
| --- | --- | --- | --- | --- | --- |
| A1 | High | Files window path input has no label (axe `label`, critical); its `<select>` is named by `title` only. | `ui/src/files.js:14,17,92` (`.path-input`, `select.mini[title=Roots]`, copy-to select) | `window-files@390` | `aria-label` on the input and select. |
| A2 | High | Sessions window kind filter `<select>` has no accessible name (axe `select-name`, critical). | `ui/src/sessions.js:15-16` | `sessions@390` | `aria-label="Filter by kind"`; likewise the "Filter sessions…" input (placeholder only). |
| A3 | High | Icon-only buttons (🎙 👂 ⌨ 📁 🖥 💬 📋 📊 ▦ ⚙ 🔊, ⏏, ✕, ▢, ↻) are named only by `title`, which is not exposed on touch and is inconsistent for screen readers. Toggle state (`.round.on` for hands-free, mute 🔊/🔇) is colour/emoji only — no `aria-pressed`. | `ui/index.html:46-56`; `ui/src/main.js:1011-1025`; `ui/src/wm.js:14-17`; `ui/src/panels.js` | `voice-controls@390` | Add `aria-label` from the current `title`, `aria-pressed` on mic/hands-free/mute. |
| A4 | High | The whole app is outside landmarks (axe `region`, 10–34 nodes per view). `#left`, `#legend`, `#work` are all `<aside>` without names (`landmark-unique`). There is no `<main>` or `<h1>`; `RIGS OS` is a `div`. | `ui/index.html` | every view | `aria-label` on each `<aside>`, wrap graph in `<main>`, `<nav aria-label>` for `#bar`, `<h1>` for the brand. |
| A5 | High | Scrollable lists cannot be reached by keyboard (`scrollable-region-focusable`). | `.file-list` (files.js), `.sess-list` (sessions.js) | `window-files@390`, `sessions@390` | `tabindex="0"` plus a label. |
| A6 | Med | Windows are plain `div`s: no `role="dialog"`, `aria-label`/`aria-labelledby`, focus move on open, focus return or Escape on close; closing a window leaves focus on `<body>`. | `ui/src/wm.js:14-39` | `terminal@390` | `role="dialog" aria-label=title`, focus the window on open, Escape closes, restore focus. |
| A7 | Med | Live regions are missing: `#subtitle` (JARVIS replies), `#orb-state` (listening/thinking/speaking), `#toasts` and the attention banner are not `aria-live`. Only 3 ARIA attributes exist in `ui/src/main.js`, 3 in `sessions.js`, 1 in `os.js`. | `ui/index.html:64-69,75`; `ui/src/main.js:70-73,112-114` | `stage-visual-cards@390` | `aria-live="polite"` on `#subtitle`, `#orb-state`; `role="status"` for toasts, `role="alert"` for the attention banner. |
| A8 | Med | The orb `<canvas id="orb">` and the WebGL graph (`canvas` in `#graph`) have no text alternative; the orb only has `title="Click to talk"` and is not focusable. Graph nodes are only reachable by pointer. | `ui/index.html:62`; `ui/src/orb.js`; `ui/src/graph.js` | `galaxy-graph@390` | `role="button" tabindex="0"` plus `aria-label` and Enter/Space on the orb; provide the Hubs list (already present) as the keyboard route and label it as such. |
| A9 | Med | Focus is invisible: `outline: none` on `#ask`, `.search`, `.path-input` and no `:focus-visible` rule anywhere; buttons rely on `:hover` only. | `styles.css:37,109,153` | — | Global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`. |
| A10 | Med | Low contrast text: `#footer` `#3b4b57` on `#04060a` is 2.25:1 (computed); panel controls are 11px `--muted` at `opacity: .35`; `.small`/`.ss` 11px muted text. (From CSS, not axe.) | `styles.css:116,339-343,351` | `orb-home@390` | Raise to ≥ 4.5:1 (`#footer` ≥ `#7d90a0`), remove `.pctl` opacity on focus/touch. |
| A11 | Low | Zoom is not blocked (good), but at 200% the fixed layout (L1–L4) breaks, so reflow (WCAG 1.4.10) effectively fails. | `ui/index.html:5` | — | Falls out of the layout fixes. |

### Motion / perf

| # | Sev | Problem | Where | Screenshot | Fix |
| --- | --- | --- | --- | --- | --- |
| M1 | Med | Three always-on render loops on a phone: the 3d-force-graph WebGL scene, the face (`face.js`, WebGL) and the 2D orb (`requestAnimationFrame(frame)` drawing 72 ticks + 5 arcs + radial gradient with `shadowBlur: 12` each frame, DPR-scaled canvas). Only the face checks `document.hidden` (`face.js:318`); the orb loop never pauses. | `ui/src/orb.js:43-90`; `ui/src/face.js`; `ui/src/graph.js` | `orb-home@390` | Pause the orb rAF when `document.hidden` or its panel is closed; render the orb at ≤ 30 fps when `state === 'online'`; drop `shadowBlur`; cap DPR to 2; make the face optional on small screens (`rigs.face` already exists). |
| M2 | Med | `backdrop-filter: blur(10px)` on every `.panel` and `#chat-dock` over a continuously animating canvas forces a re-blur each frame; the panel-reveal, `.floating` transitions (`filter: blur(2px)`) and window `win-materialise` add to it. | `styles.css:28,96,370,477` | — | Drop `backdrop-filter` below 900px (solid `--panel-solid`), remove `filter` from transitions. |
| M3 | Low | `prefers-reduced-motion` is honoured for panels/windows/visuals (`styles.css:305,380,458,483`) but not for the orb, face or graph (orbit, particles ("traffic"), `vz-bob`-like loops stay on) and the JS check in `wm.js:62` / `panels.js:84` is the only guard. | `ui/src/orb.js`, `ui/src/graph.js`, `ui/src/face.js` | — | When reduced motion is set: freeze the orb to a static ring, turn off orbit and particles by default. |

### Visual polish

| # | Sev | Problem | Where | Screenshot | Fix |
| --- | --- | --- | --- | --- | --- |
| V1 | Med | Typography is tuned for desktop: base 13px, many labels 10–11px (65 text nodes < 12px on the home view, 119 in the sessions window) in a monospace face; the Brain badge truncates to `HAIKU-5-5 low · macb…`. | `styles.css:20,24,83,111,133,182` | `orb-home@390`, `sessions@390` | Raise the floor to 12–13px on touch, keep 16px for inputs, show the model name only in the badge and move the rest to the menu. |
| V2 | Med | The face (`#orb-wrap #face`) is large (≈125px) and half-opaque over graph labels and the Work card; the "ONLINE" dot, Brain badge and orb ring stack into one clump at the bottom-right. | `styles.css:79-83,276` | `orb-home@390`, `galaxy-graph@390` | One compact status element (orb ring + state) above the toolbar; the face only when no panel is open. |
| V3 | Low | Graph labels overlap and clip at the edges (`.nlabel` 11–13px, no collision handling); labels such as `automation-suggest` run off the left edge. | `ui/src/graph.js`, `styles.css:121-130` | `galaxy-graph@390` | Cap label length and number on small screens (labels already toggle in Display). |
| V4 | Low | Empty/loading states: the Apps section says "No apps yet." with no hint, the terminal window shows a black pane until the session attaches. | `ui/src/apps.js`, `ui/src/terminal.js` | `terminal@390` | Add a one-line status ("Connecting…") to the terminal pane. |

## Suggested order for the fix tasks

1. **Mobile layout mode** (L1, L2, L3, L4, L6, L7, T1, T2): below 900px / coarse pointer, one stacked layout, collapsed side panel, windows maximized, no resize/drag chrome, single-row toolbar. This alone removes the unreachable buttons and most small targets.
2. **A11y semantics pass** (A1–A9): labels, landmarks, `aria-pressed`, live regions, dialog roles, focus-visible. Expected to take axe to 0 critical/serious and to drop `region`/`landmark-unique` to 0.
3. **Touch ergonomics** (T3–T6, L5, L8, L9, V1).
4. **Motion/perf** (M1–M3), then polish (V2–V4).

Success check for each later task: rerun `scripts/mobile-shots.js --out docs/mobile-audit/after` and compare `report.json` — axe rules/nodes per view, `smallTargets`, `clipped`, `overlaps` and the "obscured tap target" notes should all fall.

## t2 — phone layout and touch (done)

Phone mode applies below 640px wide, and to short touch screens in landscape (`(max-width: 640px), (max-height: 500px) and (pointer: coarse)`, `PHONE_QUERY` in `ui/src/mobile.js`). Wider screens keep the desktop layout. Code: `ui/src/mobile.js` (new), the `MOBILE LAYOUT (t2)` block at the end of `ui/src/styles.css`, phone hooks in `wm.js`, `panels.js` and `main.js`, and the viewport meta in `ui/index.html`.

The phone screen has four parts:
- **Header:** ☰ side panel, Fit and ↻ on the left; the orb and brain badge on the right.
- **Galaxy:** full screen behind everything.
- **Chat dock:** full width, above the toolbar.
- **Toolbar:** one row with Ask, 🎙 and ⋯. The ⋯ sheet holds the other ten controls as labelled 64px tiles, plus Layout (☰ panels).

The side panel becomes a slide-over drawer with a backdrop. It closes with ✕, a tap on the backdrop or Escape, and tapping a galaxy node opens it on the Inspector. Windows open full-screen inside the safe areas with a 44px ✕; Maximize, drag and resize are hidden. Each phone window pushes a history entry, so the browser or OS back gesture closes it. The Work dashboard starts closed on phones and opens as a sheet under the header.

| # | Status | How |
| --- | --- | --- |
| L1 | fixed | `#left` is a drawer (`min(340px, 86vw)`, hidden until ☰), so the galaxy gets the whole screen in both orientations |
| L2 | fixed | One phone layout: header, dock and toolbar are anchored to the edges. `#work` drops its fixed `top: 340px` and is closed by default |
| L3 | fixed | Resize handles and drag grips are hidden on coarse pointers. The orb sits in the header, away from the toolbar. Projects, Work and Apps taps land |
| L4 | fixed | A one-row toolbar (Ask · 🎙 · ⋯) and the brain badge moved to the header |
| L5 | fixed | `#brain-menu` is `position: fixed` under the header, with `max-height` set to the space left |
| L6 | fixed | Windows are full-screen on phones (inline sizes overridden). Close is 44×44, and back closes them too |
| L7 | fixed | The same phone layout applies to short touch landscape screens (844×390, 740×360) |
| L8 | fixed | Every `vh` has a `dvh` partner (`#work`, `#left`, `#brain-menu`, `#subtitle`, `#face.big`); phone rules use `dvh` |
| L9 | fixed | `viewport-fit=cover`; `env(safe-area-inset-*)` on the header, toolbar, dock, sheets, drawer, toasts and windows |
| T1 | fixed | Panel chrome is hidden on phones; Work and Chat keep a 44px ✕; the drawer has its own 44px ✕ |
| T2 | fixed | `.round` and `.win-btn` are 44×44 with 8px gaps; Maximize is hidden next to Close |
| T3 | fixed | Rows, buttons, selects, inputs, tabs and summaries are at least 44px on phones. Sliders are 44px tall; checkboxes are 22px inside labels at least 44px tall |
| T4 | fixed | `.win-bar { touch-action: none }`, and window drag is off on phones |
| T5 | fixed | Inputs, selects and textareas are 16px on coarse pointers and phones |
| T6 | partly | Tapping a node opens its Inspector in the drawer. Pick radius and label density are left to t4 |

Other phone changes:
- **Pinch zoom:** stays enabled (`user-scalable` was never set). Once the page is zoomed (`visualViewport.scale > 1`), the galaxy releases one-finger pans (`body.zoomed`), so nobody gets stuck zoomed in.
- **Scroll chaining:** scroll areas (windows, drawer, dock, sheets, `.xterm-viewport`) use `overscroll-behavior: contain`, and the page uses `none`.
- **On-screen keyboard:** `interactive-widget=resizes-content` handles Android. On iOS, `mobile.js` sets `--kb` from `visualViewport`, which lifts the toolbar, dock, sheets and window bottoms above the keyboard.
- **Wide-tab windows:** the Mesh window's tabs scroll sideways inside their strip. List-and-detail windows (files, sessions, projects) stack the list over the detail, and the detail grows once something is selected.

Check: `scripts/mobile-shots.js` now reports `overflow` per view and, on touch viewports, `smallTargets`; an input is measured by its `<label>`. It ends with a `CHECK` line, and `--strict` makes failures exit 1. A width of 1024 or more is captured as a desktop. `--url` now works. Results are in `docs/mobile-audit/after-layout/` (390x844, 360x740, 1440x900).

Not verifiable headless: the real iOS keyboard, the notch and home-indicator insets, and touch scrolling inside xterm. These follow from the CSS and the `visualViewport` code, not from pixels.

## t4 — visual polish and performance

Reports and captures: `docs/mobile-audit/after-polish/` (Lighthouse JSON + HTML, `perf.json`, 15 PNGs at 390×844, axe `report.json`), `docs/mobile-audit/before-polish/` (same probes against commit 616b74c, i.e. t2 + t3 without t4). Probes: `scripts/mobile-perf.js` (390×844 @3x, touch, 4× CPU throttle, 15 s idle after load, then a hidden tab) and Lighthouse mobile (default throttling).

### What changed
- **PWA**: `ui/manifest.webmanifest` (standalone, `#04060a`), icons `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`; `theme-color`, `color-scheme`, `mobile-web-app-capable`, `apple-mobile-web-app-*`, description. Static icons/manifest are cached for an hour (`src/server.js`). Chromium `Page.getAppManifest` reports 0 errors and `Page.getInstallabilityErrors` is empty.
- **Type, measure, spacing** (`POLISH (t4)` block in `styles.css`): scale tokens (12/13/14/16px), nothing below 12px on phones (it was 10–11px mono), 14px/1.5 body, 15px reply text, 8/12/16px spacing tokens, 68ch line length for running text, `overflow-wrap: anywhere`.
- **Touch feedback**: `:active` (colour + 0.97 scale) for buttons, pills, tiles and rows; hover looks are reset under `(hover: none)` so a tap leaves nothing stuck; `touch-action: manipulation`; no tap-highlight flash.
- **Visual cards at 390px**: weather decoration hidden, 4-up forecast, metrics grid with ellipsised labels, 2-column status tiles, shorter bar chart, 12px code. Reduced motion renders count-ups and the typewriter at their end state.
- **Galaxy budget on phones / data-saver / ≤2 GB devices** (`ui/src/perf.js`): pixel ratio 1 (orb and face capped at 1.5), no bloom pass, 8-segment nodes, 800 stars, no link particles or node pulsing, orbit off by default, 150-tick layout instead of 400. Larger invisible hit spheres make nodes easier to tap on coarse pointers (T6).
- **Pausing**: the galaxy render loop stops when the tab is hidden and resumes on return; the orb and face loops idle while hidden; the 15 s and 4 s polls skip hidden tabs and refresh on return. On low-power devices an idle galaxy (no orbit, no alerts, no input for 6 s) stops drawing until the next touch, key or data change.
- **Lazy init**: the WebGL face is only created when wanted (phones: after “show your face”), and xterm lives in a lazy chunk (`terminal-lazy.js`, esbuild `splitting`) that loads on the first terminal.

### Numbers (same machine, same live mesh; Chromium headless, software GL, machine load ≈ 150, so absolute values are pessimistic and noisy)
| Metric | Before (616b74c) | After |
| --- | --- | --- |
| Entry bundle `app.js` | 1876 KB (516 KB gzip) | 1516 KB (419 KB gzip) |
| Lazy chunk (xterm), loaded on first terminal | — | 362 KB (190 KB gzip) |
| `app.css` | 48.9 KB (11.9 KB gzip) | 51.8 KB |
| Idle FPS, 4× CPU (4 runs / 3 runs) | 0.2–1.1 (median 0.4) | 1.7–57 (median 21.7) |
| Long-task time in 15 s (4× CPU) | 16.2–32.5 s | 1.2–15.5 s (median 10.0 s) |
| Main-thread busy, 15 s idle | 113–227 % of one core-second per second | 49–105 % (median 77 %) |
| Main-thread busy, hidden tab | 119–311 % | 4–7 % (one run 67 % under contention) |
| Load → idle, 4× CPU | 11–29 s | 1.8–2.5 s |
| Lighthouse mobile performance | 26 | 42 |
| Lighthouse FCP / TBT | 10.5 s / 3390 ms | 1.1 s / 1880 ms |
| Lighthouse accessibility / best practices / SEO | 100 / 100 / 82 | 100 / 100 / 91 (`meta-description` fixed; `robots-txt` remains) |

Lighthouse performance stays low in absolute terms: the three.js galaxy (≈1.2 MB) must run before the first useful screen, and the run is software-rendered. The criterion is “not below baseline”: 26 → 42 (an earlier run scored 30 before the lazy chunk and FCP fix).
