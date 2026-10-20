# Windows CI failures (run 39482248591)

On `windows-latest` every run failed the same 12 tests (`# fail 12` of 1002). There is no Windows machine on
the mesh, so each cause was read from `gh run view 39482248591 --log-failed` and each fix has a
platform-neutral test that also runs on Linux.

| # | Test (file) | Windows log line | Root cause | Fix |
| --- | --- | --- | --- | --- |
| 153 | without uv: python -m venv and the venv pip (`appstore.test.js`) | `needs Python 3.11: install uv … or python3.11` / `'failed' !== 'done'` | `findPython` chose its candidates from the host OS (`isWin`), not the injected `deps.platform()`, so the faked Linux machine looked for `py`/`python` and found none | `pythonCandidates(ver, platform)` (pure) driven by `deps.platform()`; new tests for its Windows/Linux/mac lists and a faked Windows install (`py -3.11 -m venv`, then the venv's pip) |
| 154 | no user systemd: a launcher script is the launch recipe … (`appstore.test.js`) | launcher `argv` holds `…\apps\hello\app/server.mjs` | rendered arguments such as `{appDir}/server.mjs` kept the template's `/` after a native Windows path (only `argv[0]` was normalised) | `nativeArg` normalises absolute Windows paths in launch and post-install arguments (`nativeArg` unit test) |
| 159 | runtime.pipArgs: placeholders are rendered … (`appstore.test.js`) | `+ 'D:\\a\\rigs\\rigs/appstore/sources/acestep-studio/constraints.txt'` | same mixed separators in `pipArgs` (`{rigsApp}/…`) | `nativeArg` on rendered `pipArgs` |
| 468 | tasks enter via rig queue; a follow-up is queued … (`hubs.test.js`) | `OpenRig is not available on this machine` at `hubs.js` `up` | OpenRig runs on tmux, so `hubs.available()` is `false` on Windows by design; `sendToHub` → `up` refuses | queueing and follow-up assertions still run on Windows; there the test asserts the clear refusal instead of bringing a rig up |
| 470 | JARVIS gets a persistent rig whose overseer receives the intake … (`hubs.test.js`) | `OpenRig is not available on this machine` at `hubs.js` `up` | same: `up` is Linux/macOS only | overseer intake and fan-out assertions run everywhere; down/up/status (needs a running rig) asserts the refusal on Windows |
| 602 | scratch install: generated command starts the applet … (`navigation-store.test.js`) | `assert.ok(plan.dirs[0].startsWith(tmp))` | the test built the **darwin** plan on every host, so on Windows its data dir had `/` separators; the real Windows plan was never exercised | the test runs the host's own plan (`win32` on Windows) and splits the quoted command line; `splitCommand` test covers both lines |
| 774 | App Store API: catalog, install end to end … (`smoke.test.js`) | `The "string" argument must be of type string. Received type undefined` | on Windows the App Store registers `{ windows: { command } }`, so `app.launch.command` is undefined | assert on `app.launchHere.command`, the recipe this host runs (same check on Linux) |
| 775 | App Store MCP tools: appstore_list and appstore_install (`smoke.test.js`) | `+ 'installed'` / `- 'not-installed'` | knock-on of 774: it stopped before uninstalling `hello` | fixed by 774 |
| 778 | `test/smoke.test.js` (file-level `after` hook) | `EBUSY: resource busy or locked, rmdir …\apps\hello\app` | knock-on of 774 (app still running), and Windows frees a just-stopped process's folder a moment later | fixed by 774; `rmSync` retries (`maxRetries: 10`) |
| 851 | there are at least 6 seed tools and each folder is a valid tool (`toolbox-seeds.test.js`) | `app-publish: … 'main.mjs has CRLF line ends'` | `actions/checkout` on Windows uses `core.autocrlf=true`, turning the seed tools into CRLF | `.gitattributes`: `tools/** text=auto eol=lf` |
| 853 | seed sources have no BOM or CRLF (`toolbox-seeds.test.js`) | `app-publish/main.mjs has CRLF` | same | same |
| 869 | tools/applets.json describes every registered applet … (`toolbox-seeds.test.js`) | `Cannot read properties of null (reading '1')` | CRLF in `docs/tool-registry-survey.md`, so the `\n`-anchored JSON-block pattern found nothing | `.gitattributes`: `docs/tool-registry-survey.md text eol=lf` |

No assertion was removed. The only Windows-specific branches are the two OpenRig hub steps, which assert
the refusal that Windows gets by design.
