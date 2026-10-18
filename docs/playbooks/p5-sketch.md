---
title: Add or change a p5.js sketch for the Exhibit window
match: \bp5(?:\.?js)?\b|\b(?:exhibit(?:or|s)?|exhibit window)\b[^.\n]{0,40}\b(?:animation|sketch)
size: S
---
# Playbook: add or change an Exhibit p5.js sketch

One agent does this end to end. Typical cost: 1 function in `ui/src/p5-anim.js`, one line in `KIND_SKETCH`, one test run.

## Where it lives
- `ui/src/p5-anim.js` — the internal p5.js animation library. A sketch is `function name(p, ctx)` that sets `p.draw`
  (and `ctx.reset` to re-seed its state). `SKETCHES` registers it, `KIND_SKETCH` says which exhibit entry kind it illustrates.
  Read the header comment first: instance mode, p5 as a lazy chunk, own tick `ctx.t`, theme palette, pixel themes, pause off-screen.
- `ui/src/exhibits.js` — `mountFor` puts the sketch over a card's built-in SVG picture; it never covers a ComfyUI picture.
- `test/p5-anim.test.js` — runs every registered sketch against a fake `p` (bounds, finite numbers, determinism).

## Rules for a sketch
- Colors only from `ctx.pal` (`bg`, `a`, `b`, `text`, `warn`): never spell a color, so every theme just works.
- Time only from `ctx.t` (not `frameCount`): `ctx.t` is fast-forwarded for the still frame under reduced motion and Document view,
  so the composition must look finished after ~120 ticks. Use `EASE.*` for entrances.
- Size from `p.width` / `p.height` (they change on resize and in pixel themes); randomness from `p.random` / `p.noise` after
  `randomSeed(ctx.seed)` inside `ctx.reset`, so a card always looks the same. No DOM, no network, no timers.
- A frame is cheap: dozens of shapes, not thousands; 30 fps is set by the library.

## Steps
1. Add the sketch and register it (`SKETCHES`, `KIND_SKETCH`).
2. `npm run build && npm test`.
3. Look at it. Start a scratch daemon (`RIGS_HOME=$(mktemp -d) RIGS_NO_MIGRATIONS=1 RIGS_NO_AUTOUPDATE=1 RIGS_NO_OPENRIG=1 RIGS_PORT=4799 node bin/rigs.js serve`),
   put a document in `$RIGS_HOME/exhibits/pr-x.jsonl` (`{"t":"meta",...}` then `{"t":"entry","id","kind","title","caption","image":<svgImage(...)>,"at"}` lines;
   `src/exhibits.js` `svgImage` makes the picture), `POST /api/local/exhibits/config {"enabled":true}`, open the page, Experimental › Open the Exhibit window.
   Check the JARVIS and Atari themes (`data-theme="atari"`), reduced motion, and 390x844.
   Headless Chrome notes: on Ubuntu 23.10+ it needs `--no-sandbox` (wrap the binary; `tools/cdp-screenshot` takes `CHROME`), and CSS transitions/animations only advance
   between screenshots, so take a throwaway shot before reading state or capturing.
4. Commit once in the dev worktree.

## Don't
- Don't import p5 statically anywhere (it is ~1 MB; `p5-anim.js` loads it with `import('p5')` so it stays a lazy chunk).
- Don't move p5 to 2.x without re-checking instance mode and `redraw()` (the library relies on the 1.x synchronous setup).
- Don't add a second animation mechanism or build step.
