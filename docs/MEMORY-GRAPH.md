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

```
(Person)-[:RUNS]->(Agent)-[:RAN]->(Session)-[:HAS_TURN]->(Turn)
                       │                 └─[:MADE]->(Edit)-[:MODIFIED]->(File)
                       └─[:TOUCHED {count,lastAt}]──────────────────────▲
(Edit)-[:PROMPTED_BY {via}]->(Turn {role:user})          inferred "why"
(Edit)-[:EXPLAINED_BY]->(Turn {role:assistant})
(Edit {source:patch})-[:SAME_CHANGE]->(Edit {source:transcript})
(Session)-[:HELD {count}]->(File)                        aggregated lock claims
(Contention)-[:ON]->(File), -[:HELD_BY]->(Session), -[:WANTED_BY]->(Session)
(Overlap)-[:ON]->(File), -[:BETWEEN]->(Edit)×2           two agents, same file, within 5 min
(Decision|Task)-[:ABOUT]->(File), -[:DURING]->(Session); (Agent)-[:DECIDED]->(Decision)
(File)-[:CO_EDITED {weight}]->(File)                     projection → PageRank, label propagation
(Agent)-[:OVERLAPS_WITH {weight}]->(Agent)               projection → PageRank
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

```bash
npm run falkor:up                                   # FalkorDB on :6379, browser UI on :3010
export RELAY_FALKOR_URL=falkor://localhost:6379     # PowerShell: $env:RELAY_FALKOR_URL="falkor://localhost:6379"
relay serve                                         # or: npm run dev
npm run falkor:rebuild -- <projectId|all>           # optional: import existing memory.json history
```

| Env | Default | Meaning |
|---|---|---|
| `RELAY_FALKOR_URL` | unset = off | `falkor://[user:pass@]host:port` |
| `RELAY_FALKOR_DISABLED` | `0` | kill switch |
| `RELAY_FALKOR_TEXT` | `1` | `0` = metadata-only graph (no chat text or diffs) |
| `RELAY_FALKOR_GRAPH_PREFIX` | `relay_` | graph name prefix (`<prefix><projectId>`) |

With no URL set, relay behaves exactly as before. If FalkorDB goes down mid-session, a circuit breaker opens and relay keeps
coordinating. History is replayed from `memory.json` when FalkorDB comes back, and non-replayable events (patches, blocks) are
buffered with a bound.

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
