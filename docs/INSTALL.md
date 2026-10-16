# Installing RIGS OS on each machine

Do these steps once per machine. Order doesn't matter: nodes find each other on their own as
soon as they share a tailnet.

## 0. Before you start (once)

1. **Tailscale.** Use one Tailscale account for all machines. In the
   [admin console](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and
   **HTTPS certificates**. HTTPS is only needed if you want voice from other machines.
2. **GitHub.** The repo is public, so installing needs no login. To let a machine push changes
   back, run `gh auth login` on it (as XmXx) once.

## 1. macOS (Apple silicon or Intel)

```bash
curl -fsSL https://raw.githubusercontent.com/XmXx/rigs/main/scripts/install.sh | bash
```

The script installs any missing Homebrew, git, tmux and Node 22, plus the Tailscale app. It also
installs Claude Code, Codex and Ollama (skip that with `RIGS_AGENTS=0`). Then it clones RIGS to
`~/.rigs/app` and runs `rigs setup`, which does the following:

- registers the `rigs` MCP server with Claude Code (`claude mcp add --scope user`) and Codex (`~/.codex/config.toml`)
- adds a mesh briefing (rigs MCP, REA, OpenRig, SSH aliases) to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`
- runs `npx rea-agents@latest setup --yes --client …` for every detected coding agent
- installs OpenRig (`@openrig/cli`), runs `rig setup`, and starts the OpenRig daemon
- creates the mesh SSH key, and installs a LaunchAgent so the node starts at login

**Then:**

1. Open **Tailscale** from Applications and sign in.
2. Turn on SSH: **System Settings → General → Sharing → Remote Login**.
3. Sign in to the agents: `claude` (then `/login`) and `codex login`.
4. **Optional, hardware-accelerated desktop:** rerun with `RIGS_DESKTOP=1`. This installs Moonlight
   and Sunshine (Sunshine on macOS is beta). Grant Sunshine **Screen Recording** and
   **Accessibility** access. For Mac↔Mac, built-in Screen Sharing in **High Performance** mode is
   also hardware accelerated, and RIGS uses it automatically.
5. Open the UI with `rigs open` or http://localhost:4719.

## 2. Ubuntu 22.04 / 24.04 (Wayland or X11)

```bash
curl -fsSL https://raw.githubusercontent.com/XmXx/rigs/main/scripts/install.sh | bash
# with hardware-accelerated remote desktop hosting:
RIGS_DESKTOP=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/XmXx/rigs/main/scripts/install.sh)"
```

The script uses sudo for apt, Tailscale and Sunshine. It installs:

- git, tmux, openssh-server, Node 22 (NodeSource), Tailscale, then runs `tailscale up --ssh`
- Claude Code, Codex and Ollama
- with `RIGS_DESKTOP=1`: the Sunshine `.deb` from GitHub with
  `setcap cap_sys_admin+p` (KMS capture on GNOME/KDE **Wayland**, no portal prompt), and Moonlight
  from Flathub. Encoding uses NVENC on NVIDIA, VAAPI on AMD/Intel.
- RIGS in `~/.rigs/app`, run as a `systemd --user` service with lingering enabled, so it runs
  without a desktop login

**Then:** sign in with `claude` and `codex login`, and open http://localhost:4719.

## 3. Windows 10 / 11

Open **PowerShell as Administrator**:

```powershell
irm https://raw.githubusercontent.com/XmXx/rigs/main/scripts/install.ps1 | iex
```

It uses winget to install Git, Node 22, Tailscale, Claude Code, Codex, Ollama, **Sunshine**
(NVENC/AMF/QuickSync) and **Moonlight**, then:

- enables **OpenSSH Server**, with PowerShell as the default shell and per-user `authorized_keys`
  for admins
- adds firewall rules that open ports 22, 4719 and Sunshine **to the tailnet range only**
  (100.64.0.0/10)
- installs a Task Scheduler entry that starts RIGS at logon, hidden

**Then:** sign in to Tailscale from the tray icon, sign in with `claude` and `codex login`, and
open http://localhost:4719.

**OpenRig on Windows:** OpenRig needs tmux, so it runs inside WSL. Set `$env:RIGS_WSL="1"` before
the installer (or run `wsl --install -d Ubuntu`), then run the Linux installer *inside* Ubuntu.
The WSL instance joins the mesh as its own node.

## 4. Check the mesh

On any machine:

```bash
rigs status          # every machine, OS, agents, Tailscale IP
ssh <other-machine>  # mesh SSH aliases are written automatically
rig host list        # peers registered as OpenRig hosts
```

In the UI, every machine should appear as a glowing node around **TAILNET**. Click one, then
press ⌨ Terminal, 📁 Files or 🖥 Desktop.

## 5. Voice from other machines (optional)

Browsers only allow the microphone on `https://` or `localhost`. To talk to JARVIS from a phone or
another machine:

```bash
rigs setup --https   # tailscale serve → https://<machine>.<tailnet>.ts.net
```

## 6. Brains, projects and tools

- **Core brain.** Click the badge under the orb and pick a machine, provider, exact model and
  effort. With "Core brain" ticked, the choice is saved on that machine and used for JARVIS and
  for planning. The default is `claude-opus-5-5` at high effort.
- **Projects.** Press 📋, describe a goal, then choose **Create & plan**. Review each task's
  machine, provider, model and effort (every row shows why it was chosen and can be changed), then
  press **▶ Dispatch ready tasks**. You can also say "Jarvis, plan a project to …".
- **Routing policy.** ⚙ → Routing has the rule table (kind and size → provider, model, effort;
  needs-tool; cross-check). Rules are per machine; the machine that owns a project applies its own.
- **Tools.** ⚙ → Tools: ComfyUI is detected automatically; add each new tool as you introduce it
  (id, task kinds it serves, URL or command, notes for agents).

## 7. Making changes from any node

1. Ask any agent (Claude Code or Codex, on any machine) to change RIGS. The repo is at
   `~/.rigs/app`, and its `AGENTS.md` explains the code.
2. The agent runs `npm test`, commits, and pushes to `main`. That machine needs `gh auth login`.
3. The agent calls the `mesh_update` tool, or you press **⟳ Update every machine** in ⚙ Mesh
   control.
4. Every node fast-forwards, reinstalls if dependencies changed, rebuilds the UI and restarts.
   Nodes with uncommitted local edits are skipped. Auto-update also checks every 10 minutes.

## Uninstall

```bash
rigs service uninstall && rm -rf ~/.rigs
```

Then remove the `rigs mesh` blocks from `~/.ssh/config`, `~/.ssh/authorized_keys`,
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, and run `claude mcp remove --scope user rigs`.
