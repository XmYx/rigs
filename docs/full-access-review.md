# Full access and control: independent review (t9)

Branch `work/magix-system/wayland-and-macos-full-access-452b`, commits e3c72a1..cf8509d (31 files, +4422/-11).
Reviewed 2026-10-17 on magix-system by team-review-opus.

## Checks re-run

- `npm test`: 168 pass, 0 fail, 0 skipped.
- `npm run build`: UI built to ui/dist.
- `src/migrations.js`: unchanged on this branch. No migration turns control on.

## Verdict by goal point

| Goal | Verdict | Evidence |
|---|---|---|
| Wayland access (screenshot, permissions) | **Done (GNOME)**. KDE/wlroots use the portal or CLI fallback and are not live-verified | t3: live 3840x2160 Mutter capture (`docs/control-implementation.md`); t2: `access.status` shows mutter/at-spi on magix-system |
| Wayland control (input) | **Done (GNOME, ASCII only)** | t3: click, ctrl+a and 37-char typed proof on live GNOME. Non-ASCII is refused on purpose after the SetKeymap crash |
| X11 still works | **Logic-verified only** | t7 found and 38cd719 fixed the `XDG_SESSION_TYPE=tty` and `ctrl++` defects. There was no live X11 run |
| macOS access | **Not built**: fails closed | t6: no `RigsControl.swift`, app or LaunchAgent. On macbookpro, status shows ready:false and actions return needs-permission. 365/0 tests pass on the Mac |
| macOS control | **Not built**: fails closed | as above |
| Windows not broken | **Unverified** (no node online). The PowerShell helper is untested | t3, t8 |
| Safety | **Good, with one item below** | see next section |

## Safety posture

- Off by default (`control.enabled`/`input` false). `control` is in the `patchConfig` blocked set (src/config.js:151), so a settings save cannot turn it on. The MCP server has no enable tool, and an agent enable is refused (t4 tests).
- The routes go through the existing `localApi` / node proxy (src/server.js:690). They carry no auth of their own, so they rely on the mesh's usual auth. "Human" means a request without `x-rigs-caller`, so anyone holding the mesh token counts as a person. This trade-off is documented in t4.
- The audit log is ~/.rigs/logs/control.jsonl, mode 0600, rotated at 5 MB. Every action is logged and announced, and a lease shows in the attention feed with a Stop button.
- The kill switch is persistent and covers the whole mesh (`/api/mesh/control/kill`).
- Tests use a `mkdtemp` RIGS_HOME. The control and access tests never touch ~/.ssh, ~/.claude or ~/.codex.

## Open issues

1. **High: the macOS helper does not exist.** The goal says "has to be macOS compatible", but macOS only fails closed today. The work left is to build `scripts/control/macos/RigsControl.swift`, the app, the LaunchAgent and the installer, then verify on the Mac.
2. **Medium: typed text goes into the audit log by default.** `auditPreview: 64` (src/config.js:100) stores the first 64 characters of any `type` call not marked `secret:true` (src/control.js:282). A password typed by an agent that forgets `secret` lands in plaintext in control.jsonl. Suggested fix: default to 0, or redact likely secrets.
3. **Medium: there was no live run on X11, KDE, wlroots or Windows.**
4. **Low: Mutter is a private API.** An experimental call has already crashed gnome-shell once (SetKeymap was removed). Watch for this after GNOME upgrades.
5. **Low: GNOME window list and focus need the Shell extension.** AT-SPI is only a partial fallback and misses Firefox and Unity.

## Not done in this review

I did not re-run a live screenshot or typing test. That needs `control.enabled` on magix-system, which only Sir may switch on. This seat also has no graphical session env. The t3 live evidence stands.

## Recommendation

The branch is safe to merge as it stands: everything is off by default and macOS fails closed. Still, the goal is **not complete** until the macOS helper is built, so track issue 1 as a follow-up project. Consider fixing issue 2 before Sir enables control anywhere.
