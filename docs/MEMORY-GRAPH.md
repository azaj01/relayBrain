# Memory graph (FalkorDB)

Relay's coordination plane decides **who may edit a file right now**. The memory graph answers what that alone can't:
**who did what to which file, during which session, because of which prompt, and who got in whose way.** It also hands that
context to agents *before* they act.

It is built on [FalkorDB](https://www.falkordb.com/), with one graph per project. Every write is a parameterized `MERGE`, so the
graph is idempotent, and every read is a named, read-only Cypher query.

> Built during **Graph Hacks** (WeMakeDevs × FalkorDB, Oct 15–18 2026), Track 2: Agent Memory & Coordination.
> Everything below lives in `backend/lib/falkor/`, `mission-control/components/memorygraph/`, `scripts/falkor-*.js`
> and `docker-compose.falkor.yml`, plus one-line taps in existing modules.

---

## Why a graph

Before this, relay's project memory was `memory.json`: flat arrays of chat events, edits and timeline rows, capped at
2,000 events and 400 edits and rebuilt from transcripts on every sync. Decisions lived in a separate JSONL log. Collisions were
counters. None of it was connected. "Why does `auth.ts` look like this, who touched it, and who was blocked on it?" meant
three manual scans across three stores, and anything past the caps was gone.

In the graph, that question is a single traversal, and nothing ages out.

## What's in it

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
  Task(["Task"]) -->|ABOUT| File
  Task -->|DURING| Session
  File <-->|CO_EDITED| File
  Agent <-->|OVERLAPS_WITH| Agent
```

```text
(Person)-[:RUNS]->(Agent)-[:RAN]->(Session)-[:HAS_TURN]->(Turn)
                     │                │
                     │                └──[:MADE]->(Edit)-[:MODIFIED]->(File)
                     │                                                    ▲
                     └───────────────────[:TOUCHED {count,lastAt}]────────┘

Edge / Node                              Relationship                                         Meaning
───────────────────────────────────────  ───────────────────────────────────────────────────  ──────────────────────────────────────────
(Edit)                                   -[:PROMPTED_BY {via}]-> (Turn {role:'user'})         inferred "why" (skips "continue" / "yes")
(Edit)                                   -[:EXPLAINED_BY]-> (Turn {role:'assistant'})         assistant explanation for the change
(Edit {source:'patch'})                  -[:SAME_CHANGE]-> (Edit {source:'transcript'})       dedupes watcher patch & transcript edit
(Session)                                -[:HELD {count}]-> (File)                            aggregated lock claims
(Contention)                             -[:ON]->(File), -[:HELD_BY]->(Session),              who blocked whom + holder's active intent
                                         -[:WANTED_BY]->(Session)
(Overlap)                                -[:ON]->(File), -[:BETWEEN]->(Edit) × 2              two agents, same file, within 5 min
(Decision | Task)                        -[:ABOUT]->(File), -[:DURING]->(Session)             decisions & tasks scoped to files/sessions
(Agent)                                  -[:DECIDED]-> (Decision)                             agent attribution for decisions
(File)                                   -[:CO_EDITED {weight, sessions}]-> (File)            projection → PageRank & label propagation
(Agent)                                  -[:OVERLAPS_WITH {weight}]-> (Agent)                 projection → PageRank entanglement
```

Where each part comes from:

| Source | Becomes |
|---|---|
| Agent transcripts (Claude Code, Cursor, Codex, Copilot, Antigravity) via `transcripts/sync.js` | Person, Agent, Session, Turn, Edit, `PROMPTED_BY`/`EXPLAINED_BY` |
| Watcher patches (`patches.js`) | `Edit {source:"patch"}`, attributed to the lock holder (`originAgentId`) |
| Room peers' snapshots (`roomSync.js`) | Teammates' sessions and edits, re-attached to their sessions |
| Every lock claim (`lockTable.claim`, wrapped once) | `HELD` counts, and a `Contention` for each block |
| Collision counters (`recordCollision`) | `Contention` for patch blocks and merge flags |
| `relay_report_decision` / `relay_update_task` (Central JSONL) | Decision, Task, `ABOUT`, `DURING` |
| Analytics job (debounced) | `Overlap`, `CO_EDITED`, `OVERLAPS_WITH`, `File.rank`, `File.community`, `Agent.entanglement` |

### How the "why" is inferred

Agents rarely record decisions on their own, so the graph doesn't depend on them doing it. Every code edit in a transcript is
linked to the **last meaningful user request in the same session**. Filler like "continue", "yes" and "hi" is skipped, and the
filler is kept on the edge as `via`. So every change has an explanation without any agent cooperation. On real multi-agent
history, 100% of transcript edits get a prompt link.

### Context at the moment of conflict

When an agent's pre-tool hook is denied a lock, the deny reason now says what the holder is doing:

```
File `src/auth.ts` is locked by Claude Code:DESK:52b2…. Pick a different task.
They're working on: "switch the login flow to JWT tokens" (2 min ago).
```

The holder's intent comes from an in-process cache (filled on ingest, and refilled from the graph after a restart). The lock
path never waits on the database.

#### How a lock finds its session, per agent

A lock id is `<label>:<host>:<session>` (`hooks/relay-hook-lib.js` → `lockAgentIdFor`). The session must be the same id the
transcript parser gives that conversation, or the graph can't connect the lock to what the holder was doing. Both sides use one
function, `backend/lib/transcripts/sessionId.js` → `sessionIdFromTranscript`. When a hook payload includes a transcript path,
the session is derived from that file, so the two sides can't disagree.

| Agent | Hook payload field used | Transcript session id | How it's verified |
|---|---|---|---|
| Claude Code | `transcript_path` (falls back to `session_id`) | `<session>.jsonl` file name | Live run; both equal the Claude session UUID |
| Cursor | `transcript_path` (`conversation_id` is ignored when a path exists; Cursor's docs don't say it equals the transcript id) | `agent-transcripts/<id>/<id>.jsonl` | Same function on both sides |
| Codex | `transcript_path`, else `session_id` (the thread id) | `session_meta.payload.id`, else the UUID at the end of `rollout-<ts>-<uuid>.jsonl` | Real rollout files: `payload.id` = filename UUID |
| Antigravity | `conversationId` | `brain/<uuid>/` directory | On disk, `conversations/<uuid>.pb` and `brain/<uuid>` share ids |
| Copilot | `sessionId` | chat session `sessionId`, else `chatSessions/<id>` file name | Documented field; not yet checked live |

`backend/lib/falkor/sessionjoin.test.js` parses a real-format transcript for each agent with the actual parser, builds the lock
id from that agent's documented hook payload, and asserts the two session keys are equal.

#### Agent support

| | Claude Code | Cursor | Codex | Copilot (VS Code agent) | Antigravity IDE |
|---|---|---|---|---|---|
| Turns (user + assistant) | ✅ | ✅ | ✅ | ✅ (transcript + chatSessions, deduped) | ✅ |
| Edits from the transcript | ✅ Edit/Write/MultiEdit | ✅ Write/StrReplace/… | ✅ `apply_patch`, one edit per file in the patch | ✅ create_file, replace_string_in_file, multi_replace…, apply_patch | ✅ CODE_ACTION + planner TargetFile |
| Edit → prompt (`PROMPTED_BY`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Real timestamps | ✅ | ⚠️ minute precision, from `<timestamp>` in newer Cursor builds; older turns flagged synthetic | ✅ | ✅ | ✅ |
| Lock ↔ session join | ✅ live-verified | ✅ via `transcript_path` | ✅ | ✅ (documented `sessionId`) | ✅ |
| Hook claims every edit tool | ✅ | ✅ | ✅ incl. files inside `apply_patch` | ✅ incl. `replace_string_in_file`, `apply_patch` | ✅ |
| MCP calls attributed (`RELAY_AGENT_LABEL`) | ✅ | ✅ | ✅ | ✅ | ✅ |

Measured on one developer machine's real history: Copilot 223/223 edits prompt-linked (from 0 parsed), Codex 144/144 (from 0
parsed), Cursor 54/120 edits with real times (from 0).

Not supported: the **older Antigravity desktop app** (`~/.gemini/antigravity/`) keeps conversations as binary protobuf
(`conversations/<uuid>.pb`), with no JSONL transcript to read. The Antigravity IDE (`~/.gemini/antigravity-ide/`) is supported.

Whether each agent actually *follows* the instruction to call `relay_session_brief` before editing unfamiliar files depends on
the agent. Check it during a live run (#15).

## Agent tools (MCP)

| Tool | What it does |
|---|---|
| `relay_session_brief { paths }` | Call before touching files: who is on them now and why, past blocks, decisions, the prompts behind recent changes, who to ask, and files in the same work area. Returns markdown and data. |
| `relay_graph_query { query, … }` | Named queries: `file_story`, `who_to_ask`, `contention_trace`, `search_memory` (full-text over every agent conversation), `agent_activity`, `hotspots` (PageRank), `overlaps`, `decision_trace`, `session_brief`, `overview` |
| `relay_report_decision { decision, files }` | Now takes `files`, and is attributed to the calling agent (`RELAY_AGENT_LABEL`) and its session |
| `relay_room_brief` (`/relay ask`) | Now ends with a short "Project memory graph" section |

All graph tools are read-only and available to room guests over the tunnel. A guest without FalkorDB gets the host's graph.

Every response includes the Cypher that produced it.

## Mission Control

**Memory Graph** tab (`/?tab=graph`): live counts, recent blocks with the holder's intent, PageRank hotspots, full-text search
across every agent conversation, and a canvas around one file (agents → sessions and their prompts → file → blocks, decisions,
co-edited files). Click a co-edited file to walk the graph. Each file has five explain tabs, including **What agents are told**:
the exact brief an agent gets.

## Setup

The same commands work on Windows, macOS and Linux. No environment variables are needed.

### 1. Prerequisites

- Relay installed and a repo attached ([Quickstart](./QUICKSTART.md)): Node 20+, `relay init` / `relay add .` in the repo.
- **Docker** (Docker Desktop on Windows/macOS, the Docker engine on Linux) to run FalkorDB locally. If you use a hosted
  FalkorDB (for example FalkorDB Cloud), skip Docker and use its URL in step 3.

### 2. Start FalkorDB

```bash
relay graph up
```

This starts the `falkordb/falkordb` container from `docker-compose.falkor.yml`: the database on `localhost:6379`, FalkorDB's own
browser UI on <http://localhost:3010>, and data in a named Docker volume that survives restarts.

### 3. Turn the graph on

```bash
relay graph enable                                    # local Docker: falkor://localhost:6379
relay graph enable falkor://default:PASSWORD@HOST:PORT  # hosted FalkorDB
```

`enable` checks that the database answers, saves the URL to `~/.relay/falkor.json` (readable only by you), and, if `relay serve`
is already running, switches it on immediately. You can also do this from Mission Control: **Memory Graph** tab → **Enable**.

### 4. Refresh agent configs (existing workspaces only)

Workspaces set up before the memory graph need their agent wiring refreshed once, so each agent's MCP entry learns its name
(`RELAY_AGENT_LABEL`), the new instructions, and the updated Copilot edit matcher:

```bash
relay init        # in each repo, then restart your agents
```

### 5. Start relay and check it

```bash
relay serve
relay graph status
```

`relay graph status` should report `graph running, connected` and the database as reachable. `relay doctor` shows the same thing
as one line.

### 6. Bring in history you already have (optional)

```bash
relay graph rebuild        # every project; or: relay graph rebuild <projectId>
```

Project ids are listed by `curl http://127.0.0.1:3001/api/projects`. New agent activity is ingested automatically when each
agent turn ends.

### 7. Use it

- **Mission Control** → **Memory Graph** tab (`http://localhost:3001/?tab=graph`)
- **In any agent:** "call relay_session_brief for src/auth.ts", or `relay_graph_query` with `query: "file_story"`
- **Room guests:** nothing to install. Their agents' graph queries go to the host's graph over the room tunnel.

### A new PC: pick one

| You are… | Do this | Needs Docker? |
|---|---|---|
| A teammate joining someone's room | `npm i -g relaybrain`, `relay serve`, paste the host's invite in **Team**. The Memory Graph tab and agent graph tools read the host's graph through the room | No |
| The host, with Docker | `relay graph up`, `relay graph enable`, `relay serve` | Yes |
| The host, without Docker | Create a free instance on [FalkorDB Cloud](https://app.falkordb.cloud), copy its host, port and password, then `relay graph enable falkor://default:PASSWORD@HOST:PORT` (`falkors://` if it is TLS-only) and `relay serve` | No |

Only the host runs a graph. Your own chats always load from this machine's agent transcripts, graph or not.

### Environment variables (optional)

Everything above works without these. Set them only to override the saved config for one run.

| Env | Default | Meaning |
|---|---|---|
| `RELAY_FALKOR_URL` | from `~/.relay/falkor.json` | `falkor://[user:pass@]host:port`; overrides the saved URL |
| `RELAY_FALKOR_DISABLED` | `0` | `1` = off, whatever is saved |
| `RELAY_FALKOR_TEXT` | `1` | `0` = metadata-only graph (no chat text or diffs) |
| `RELAY_FALKOR_TEXT_DAYS` | `90` | Retention window in days: `Turn.text` and `Edit.diffHead` older than this are nulled while keeping all nodes and edges |
| `RELAY_FALKOR_GRAPH_PREFIX` | `relay_` | graph name prefix (`<prefix><projectId>`) |
| `RELAY_PUBLIC_READONLY` | `0` | `1` = hosted demo mode: non-loopback callers may only run read queries |

Setting one for a single run:

| Shell | Command |
|---|---|
| bash / zsh | `RELAY_FALKOR_TEXT=0 relay serve` |
| PowerShell | `$env:RELAY_FALKOR_TEXT = "0"; relay serve` |
| cmd | `set RELAY_FALKOR_TEXT=0 && relay serve` |

With no URL saved or set, relay behaves exactly as it did before the memory graph. If FalkorDB goes down mid-session, relay keeps
coordinating; history is re-sent when FalkorDB comes back, and non-replayable events (patches, blocks) are buffered with a bound.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `relay graph up`: *Docker is not running* (Windows: `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`) | Start Docker Desktop, wait until it says it's running, run `relay graph up` again |
| `relay graph up` fails with a port in use | Something else (often a local Redis) holds 6379. Change the host port in `docker-compose.falkor.yml` (`"6380:6379"`) and `relay graph enable falkor://localhost:6380` |
| `relay graph status`: *FalkorDB unreachable (retrying)* | The container stopped (`docker ps`). `relay graph up`. Relay reconnects by itself within ~30 s |
| Memory Graph tab: *not enabled on this relay* | Click **Enable**, or `relay graph enable` |
| Mission Control takes long to open | Use plain `relay serve`: it serves the prebuilt UI on `:3001` (`:3002` redirects there). Only `relay serve --dev` compiles the UI on first load |
| Claude chats missing | Relay looks for Claude sessions opened in the repo or in any folder above it that edits the repo. Run an agent turn, then **Sync** in Mission Control |
| Graph is empty | Ingest runs when an agent turn ends (Stop hook) or on `relay_sync`. For history from before, `relay graph rebuild`. Check `relay doctor` that hooks reach relay |
| `relay graph status` shows **NEEDS REBUILD** | An update changed how history is stored: `relay graph rebuild` |
| `RELAY_FALKOR_URL` seems ignored, or wins over `enable` | The env var beats the saved file. `relay graph status` shows which one is in use (`from env` / `from file`) |
| Container crash-loops after a hard shutdown | See [Persistence and recovery](#persistence-and-recovery) |
| Running a second relay for testing without touching your real setup | Point `HOME` (and `USERPROFILE` on Windows) at a scratch directory and set `RELAY_SKIP_GLOBAL_HOOKS=1`, so the test relay doesn't rewrite `~/.claude` / `~/.cursor` hooks |

## Persistence and recovery

- `docker-compose.falkor.yml` mounts the volume at **`/var/lib/falkordb/data`**, where the image actually writes. (`/data` in the
  image is only a symlink, so a volume mounted there persists nothing.)
- Persistence uses **RDB snapshots** (`--save 30 1 --save 300 10`), **not AOF**: replaying FalkorDB's AOF effect stream crashed
  4.22.1 on restart (#21).
- A snapshot can miss the last ≤30 s. Every ingest stamps `Meta.lastIngestAt` in the graph before saving its local cursor. On
  the first ingest after relay starts, a cursor newer than the graph's stamp means data was lost (or the database is new or
  wiped), so relay re-sends the history. `MERGE` makes the re-send idempotent.
- The full rebuild is still available: `npm run falkor:rebuild -- <projectId|all>`. It only knows what `memory.json` still holds,
  so the re-send above is the normal path.
- **In-place migrations and retention (#18).** Schema and ingest version updates run in-place migrations (`backend/lib/falkor/migrations.js`, recorded on `Meta.migrations`) at startup so history older than `memory.json`'s 2,000-event cap is never wiped on version bumps. Analytics also runs a retention pass (`RELAY_FALKOR_TEXT_DAYS`, default 90 days) that nulls `Turn.text` and `Edit.diffHead` on expired nodes while keeping every node, edge, and timestamp intact, and updates `CO_EDITED` incrementally (`Meta.lastAnalyticsAt`).
- **Inspecting and backing up (`relay graph stats`).** Run `relay graph stats` to inspect node/edge counts by label, turn time spans, applied migrations, and memory footprint. To back up a running container, run `docker exec relay-falkordb redis-cli BGSAVE` and copy `/var/lib/falkordb/data/dump.rdb`.

If FalkorDB ever crash-loops on start: `docker logs relay-falkordb`, copy the data out
(`docker cp relay-falkordb:/var/lib/falkordb/data ./falkordb-backup`), then `docker compose -f docker-compose.falkor.yml down`
and `up -d`. Relay re-sends history on its next sync.

## Design notes

- **Single writer.** Only `relay serve` writes. Per-agent MCP stdio processes read through `relay serve`'s HTTP API, and their
  decisions reach the graph through a JSONL tailer. No cross-process cursor races.
- **Idempotent.** Keys are content-addressed. Turn keys hash owner, agent, session, timestamp, role and the first 200 chars,
  so a local turn and the same turn clipped in a peer snapshot converge. Counters only bump for nodes a batch actually created
  (batch tokens), so replaying a batch is a no-op.
- **Noise control.** Lock claims are aggregated into `HELD` counts, retry storms collapse into one `Contention` per 10 s bucket,
  relay's own config writes aren't treated as edits, and a change seen both as a transcript edit and a watcher patch is counted
  once.
- **Privacy.** Text is redacted for common secret formats before it's written. `RELAY_FALKOR_TEXT=0` stores none at all.

## Tests

```bash
npm test                                                   # unit tests; live tests skip
RELAY_FALKOR_TEST_URL=falkor://localhost:6379 npm test     # + integration tests against FalkorDB
npm run falkor:spike                                       # re-verify every Cypher feature the graph relies on
```
