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
- **Choose the brain: machine, provider, exact model, effort.** The core brain defaults to
  Claude Opus 5.5 at high effort. It is JARVIS's voice and the project planner. Any Claude,
  Codex or Ollama model on any machine can be picked from the badge under the orb.
- **Plan projects and delegate every task.** Describe a goal and the core brain breaks it into
  tasks with dependencies. RIGS routes each task to a machine, provider, model and effort by
  policy:
  - Opus 5.5 for plans, architecture and elaborate code
  - Sonnet 5.5 for simpler algorithms, tests and research
  - Haiku 5.5 for docs and simple text
  - Codex for cross-check reviews of Claude's code
  - Ollama only for work marked private

  Each assignment shows its reason and can be changed per task. Dispatch runs every ready task as
  an **OpenRig** seat (runtime, model and effort set in a generated rig spec, with the task
  delivered as an owned queue item), or directly as an agent in tmux. Dependents start
  automatically when agents report done through the `project_task_update` MCP tool, or when
  they close their OpenRig queue item.
- **Tools, one at a time.** Machines advertise tools such as ComfyUI (auto-detected on :8188 or via
  the `comfy` CLI). You can declare any other tool in ⚙ → Tools. A task that needs a tool is routed
  only to machines that have it, and its brief explains how to use the tool.
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
- **Changes ship from any node, without overwriting each other.** An agent on any machine runs
  `rigs dev <topic>`, which gives it its own worktree on a `work/<machine>/<topic>` branch. It
  commits there and runs `rigs propose`. The **merge steward** (one machine with push rights) merges
  proposed branches one at a time onto the latest `main` and runs the build and tests:
  - If the merge is clean and the checks pass, it pushes `main` and every machine updates and
    restarts. A crash-looping update rolls itself back.
  - If there's a real conflict, it hands the conflicting files to a resolver agent (Opus).
  - If the tests fail, the branch goes back to the author with the log.
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

Agents get the same powers through MCP: `project_create` (goal → plan → routing → optional
dispatch), `project_list`, `project_get`, `project_dispatch` and `project_task_update`.

```
```

## Developing

See [AGENTS.md](AGENTS.md). `npm test` boots a real node and exercises the API. CI runs it on
macOS, Ubuntu and Windows.
