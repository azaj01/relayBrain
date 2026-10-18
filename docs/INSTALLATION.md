# Installation

---

## Requirements

| | |
|---|---|
| **Required** | Node.js 20+ (`package.json` declares `engines.node >= 20`), npm |
| **Bundled** | `express`, `cors`, `ws`, `@vscode/tree-sitter-wasm`, `falkordb` (client); `next` and `react` for Mission Control |
| **Not needed** | MongoDB, Redis, a hosted backend, an account |
| **Optional** | [`gh` CLI](https://cli.github.com) for `relay login`; [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) / [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) / custom URL (or [ngrok](https://ngrok.com)) for cross-machine rooms; [Docker](https://www.docker.com/products/docker-desktop/) (or hosted [FalkorDB Cloud](https://app.falkordb.cloud)) for the [memory graph](./MEMORY-GRAPH.md) |

Coordination needs no database: Relay keeps locks, history and room state in JSON files
under `~/.relay` and `<repo>/.relay`. The optional memory graph adds a FalkorDB database
(`relay graph up`); without it, everything else works exactly the same.

### How to install required & optional tools

#### 1. Node.js 20+ & npm *(Required)*

- **Windows (`winget`):** `winget install OpenJS.NodeJS.LTS`
- **macOS (`brew`):** `brew install node@20`
- **Linux (Ubuntu/Debian):** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`

#### 2. Docker Desktop / Docker Engine *(Optional — local FalkorDB memory graph)*

For `relay graph up` (alternatively, use [FalkorDB Cloud](https://app.falkordb.cloud) with `relay graph enable --url ...`):

- **Windows (`winget`):** `winget install Docker.DockerDesktop`
- **macOS (`brew`):** `brew install --cask docker`
- **Linux:** `curl -fsSL https://get.docker.com | sh`

#### 3. GitHub CLI (`gh`) *(Optional — for `relay login` and room signaling)*

Install `gh` and authenticate once with `gh auth login`:

- **Windows (`winget`):** `winget install GitHub.cli`
- **macOS (`brew`):** `brew install gh`
- **Linux (Ubuntu/Debian):** `sudo apt-get update && sudo apt-get install -y gh`

#### 4. Tunnel Provider for Cross-Machine Rooms *(Optional — room host only)*

Only needed by the room host when sharing across networks:

- **Cloudflare Quick Tunnels (`cloudflared`) — Recommended** *(zero-signup, no rate limits)*:
  - **Windows (`winget`):** `winget install Cloudflare.cloudflared`
  - **macOS (`brew`):** `brew install cloudflared`
  - **Linux:** `curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared`
- **Tailscale Funnel (`tailscale`):**
  - **Windows (`winget`):** `winget install Tailscale.Tailscale`
  - **macOS (`brew`):** `brew install --cask tailscale`
  - **Linux:** `curl -fsSL https://tailscale.com/install.sh | sh`
  - Run `tailscale funnel 3001`
- **Custom URL / Cloud VM:**
  - Set `RELAY_PUBLIC_URL=https://your-domain` or paste the URL in the **Team** tab in Mission Control.

---

## Installing the CLI

### From this repository

```bash
git clone https://github.com/prakrititz/relayBrain.git
cd relayBrain
npm install
npm link
```

`npm link` registers the `relay` bin declared in `package.json` (`cli/relay.js`).

### Without linking

Both of these work from the repository root:

```bash
npm run relay -- <command>
npx relay <command>
```

Agent instruction files tell agents to fall back to `npx relay` when `relay` is not on
`PATH`.

---

## Attaching a repository

| Goal | Command |
|---|---|
| Repo already on disk | `relay add /path/to/repo [name]` |
| Repo not cloned yet | `relay clone <url> [dir]` |
| You are inside the repo | `relay init [path]` |

All three register the project and install hooks. `relay init` additionally installs the
**global** hook configuration (see below), so agents started outside a registered workspace
still reach Relay.

---

## What gets written

### Into the repository

| Path | Purpose |
|---|---|
| `.claude/settings.json` | Claude Code hooks **and** `mcpServers.relay` |
| `.cursor/hooks.json` | Cursor hooks (`preToolUse`, `postToolUse`, `beforeReadFile`, `stop`) |
| `.cursor/mcp.json` | Cursor MCP server entry |
| `.cursor/rules/relay.mdc` | Cursor always-apply rule carrying the relay-os block |
| `.codex/hooks.json` | Codex hooks |
| `.codex/config.toml` | Codex MCP server (`[mcp_servers.relay]`) |
| `.github/hooks/relay-os.json` | Copilot CLI hooks |
| `.github/mcp.json` | Copilot CLI MCP server (`type: "local"`, `tools: ["*"]`) |
| `.github/copilot-instructions.md` | relay-os instruction block |
| `.agents/hooks.json` | Antigravity hooks (keyed by hook name, `relay`) |
| `.agents/mcp_config.json` | Antigravity MCP server entry |
| `AGENTS.md`, `CLAUDE.md`, `.cursorrules` | relay-os instruction block |
| `.relay/AGENT_BOOTSTRAP.md` | The file every agent is told to read first |
| `.relay/room.json` | Room membership for this workspace, when in a room |
| `.relay/coordinator-state.json` | Live coordinator and API ports |
| `.relay/locks/*.lock` | On-disk lock files (also the fail-open fallback) |
| `.relay/collisions.json` | Human-readable mirror of the collision counters |
| `.relay/deps.json` | *Optional, yours to write* — dependency graph overrides |

The instruction block is delimited by `<!-- BEGIN:relay-os -->` / `<!-- END:relay-os -->`
markers and is replaced in place on reinstall, so your own content in `AGENTS.md` and
`CLAUDE.md` is preserved.

Consider adding `.relay/` to `.gitignore` if you do not want lock and room state in
version control. `collisions.json` is deliberately mirrored into the repo so the counter
is git-visible if you want it there.

### Into your home directory

Written by `relay init`, and also on every `relay serve` start (best-effort):

| Path | Purpose |
|---|---|
| `~/.relay/data/registry.json` | Projects and users |
| `~/.relay/data/session.json` | Signed-in user, selected project |
| `~/.relay/data/projects/<id>/memory.json` | Unified history, chats, edits, patches |
| `~/.relay/data/projects/<id>/collisions.json` | Authoritative collision counters |
| `~/.relay/room.json` | Room membership, machine-wide |
| `~/.relay/coordinator-state.json` | Coordinator and API ports |
| `~/.relay/locks/` | Lock files for workspaces whose own `.relay` is unwritable |
| `~/.relay/hook-debug.log` | Only when `RELAY_HOOK_DEBUG=1` |
| `~/.claude/settings.json` | Global Claude Code hooks + MCP (merged, not overwritten) |
| `~/.cursor/hooks.json`, `~/.cursor/mcp.json` | Global Cursor hooks + MCP |
| `~/.codex/hooks.json`, `~/.codex/config.toml` | Global Codex hooks + MCP |
| `~/.copilot/mcp-config.json` | Global Copilot MCP |
| `~/.gemini/config/hooks.json` | Global Antigravity hooks |
| `~/.gemini/config/plugins/relay/hooks.json` | Antigravity plugin-bundle hooks |

If a workspace's `.relay` directory cannot be created — a missing drive letter, an
unplugged disk, a host path from another OS — Relay falls back to a hashed subdirectory
under `~/.relay/locks/` rather than failing the claim.

---

## Signing in

```bash
relay login     # via the gh CLI
relay whoami
relay logout
```

`relay login` shells out to `gh` first. If that fails and `GITHUB_CLIENT_ID` is set, it
falls back to the OAuth device flow and prints a verification URL and code.

For browser sign-in from Mission Control, set both `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` and use **Continue with GitHub**; the callback is served at
`/api/auth/github/callback`.

Identity is not required to run Relay solo, but it is required to host or join a room, and
it is what puts a name rather than a hostname next to a lock.

---

## Running

```bash
relay serve            # API :3001, coordinator (ephemeral), Mission Control :3002
relay serve --no-ui    # API + coordinator only
relay serve --port 4001
```

For development on Relay itself, `package.json` also offers:

```bash
npm run dev       # API + Mission Control dev server, concurrently
npm run dev:api   # API only
npm run dev:ui    # Mission Control only
npm start         # node backend/server.js --port 3001
npm run coordinator   # standalone coordinator process
```

Mission Control is a Next.js app in `mission-control/` and is an npm workspace of the root
package, so a single `npm install` at the root installs it too. `relay serve` runs it with
`next dev`; if a static export exists at `mission-control/out`, the API server serves it
directly from `/`.

---

## Updating

Pull, reinstall dependencies, and re-run the installer so hook commands point at the new
paths:

```bash
git pull
npm install
relay init /path/to/repo
```

Hook commands are absolute paths into this repository's `hooks/` directory, so moving or
renaming the Relay checkout requires re-running `relay init`.

---

## Uninstalling

1. `npm unlink relay` (or `npm rm -g relay`).
2. Delete `.relay/` and the agent config files listed above from any repository you
   attached — or just delete the `hooks` and `mcpServers.relay` entries if you keep other
   configuration in those files.
3. Delete `~/.relay/` to remove all local state.
4. Remove the Relay entries from the global agent configs in your home directory.
