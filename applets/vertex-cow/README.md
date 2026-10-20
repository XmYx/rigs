# Vertex Cow

A 3D cow drawn only as glowing green points, spinning on a black background. Drag to turn it; it spins
again when you let go. With `prefers-reduced-motion` it keeps spinning, much slower.

- `server.js`: plain Node, no dependencies. Serves `public/` with relative URLs and `GET healthz` →
  `{"ok":true}`. `PORT` (default 8231), `HOST` (default 127.0.0.1).
- `public/cow.js`: the cow, built procedurally (barrel, neck, head, muzzle, horns, ears, legs, hooves,
  udder, tail), about 7,000 points from a seeded random source. There is no mesh file, so no third-party
  licence applies.
- `public/index.html`: a 2D-canvas perspective projection, DPR-aware, scaled to fit a small floating
  window or a 390x844 phone. Nothing is fetched from outside.

## Run and publish

```sh
PORT=8231 node applets/vertex-cow/server.js
```

Linux: fill in `rigs-vertex-cow.service.tmpl` (`{{INSTALL_DIR}}`, `{{NODE}}`, `{{PORT}}`), put it in
`~/.config/systemd/user/` and `systemctl --user enable --now rigs-vertex-cow`. Then register it:

```json
mesh_app_register { "node": "<machine>", "id": "vertex-cow", "name": "Vertex Cow", "icon": "🐄",
  "port": 8231, "healthPath": "/healthz",
  "launch": { "systemd": "rigs-vertex-cow.service",
              "command": "node applets/vertex-cow/server.js", "cwd": "<RIGS checkout>",
              "env": { "PORT": "8231" } } }
```

Tests: `test/vertex-cow.test.js`.
