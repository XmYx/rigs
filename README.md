# RIGS OS

A JARVIS-style control plane for every workstation on your Tailscale network. Every machine
(macOS, Ubuntu Wayland, Windows) runs a small node; open the UI on any of them and you get every
machine, every coding agent and every chat session in one 3D "galaxy", plus a voice assistant that
can act on all of them.

![RIGS OS](docs/screenshot.png)

## What you get

- **The mesh as a galaxy.** Machines, agents (Claude Code, Codex, Ollama, OpenRig), models,
  projects and live sessions are nodes in a 3D force graph. Click one to focus it, then trace its
  connections 1–3 levels deep.
- **J.A.R.V.I.S.** You can talk to it (push-to-talk, or hands-free with the wake word "Jarvis" and
  barge-in) or type. Answers are spoken. You can switch the brain mid-conversation between Claude
  Code, Codex and any Ollama model on any machine, and the conversation carries over.
- **Terminals on any machine,** in the browser (xterm.js over WebSockets). They are shared, so
  several machines can watch and type into the same one.
- **Every coding and chat session, everywhere.** Claude Code and Codex history, OpenRig seats, tmux
  sessions, RIGS terminals and JARVIS chats from all machines in one list. Read transcripts, type
  into live sessions, or resume a session on the machine where its code lives.
- **Files on any machine.** Browse, preview, upload, download, rename, trash, and drag-and-drop or
  "copy to machine" between nodes.
- **Easy SSH.** Each node gets a mesh key and `~/.ssh/config` aliases. `ssh <machine>` works from
  every node to every other node, and Tailscale SSH is enabled on Linux.
- **Hardware-accelerated remote desktop** with Sunshine (host) and Moonlight (client): NVENC, VAAPI,
  QuickSync or VideoToolbox, and KMS capture on Wayland. RIGS pairs them automatically when you
  press 🖥. macOS Screen Sharing (High Performance), RDP and VNC are fallbacks.
- **OpenRig for agent teams.** Rigs and seats show up in the galaxy, `rig tui` opens from anywhere,
  and every peer is registered as an OpenRig host (`rig ps --all-hosts`).
- **Every agent knows REA and the mesh.** `rigs setup` runs `npx rea-agents@latest setup` for every
  detected coding agent. It also registers the `rigs` MCP server, whose `mesh_*` tools let Claude
  Code and Codex run commands, read and write files, drive sessions, start agents and ask other
  machines' brains anywhere on the mesh.
- **Changes ship from any node.** Each machine is a git checkout of this repo. An agent on any
  machine can edit RIGS, push to `main`, and call `mesh_update`. Every node then fast-forwards,
  rebuilds and restarts, and a crash-looping update rolls itself back.

## Install

Same Tailscale account on every machine. Then, per machine:

| OS | Command |
| --- | --- |
| macOS | `curl -fsSL https://raw.githubusercontent.com/XmXx/rigs/main/scripts/install.sh \| bash` |
| Ubuntu (Wayland or X11) | `curl -fsSL https://raw.githubusercontent.com/XmXx/rigs/main/scripts/install.sh \| bash` |
| Windows (admin PowerShell) | `irm https://raw.githubusercontent.com/XmXx/rigs/main/scripts/install.ps1 \| iex` |

To add hardware-accelerated remote desktop, prefix the command with `RIGS_DESKTOP=1` (on Windows it's
on by default). The full step-by-step guide is [docs/INSTALL.md](docs/INSTALL.md).

When it's done, open **http://localhost:4719** on that machine, or `http://<tailscale-ip>:4719`
from any other machine on the tailnet.

## How it works

```
 browser ──▶ node A (gateway, :4719) ──Tailscale──▶ node B /api/local/*   (HTTP + WebSocket proxy)
                │                                    node C …
                ├─ /api/local/*   files · pty · sessions · chats · exec · desktop · openrig · update
                └─ /api/nodes/<id>/* → the same API on any peer
 Claude Code / Codex ──stdio──▶ `rigs mcp` ──▶ local node ──▶ any node   (mesh_* tools)
```

- **Who may connect:** loopback, Tailscale devices owned by the same Tailscale user (verified per
  request with `tailscale whois`), or peers holding this node's mesh token (for non-Tailscale
  LANs). RIGS binds only to loopback and the machine's Tailscale IPs. It never binds 0.0.0.0
  unless you configure it to.
- **No secrets in the repo.** Tokens and Sunshine credentials live in `~/.rigs/config.json` on each
  machine.
- `rigs setup --https` puts the UI behind `tailscale serve`
  (`https://<machine>.<tailnet>.ts.net`). Browsers only allow the microphone on https or
  localhost.

## CLI

```
rigs setup     make this machine a node (MCP, agent instructions, REA, OpenRig, autostart)
rigs status    list machines           rigs open      open the UI
rigs ssh <m>   ssh to a node           rigs update --all   roll out the latest main everywhere
rigs notify …  speak on every open UI  rigs mcp       stdio MCP server for agents
```

## Developing

See [AGENTS.md](AGENTS.md). `npm test` boots a real node and exercises the API. CI runs it on
macOS, Ubuntu and Windows.
