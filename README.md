<div align="center">

![Relay](./logo.png)

### GitHub Desktop for AI agents — powered by a FalkorDB Memory Graph.

*Git coordinates humans committing minutes apart. **Relay coordinates agents editing the same files right now** — file locks, dependency-aware locks, live patch sync, and one shared **FalkorDB knowledge & memory graph** across every agent and teammate.*

**Twelve agents on one repo, and none of them blind to the others.**

[**Watch the demo**](https://youtu.be/vUea5Qih-nM) · [**FalkorDB Memory Graph Docs**](./docs/MEMORY-GRAPH.md) · [**Engineering Blog Post**](./docs/BLOG-POST.md) · [**Full Documentation**](https://relay-brain.vercel.app/docs.html)

<br/>

<a href="https://www.falkordb.com"><img src="https://img.shields.io/badge/memory-FalkorDB%20Property%20Graph-dc2626?style=for-the-badge" alt="FalkorDB memory graph"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520-3c873a?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 20+"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb?style=for-the-badge" alt="MIT"></a>
<img src="https://img.shields.io/badge/login-not%20required-16a34a?style=for-the-badge" alt="No login">

<br/>

> 🏆 **Built for WeMakeDevs × FalkorDB — *Graph Hacks: Context for AI Agents* (Track 2: Agent Memory & Coordination)**
>
> Relay turns multi-agent chaos into a live **FalkorDB property graph** (`relay_<projectId>`) that links every person, agent, session, prompt, edit, lock contention, overlap, and architectural decision — giving agents shared memory *before* they edit and *at the exact moment of conflict*.
>
> 👉 **[FalkorDB Memory Graph Architecture & Setup (`docs/MEMORY-GRAPH.md`)](./docs/MEMORY-GRAPH.md)** · **[Engineering Blog Post: From Flat JSON to a FalkorDB Memory Graph (`docs/BLOG-POST.md`)](./docs/BLOG-POST.md)**

<br/>

**Works with**

<p align="center">
  <img src="./support_images/readme/cursor.png" alt="Cursor" height="46" />
  <img src="./support_images/readme/claude.png" alt="Claude Code" height="46" />
  <img src="./support_images/readme/copilot.png" alt="GitHub Copilot" height="46" />
  <br />
  <img src="./support_images/readme/codex.png" alt="Codex" height="46" />
  <img src="./support_images/readme/antigravity.png" alt="Google Antigravity" height="46" />
</p>

</div>

## The problem

Eighteen months ago you had **one** coding assistant. Today you probably have **three running at once** — Claude in one terminal, Cursor in another, Copilot in the editor. They all write to the same files, and not one of them knows the others exist.

Now put **four people** on that repo. That's **twelve agents**, editing the same code, blind to each other. You find out at the merge. Or you don't find out at all.

Git solved this for humans — but Git assumes people committing at human speed, minutes apart, one branch each. **Agents write at machine speed, in parallel, in the same directory.** There is no layer for that.

## The fix

```diff
- 12 agents · 12 blind writers · flat JSON amnesia · conflicts discovered at merge
+ 12 agents · 1 lock table · 1 FalkorDB memory graph · conflicts prevented at the edit
```

Relay sits under every agent as a **real-time coordination and graph-memory layer**. Pre-tool hooks claim a lock before an agent writes; post-tool hooks release it. And underneath the lock table, a **FalkorDB property graph** continuously connects every agent turn, file edit, prompt, lock contention, and decision so every agent understands *why* code looks the way it does and *what* other agents are doing right now.

> **One host, no backend.** One person runs `relay serve` — that machine *is* the server and hosts the room's FalkorDB graph. Teammates connect over a fast tunnel (Cloudflare Quick Tunnel, Tailscale Funnel, custom host URL, or ngrok), straight to that laptop. Nothing lives on infrastructure you do not own.

<div align="center">

![Relay Demo](./screenRec.gif)

**[Watch the full demo on YouTube](https://youtu.be/vUea5Qih-nM)**

</div>

---

## Memory Graph (FalkorDB) — Shared Context for Every Agent

Locks stop two agents from overwriting the same file at the same instant. **They don't tell the second agent *why* the file is taken, *which user prompt* caused a recent change, *what architectural decisions* govern the file, or *who on the team* owns that work area.**

Relay solves this with **one FalkorDB property graph per project** (`relay_<projectId>`). Every transcript turn, code edit, watcher patch, lock claim, contention block, and decision across all 5 supported agents (**Cursor, Claude Code, Codex, GitHub Copilot, and Google Antigravity**) and every teammate in a room flows into FalkorDB via idempotent, content-addressed `MERGE` batches.

### The FalkorDB Graph Schema

```mermaid
flowchart LR
  Person(["Person"]) -->|RUNS| Agent(["Agent"])
  Agent -->|RAN| Session(["Session"])
  Session -->|HAS_TURN| Turn(["Turn"])
  Session -->|MADE| Edit(["Edit"])
  Edit -->|MODIFIED| File(["File"])
  Agent -->|TOUCHED| File
  Session -->|HELD| File
  Edit -->|PROMPTED_BY| Turn
  Edit -->|EXPLAINED_BY| Turn
  Edit -->|SAME_CHANGE| Edit
  Contention(["Contention"]) -->|ON| File
  Contention -->|HELD_BY| Session
  Contention -->|WANTED_BY| Session
  Overlap(["Overlap"]) -->|ON| File
  Overlap -->|BETWEEN| Edit
  Decision(["Decision"]) -->|ABOUT| File
  Decision -->|DURING| Session
  Agent -->|DECIDED| Decision
  File <-->|CO_EDITED| File
  Agent <-->|OVERLAPS_WITH| Agent
```

```text
Person ──► Agent ──► Session ──► Turn
                        └──► MADE ──► Edit ──► MODIFIED ──► File ◄── ON ── Contention ──► HELD_BY ──► Session (its intent)
                                       └──► PROMPTED_BY ──► the user request behind the change
File ──► CO_EDITED ──► File   (PageRank = coordination hotspots, Label Propagation = functional work areas)
```

### Before vs. Now: Why FalkorDB Replaced Flat JSON

| Capability | Before (Flat `memory.json` + JSONL) | Now (FalkorDB Property Graph) |
|---|---|---|
| **Storage & retention** | Flat arrays capped at **2,000 events / 400 edits**; older sessions permanently lost on sync | Persistent **per-project multigraph** (`relay_<projectId>`) with in-place migrations and 90-day text pruning (`Meta.lastIngestAt`) — structural history never ages out |
| **Explaining a file ("Why?")** | 3 separate linear scans across `memory.json`, `decisions.jsonl`, and `collisions.json` with timestamp guessing | **1-hop OpenCypher traversal** (`(File)<-[:MODIFIED]-(Edit)-[:PROMPTED_BY]->(Turn)`) linking 100% of transcript edits to the exact user prompt (skipping filler like *"continue"* / *"yes"*) |
| **Lock denials at conflict time** | Blind refusal: *"File `src/auth.ts` is locked by Claude Code."* | **Intent-enriched refusal** (0 ms DB wait via FalkorDB-warmed intent cache): quotes the holder's active prompt (`They're working on: "switch the login flow to JWT tokens"`) |
| **Hotspots & work areas** | Simple edit counters; directory-only grouping | Native **FalkorDB graph algorithms**: `CALL algo.pageRank('File', 'CO_EDITED')` for coordination hotspots and `CALL algo.labelPropagation` for cross-folder functional communities |
| **Conversational recall** | Substring `.includes()` over capped recent chat array | **RediSearch full-text index** (`CALL db.idx.fulltext.queryNodes('Turn', $q)`) across every agent session and teammate |
| **Cross-machine room sync** | Disconnected union of teammate arrays | Unified room graph on the host; guests query the host's FalkorDB graph over the room tunnel with **zero local DB setup** |

### Context at the Moment of Conflict

When an agent's pre-tool hook is denied a lock, Relay enriches the refusal using the holder session's live intent from the graph (cached in-memory so the lock path never blocks on DB I/O):

```text
File `src/auth.ts` is locked by Claude Code:DESK:52b2…. Pick a different task.
They're working on: "switch the login flow to JWT tokens" (2 min ago).
```

### Context Before Acting (`relay_session_brief` & `relay_graph_query`)

`relay init` wires every agent (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`) to call **`relay_session_brief({ paths })`** before editing unfamiliar files, and exposes **`relay_graph_query`** with 10 named, read-only Cypher queries (`file_story`, `who_to_ask`, `contention_trace`, `search_memory`, `agent_activity`, `hotspots`, `overlaps`, `decision_trace`, `session_brief`, `overview`). Every response returns both the data and the exact Cypher query executed:

```cypher
// 1. file_story — Every change to a file with the user prompt that caused it
MATCH (f:File {key: $fileKey})<-[:MODIFIED]-(e:Edit)-[:BY]->(a:Agent)
WHERE NOT (e)-[:SAME_CHANGE]->()
OPTIONAL MATCH (e)-[p:PROMPTED_BY]->(u:Turn)
OPTIONAL MATCH (e)-[:EXPLAINED_BY]->(x:Turn)
OPTIONAL MATCH (s:Session)-[:MADE]->(e)
RETURN e.ts AS ts, a.label AS agent, a.login AS person, s.title AS session,
       u.text AS prompt, p.via AS via, x.text AS agentSaid, e.added AS added, e.removed AS removed
ORDER BY ts DESC LIMIT $limit
```

```cypher
// 2. contention_trace — Who blocked whom on a file, and what both agents were working on
MATCH (c:Contention)-[:ON]->(f:File)
WHERE $fileKey IS NULL OR f.key = $fileKey
OPTIONAL MATCH (c)-[:HELD_BY]->(hs:Session)<-[:RAN]-(ha:Agent)
OPTIONAL MATCH (c)-[:WANTED_BY]->(ws:Session)<-[:RAN]-(wa:Agent)
RETURN c.ts AS ts, c.attempts AS attempts, f.path AS file,
       coalesce(ha.label, c.holderLabel) AS holder, coalesce(c.holderIntent, hs.intent) AS holderWasDoing,
       coalesce(wa.label, c.wanterLabel) AS wanter, ws.intent AS wanterWasDoing
ORDER BY ts DESC LIMIT $limit
```

```cypher
// 3. hotspots — PageRank & Community Detection over the CO_EDITED projection
CALL algo.pageRank('File', 'CO_EDITED') YIELD node, score SET node.rank = score;
CALL algo.labelPropagation({nodeLabels: ['File'], relationshipTypes: ['CO_EDITED']})
YIELD node, communityId SET node.community = communityId;
```

### Start the FalkorDB Memory Graph in 3 Commands

```bash
relay graph up        # Starts FalkorDB in Docker (:6379) + FalkorDB Browser (:3010)
relay graph enable    # Saves URL (or pass falkor://user:pass@host:port for FalkorDB Cloud) & hot-enables
relay serve           # Open Mission Control → Memory Graph tab (http://localhost:3002/?tab=graph)
```

Full guide (Windows/macOS/Linux setup, FalkorDB Cloud, persistence, migrations & troubleshooting): **[docs/MEMORY-GRAPH.md](./docs/MEMORY-GRAPH.md)** · Deep-dive architecture writeup: **[docs/BLOG-POST.md](./docs/BLOG-POST.md)**.

---

## The five pillars

| | What it does |
|---|---|
| **Memory graph (FalkorDB)** | Every person, agent, session, prompt, edit, block, overlap, and decision across machines as one FalkorDB property graph. Agents query it *before* they act (`relay_session_brief`, `relay_graph_query`), and *at the moment of conflict*: a denied lock tells the blocked agent what the holder is working on. |
| **File locking** | Every agent write goes through a claim/release cycle against a shared lock table (TTL-based, auto-expiring). Destructive overwrites are blocked, not detected after the fact. |
| **Dependency-graph locking** | Files do not exist independently — one change can affect dozens. Relay parses imports with tree-sitter and asks *"does this change affect files another agent is working on?"*, not just *"is this exact file locked?"* Agents stay parallel; the blast radius stays safe. |
| **Patch sync across machines** | Your teammate has their own filesystem, environment, and agents. Relay propagates **patches**, not whole-project copies — `relay push` / `relay pull` keep every clone on the same working state. |
| **Mission Control** | One board for every agent on every machine: interactive **FalkorDB Memory Graph explorer**, live lock table, dependency lock graph, code edits, unified agent chat history, conflicts, presence. |

## Quick start

**Host** — the machine everyone else connects to:

```bash
relay login              # GitHub identity (uses the gh CLI)
relay clone <repo-url>   # clone + register workspace + install agent hooks
relay graph up           # start FalkorDB container (optional — or use FalkorDB Cloud)
relay graph enable       # enable the FalkorDB memory graph
relay serve              # API → 127.0.0.1:3001 · Mission Control → :3002
```

Then open Mission Control → **Team → Share** to start a tunnel (Cloudflare Quick Tunnel / Tailscale Funnel / custom URL) and mint the invite link.

**Teammate:**

```bash
relay serve              # their own local relay (queries host's FalkorDB graph over the tunnel)
# join with the host's invite link on the Team tab
relay pull               # take the host's current working state
```

Now start agents as usual. Hooks claim and release locks automatically — nobody has to remember a command.

<details>
<summary><strong>Install options</strong></summary>

<br/>

| Method | Command |
|--------|---------|
| local dev | `npm i`, then `npm link` in this repo |
| attach an existing repo | `relay add /path/to/repo` |
| fresh clone | `relay clone <url> [dir]` |

Requires **Node.js 20+** and **npm**. No hosted backend, no login server. The memory graph uses FalkorDB (`relay graph up` via Docker, or FalkorDB Cloud); without it, relay fails open and runs on files alone. See [**Dependencies**](#dependencies) below for install commands (`cloudflared`, `gh`, Docker, etc.).

</details>

## How it works

```text
  Cursor ──┐  pre-tool hook: claim
  Claude ──┤  post-tool hook: release      ┌──────────────┐
  Copilot ─┼──► lock table ◄── dep graph ──│ relay serve  │──► Mission Control (:3002)
  Codex ───┤        ▲                      │  (your host) │          ▲
  Antigravity ┘     │                      └──────┬───────┘          │
                    │       tunnel                │                  │
              teammate's relay ◄──── patches ─────┼──────────────────┘
                                                  ▼
                                         ┌─────────────────┐
                                         │    FalkorDB     │
                                         │  Memory Graph   │
                                         │ (per-project)   │
                                         └─────────────────┘
```

| Layer | Who runs it | What it guards / powers |
|-------|-------------|-------------------------|
| **Memory graph** | FalkorDB (`relay_<projectId>`) | multi-agent provenance (`PROMPTED_BY`), lock intent, PageRank hotspots, `relay_session_brief` |
| **Claim / release** | pre- and post-tool hooks | exclusive write access to a file |
| **Dependency graph** | tree-sitter import scan | files *affected by* the edit, not just the edit |
| **Room** | `relay serve` + tunnel (Cloudflare / Tailscale / custom) | one shared lock table and memory graph across machines |
| **Patches** | `relay push` / `relay pull` | working-tree state without full copies |
| **Board** | Mission Control (:3002) | interactive Memory Graph canvas + who holds what, right now |

> Locks and the board are separate subsystems — hooks arbitrate straight against the host, while the board and FalkorDB graph are fed asynchronously. `relay doctor` walks that chain and tells you which link is broken.

## Commands

| Command | Description |
|---------|-------------|
| `relay login` / `logout` / `whoami` | GitHub identity (via `gh` CLI, or device flow with `GITHUB_CLIENT_ID`) |
| `relay clone <url> [dir]` | git clone + register workspace + install agent hooks |
| `relay add <path>` | Attach an existing local repo |
| `relay init [path]` | Wire hooks, Relay MCP, and `/relay ask` instructions for all agents |
| `relay serve` | API on `127.0.0.1:3001` + Mission Control on `:3002` |
| `relay serve --no-ui` | API + coordinator only |
| `relay graph up` / `down` | Start or stop the local FalkorDB Docker container (`:6379` + Browser UI `:3010`) |
| `relay graph enable [url]` / `disable` | Enable FalkorDB memory graph (local Docker or `falkor://` Cloud URL) |
| `relay graph status` / `stats` / `rebuild` | Check FalkorDB health, inspect node/edge counts & migrations, or backfill history |
| `relay push` | Send your dirty working-tree files to the shared room |
| `relay pull` | Apply the host's current dirty files onto this clone |
| `relay status` | Health check (room, role, host, ports) |
| `relay mcp-url` | Print the MCP config for this room's shared-context endpoint |
| `relay doctor` | Diagnose Coordinator board, hooks, and FalkorDB graph connectivity |

## Mission Control

Started by `relay serve` — runs on your own machine, no hosted account.

| | URL |
|---|-----|
| Dashboard | http://localhost:3002 |
| Memory Graph Explorer | http://localhost:3002/?tab=graph |
| API | http://127.0.0.1:3001/api/health |

**Collisions prevented counter** (persisted to `~/.relay/data/projects/<id>/collisions.json` and mirrored to `<repo>/.relay/collisions.json`, with full `Contention` nodes and holder intents recorded in FalkorDB).

## MCP — shared room & graph context

Any MCP client can read the room's context and query the FalkorDB memory graph, **even on a machine with no relay or FalkorDB installed**:

```bash
relay mcp-url    # prints a ready-to-paste mcpServers block
```

Coordination tools (`relay_claim_file`, `relay_release_file`, `relay_status`) run against each member's own local relay. The room endpoint is **read-only** for anyone off the host machine.

<details>
<summary><strong>Tools exposed (17 MCP tools)</strong></summary>

<br/>

| Tool | Purpose |
|------|---------|
| `relay_session_brief` | **FalkorDB Memory Graph** brief for files you're about to touch: who's on them now and why, blocks, decisions, prompts behind changes, who to ask, and co-edited community files |
| `relay_graph_query` | **FalkorDB Memory Graph** named Cypher queries (`file_story`, `who_to_ask`, `contention_trace`, `search_memory`, `agent_activity`, `hotspots`, `overlaps`, `decision_trace`, `session_brief`, `overview`) |
| `relay_claim_file` | Acquire an exclusive write lock before editing |
| `relay_release_file` | Release the lock after editing |
| `relay_status` | View the full lock table |
| `relay_get_conflicts` | Overlapping edits in the last 5 minutes |
| `relay_get_recent_changes` | Recent `code_edit` events |
| `relay_get_chat_history` | Unified agent chat across every room member |
| `relay_room_brief` | Teammate activity + memory graph brief (for the `/relay ask` agent pseudo-command) |
| `relay_get_collision_stats` | Lifetime counters for collisions Relay prevented |
| `relay_report_change` | Push a code-change event |
| `relay_report_decision` / `relay_get_decisions` | Append / read file-scoped architectural decisions (synced to FalkorDB `Decision` nodes) |
| `relay_update_task` / `relay_get_active_tasks` | Append / read tasks (synced to FalkorDB `Task` nodes) |
| `relay_get_project_context` | Full JSON project context |
| `relay_sync` | Re-read agent transcripts into unified history and trigger FalkorDB ingest |

</details>

## Hooks

`relay clone` / `relay add` / `relay init` install pre-tool (**claim**), post-tool (**release**), pre-read, stop hooks, **Relay MCP** (`relay_session_brief`, `relay_graph_query`, `relay_room_brief`), and the relay-os instruction block into every agent surface:

| Agent | Hooks | Instructions | Relay MCP (`relay_session_brief` / `relay_graph_query`) |
|-------|--------|--------------|--------------------------------|
| Claude Code | `.claude/settings.json` | `CLAUDE.md` | `.claude/settings.json` → `mcpServers.relay` |
| Cursor | `.cursor/hooks.json` | `.cursor/rules/relay.mdc`, `AGENTS.md` | `.cursor/mcp.json` |
| Codex | `.codex/hooks.json` | `AGENTS.md` | `.codex/config.toml` → `[mcp_servers.relay]` |
| Copilot CLI | `.github/hooks/relay-os.json` | `.github/copilot-instructions.md` | `.github/mcp.json` |
| Antigravity | `.agents/hooks.json` | `AGENTS.md` | `.agents/mcp_config.json` |

Languages parsed for the dependency graph: TypeScript/JavaScript, Python, Go, Rust, Java, C#, C/C++, PHP, Ruby.

## Dependencies

| | |
|---|---|
| **Required** | **Node.js 20+** & `npm` |
| **Bundled** | `falkordb`, `express`, `cors`, `ws`, `@vscode/tree-sitter-wasm` · `next`, `react` (Mission Control) |
| **Graph DB** | **FalkorDB** (`relay graph up` via Docker, or [FalkorDB Cloud](https://app.falkordb.cloud)) |
| **Not needed** | MongoDB, Postgres, a hosted Relay backend, an account |
| **Optional** | `gh` CLI for `relay login` · `cloudflared` / Tailscale Funnel / custom URL for cross-machine rooms |

**Env vars:** `RELAY_FALKOR_URL` · `RELAY_FALKOR_TEXT` · `RELAY_FALKOR_TEXT_DAYS` (90) · `RELAY_PORT` (3001) · `RELAY_UI_PORT` (3002) · `RELAY_UI_ORIGIN` · `RELAY_TUNNEL` (`cloudflared`\|`tailscale`\|`ngrok`) · `RELAY_PUBLIC_URL` · `RELAY_PUBLIC_READONLY`

### Installing dependencies

#### 1. Node.js 20+ & npm *(Required)*

- **Windows (`winget`):** `winget install OpenJS.NodeJS.LTS`
- **macOS (`brew`):** `brew install node@20`
- **Linux (Ubuntu/Debian):** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`

#### 2. Docker Desktop / Docker Engine *(For local FalkorDB memory graph — or use FalkorDB Cloud)*

Used to run the local FalkorDB container via `relay graph up` (or skip Docker and connect to [FalkorDB Cloud](https://app.falkordb.cloud) with `relay graph enable falkor://default:PASSWORD@HOST:PORT`).

- **Windows (`winget`):** `winget install Docker.DockerDesktop`
- **macOS (`brew`):** `brew install --cask docker`
- **Linux:** `curl -fsSL https://get.docker.com | sh`

#### 3. GitHub CLI (`gh`) *(Optional — identity & room signaling)*

Used by `relay login` to attach your GitHub identity when hosting or joining rooms. After installing, run `gh auth login`.

- **Windows (`winget`):** `winget install GitHub.cli`
- **macOS (`brew`):** `brew install gh`
- **Linux (Ubuntu/Debian):** `sudo apt-get update && sudo apt-get install -y gh`

#### 4. Tunnel Provider for Cross-Machine Rooms *(Optional — room host only)*

Only the **room host** needs a tunnel when sharing a session across different networks. Pick any one:

- **Cloudflare Quick Tunnels (`cloudflared`) — Recommended** *(zero signup, no account, no rate limits)*:
  - **Windows (`winget`):** `winget install Cloudflare.cloudflared`
  - **macOS (`brew`):** `brew install cloudflared`
  - **Linux:** `curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared`
- **Tailscale Funnel (`tailscale`):**
  - **Windows (`winget`):** `winget install Tailscale.Tailscale`
  - **macOS (`brew`):** `brew install --cask tailscale`
  - **Linux:** `curl -fsSL https://tailscale.com/install.sh | sh`
  - Expose port: `tailscale funnel 3001`
- **Custom URL / Cloud VM:**
  - Set `RELAY_PUBLIC_URL=https://your-domain` or paste your public URL directly in Mission Control → **Team → Share**.

## Documentation

Full documentation lives in [`docs/`](./docs/README.md).

| | |
|---|---|
| **[Memory graph (FalkorDB)](./docs/MEMORY-GRAPH.md)** | **FalkorDB graph model, Cypher queries, PageRank/CDLP algorithms, migrations & setup** |
| **[Engineering blog post](./docs/BLOG-POST.md)** | **From flat JSON to a FalkorDB memory graph for AI coding agents** |
| [Quickstart](./docs/QUICKSTART.md) | Coordinating in about five minutes |
| [Installation](./docs/INSTALLATION.md) | Requirements, install methods, what gets written where |
| [Concepts](./docs/CONCEPTS.md) | Workspace, project, agent ID, lock, room, patch |
| [Rooms and teams](./docs/ROOMS.md) | Hosting, invites, member tokens, joining, leaving |
| [Architecture](./docs/ARCHITECTURE.md) | Process model, the two planes, one edit end to end |
| [Locking](./docs/LOCKING.md) | The lock table, TTLs, ownership, dependency-graph soft locks |
| [Sync and patches](./docs/SYNC.md) | Patch format, Lamport ordering, transform, transcripts |
| [CLI reference](./docs/CLI.md) | Every command, flag and exit code |
| [HTTP API reference](./docs/HTTP-API.md) | Every endpoint, with auth rules |
| [MCP reference](./docs/MCP.md) | The seventeen tools and the read-only room endpoint |
| [Hooks reference](./docs/HOOKS.md) | The hook contract per agent |
| [Configuration](./docs/CONFIGURATION.md) | Environment variables, ports, on-disk layout |
| [Troubleshooting](./docs/TROUBLESHOOTING.md) | `relay doctor` and the known failure modes |

## Roadmap

- **Git worktree isolation** — every agent in its own workspace off the same repository, free to experiment and test independently, integrated back into main when the work is ready.
- Richer conflict resolution on top of the existing OT / patch layer and FalkorDB overlap graph.

<div align="center">

**We used Relay to build Relay.** The problem we were solving was the problem we were having.

The next time you build a hackathon project, do not just add more agents. **Just relay.it**

<sub>MIT licensed · Powered by FalkorDB · Your machine is the server.</sub>

</div>
