# The shared folder

Every RIGS node has one folder that it keeps in sync with the other online nodes, built into the daemon (no Syncthing,
no cloud drive). It is the **default place for work that belongs in no repository**:

| Subfolder | What goes there |
| --- | --- |
| `apps/<id>/` | ad-hoc apps agents build (web apps there are still published to the App Cloud) |
| `files/` | files made for Sir's requests |
| `reports/` | reports |

Code: `src/shared.js` (engine + routes), wired in `src/server.js`; tests in `test/shared-sync.test.js`.

## Where it is

`config.shared.path` per machine; empty means `~/RIGS-Shared` (`%USERPROFILE%\RIGS-Shared` on Windows). The name
has no spaces so agents can use it in shell commands without quoting. A throwaway node (its own `RIGS_HOME`, e.g. tests)
uses `<RIGS_HOME>/RIGS-Shared`, so it never touches the real folder. `RIGS_SHARED` overrides it. The folder and its
three subfolders are created at startup. A changed path applies after a restart.

- `rigs shared path` prints it; `rigs shared status` shows each peer's state; `rigs shared sync` syncs now.
- `@shared` or `@shared/reports/x.md` names it in any file API path (`files.resolvePath`) on the machine that resolves it.
- `ui_open` takes the place name `shared` (also `shared reports`, `shared apps`, `shared files`), and the
  file browser lists it as a root ("Shared").

Settings (`config.shared`): `enabled` (default true), `path`, `intervalSec` (60), `maxFileMb` (256), `ignore` (extra
globs like `*.log`, matched against each path segment).

## How it syncs

Each node keeps a manifest in `~/.rigs/shared/manifest.json` (outside the folder, so it never syncs):

```json
{ "files": { "reports/weekly.md": { "size": 812, "mtime": 1792523000000, "sha256": "ab12…", "hist": ["9f00…"] },
             "files/old.txt":     { "deleted": true, "size": 0, "mtime": 1792523100000, "sha256": "77aa…", "hist": [] } } }
```

`hist` lists the hashes this path held before (newest first, up to 16). A deletion leaves a tombstone (kept 30 days).

A **reconcile** scans the folder (unchanged size + mtime reuse the stored hash), then pulls from each online RIGS peer:
`GET /api/local/shared/manifest`, and `GET /api/local/shared/file?path=` for every file it needs, written through the
same temp-file + rename path as file uploads (`files.writeStream`) and stamped with the peer's mtime. Peer calls are
authenticated like every other peer call (Tailscale identity or the mesh token). It runs every `intervalSec`, when a
peer appears, on `POST /api/local/shared/sync`, and a couple of seconds after a local change (a debounced recursive
`fs.watch`). A local change also sends `POST shared/nudge` to the online peers, so they pull within seconds.

Per path, comparing our entry `L` with the peer's `R` (`decide()` in `src/shared.js`, pure and unit-tested):

| Situation | Result |
| --- | --- |
| same hash | nothing |
| we don't have it | pull |
| their history contains our hash (they edited our version) | pull |
| our history contains their hash (we edited theirs) | nothing; they pull from us |
| neither (both edited since a common version) | **conflict**: the newer mtime keeps the name; the other version is kept as `<name> (conflict <node> <date>).ext`, named after the node whose version lost and its mtime, so every node writes the same name |
| they deleted the version we have | move our copy to `~/.rigs/trash` (never unlinked) |
| we edited after the version they deleted | keep ours; it comes back to them |
| we deleted it, they edited after that version | pull |

A rename is a delete plus a create: the new name is pulled and the old one goes to the trash.

## Limits and safety

- Not synced: `.git`, `.hg`, `.svn`, `node_modules`, `__pycache__`, `.venv`, OS litter (`.DS_Store`, `Thumbs.db`,
  `desktop.ini`), temp and lock files (`*.tmp`, `*.swp`, `*.part`, `*.crdownload`, `*~`, `~$*`, `.~lock.*`, `.#*`),
  our own transfer temp files, symlinks, files over `maxFileMb`, and anything matching `config.shared.ignore`.
- Paths from the API or a peer's manifest must be relative: `..`, absolute paths, drive letters and NUL bytes are
  refused (400), and a symlink anywhere on the way is refused (403). A file being edited while a sync runs is left
  for the next run.
- Empty folders do not sync. Each node creates `apps/`, `files/` and `reports/` itself.
- Nodes running an older RIGS without the shared folder show as `unsupported` in `rigs shared status`.
