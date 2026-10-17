# From Flat JSON to a FalkorDB Memory Graph for AI Coding Agents

*Built for **Graph Hacks: Context for AI Agents** (WeMakeDevs × FalkorDB, Track 2: Agent Memory & Coordination).*

---

## 1. The Problem: 12 Agents, 1 Repo, 0 Shared Memory

Eighteen months ago, a developer ran **one** coding assistant. Today, a single developer routinely runs **three at once** — Claude Code in one terminal, Cursor in the IDE, Codex or GitHub Copilot CLI in another pane, and Google Antigravity alongside them.

Now put **four teammates** on that repository. That is **twelve AI agents** editing the same codebase in parallel at machine speed.

We built **Relay** ("GitHub Desktop for AI agents") to solve the immediate concurrency hazard: pre-tool and post-tool hooks intercept every file write across Claude Code, Cursor, Codex, Copilot, and Antigravity, arbitrating exclusive write locks and tree-sitter dependency-graph soft locks across machines.

**Locks stop two agents from overwriting the same file at the same time. But locks don't tell the second agent *why*.**

When Agent B is blocked on `src/auth.ts` by Agent A, or when Agent C starts a fresh session five minutes later, three questions determine whether the agent makes a smart decision or breaks the build:
1. **Why is `src/auth.ts` locked right now?** What is the holder actually trying to do?
2. **Why does `src/auth.ts` look the way it does?** Which user prompt caused that change, and what architectural decisions govern it?
3. **Who on the team owns this work area?** Which files are always modified together (`CO_EDITED`), and where are agents repeatedly colliding?

---

## 2. Why Flat JSON Memory Failed

Before Graph Hacks, Relay stored project memory in three disconnected places:
- `memory.json` — flat arrays of `history`, `chats`, `edits`, and `timeline`, capped at **2,000 events** and **400 edits**, rebuilt from scratch on every transcript sync.
- `~/.relay-os/central/events/<projectId>.jsonl` — an append-only JSONL log of `decision` and `task` events.
- `collisions.json` — integer counters (`claimsBlocked`, `patchesBlocked`, `mergesFlagged`).

This flat architecture broke down in four ways:
1. **No relationships:** Asking *"which user prompt caused this edit to `src/auth.ts`, and did it collide with another agent?"* required three manual scans and timestamp heuristics across three files.
2. **Amnesia at the cap:** Once a busy multi-agent repo crossed 2,000 events, older sessions and edits aged out permanently.
3. **Throwaway conflict detection:** `detectConflicts()` recomputed overlapping edits over a 5-minute sliding window on every call and threw the result away.
4. **Union-of-lists room sync:** In a shared room, `mergeRoomViews()` concatenated each teammate's arrays and deduplicated by ID. Two teammates' agents touching the same file never connected in a shared model.

---

## 3. The FalkorDB Graph Model

We replaced flat scan-and-filter with **one FalkorDB graph per project** (`relay_<projectId>`), leveraging FalkorDB's multigraph isolation:

```text
(Person)-[:RUNS]->(Agent)-[:RAN]->(Session)-[:HAS_TURN]->(Turn)
                       │                 └─[:MADE]->(Edit)-[:MODIFIED]->(File)
                       └─[:TOUCHED {count,lastAt}]──────────────────────▲
(Edit)-[:PROMPTED_BY {via}]->(Turn {role:'user'})        inferred "why"
(Edit)-[:EXPLAINED_BY]->(Turn {role:'assistant'})
(Edit {source:'patch'})-[:SAME_CHANGE]->(Edit {source:'transcript'})
(Session)-[:HELD {count}]->(File)                        aggregated lock claims
(Contention)-[:ON]->(File), -[:HELD_BY]->(Session), -[:WANTED_BY]->(Session)
(Overlap)-[:ON]->(File), -[:BETWEEN]->(Edit)×2           two agents, same file, ≤ 5 min
(Decision|Task)-[:ABOUT]->(File), -[:DURING]->(Session)
(Agent)-[:DECIDED]->(Decision)
(File)-[:CO_EDITED {weight, sessions}]->(File)           projection → PageRank & CDLP
(Agent)-[:OVERLAPS_WITH {weight}]->(Agent)               projection → PageRank
```

### Why `Contention` and `Overlap` are Nodes, Not Edges

A lock block involves **three** entities: the `File` being contested, the holder `Session` (`HELD_BY`), and the blocked `Session` (`WANTED_BY`), plus the snapshot of `holderIntent` at the exact moment of the block. Modeling `Contention` as a first-class node lets a single traversal connect the file, both sessions, both agents, and their user prompts — and collapse 25 rapid retry attempts within a 10-second bucket into a single `Contention` node with `attempts: 25`.

---

## 4. Inferring "Why" Without Agent Cooperation (`PROMPTED_BY`)

Agents rarely call a "log my intent" tool unless forced. Relying on voluntary agent reporting leaves 90% of edits unexplained.

Instead, Relay's projector (`backend/lib/falkor/project.js`) harvests the local transcripts of **all five agents** (Claude Code, Cursor, Codex, GitHub Copilot, and Google Antigravity) and links every `Edit` to the **last meaningful user turn in the same session**:

- **Skipping filler prompts:** When a user types `"continue"`, `"yes"`, `"go ahead"`, or `"lgtm"`, linking the edit to `"continue"` is useless. The projector skips filler and greetings, links `PROMPTED_BY` to the real request that preceded them, and preserves `via: "continue"` on the edge.
- **Deduplicating watcher patches (`SAME_CHANGE`):** A single change often arrives twice — once from the filesystem watcher (`source: 'patch'`) and once from the agent's transcript (`source: 'transcript'`). Ingest links them with `[:SAME_CHANGE {method: 'time' | 'content'}]` so `File.editCount` and `TOUCHED.count` never double-count.
- **Real results:** Tested against a developer's real multi-agent history on this machine, **100% of transcript edits** (including 223 Copilot edits and 144 Codex `apply_patch` edits) linked cleanly to the user prompt that caused them.

---

## 5. Context at the Moment of Conflict (Zero DB Latency on the Lock Path)

Pre-tool hooks have a strict budget (~800ms local, 3s total). Querying a database inline during lock arbitration would slow down every file write an agent makes.

Instead, we keep the lock table synchronous and maintain an **in-process `intents` cache** (`backend/lib/falkor/intents.js`), updated on every transcript/peer ingest and warmed from FalkorDB (`WARM_INTENTS`) when `relay serve` boots.

When `lockTable.claim()` denies a lock, `coord.js` enriches the refusal in microseconds from the cache:

```text
File `src/auth.ts` is locked by Claude Code:DESK:52b2…. Pick a different task.
They're working on: "switch the login flow to JWT tokens" (2 min ago).
```

For this join to work across all five agents, the lock's `agentId` (`<label>:<host>:<session>`) and the transcript parser **must derive the exact same session ID**. We unified both sides around `sessionIdFromTranscript()` (`backend/lib/transcripts/sessionId.js`) — fixing a subtle bug where Codex hooks sent the UUID thread ID while rollout filenames prefixed a timestamp (`rollout-2026-05-13T11-17-07-<uuid>.jsonl`), and stripping `@<login>` suffixes when matching remote room guests' sessions.

---

## 6. Context Before Acting: `relay_session_brief` & `relay_graph_query`

Every agent wired by `relay init` receives two read-only MCP tools (available both locally over stdio and remotely to room guests over HTTP `/mcp`):

1. **`relay_session_brief({ paths })`**: Agents are instructed in `AGENTS.md` / `CLAUDE.md` / `.cursorrules` to call this before touching unfamiliar files. In one call, it returns:
   - Who is actively holding or editing the file right now and their session's `intent`
   - Past `Contention` blocks (who was blocked by whom, and what the holder was doing)
   - Architectural `Decision`s linked to the file (`ABOUT`)
   - Recent edits and the exact user prompts (`PROMPTED_BY`) behind them
   - `who_to_ask` (teammates ranked by `TOUCHED` volume and recency)
   - Neighboring files in the same work area (same CDLP `community`)
2. **`relay_graph_query({ query, ... })`**: Runs 10 named, parameterized OpenCypher queries (`file_story`, `who_to_ask`, `contention_trace`, `search_memory`, `agent_activity`, `hotspots`, `overlaps`, `decision_trace`, `session_brief`, `overview`). Every response ships with the exact Cypher query that produced it.

---

## 7. Graph Algorithms as Agent Tools: PageRank & Label Propagation

Why run graph algorithms on agent memory?

If you run PageRank on a raw bipartite `(Agent)-[:TOUCHED]->(File)` graph, every edge points one way and the scores are meaningless. Instead, `backend/lib/falkor/analytics.js` projects an undirected weighted **`CO_EDITED`** graph between files edited in the same session (incrementally updated via `Meta.lastAnalyticsAt`), and an **`OVERLAPS_WITH`** graph between agents that edited the same file within 5 minutes:

```cypher
CALL algo.pageRank('File', 'CO_EDITED') YIELD node, score
SET node.rank = score RETURN count(node) AS n
```

```cypher
CALL algo.labelPropagation({nodeLabels: ['File'], relationshipTypes: ['CO_EDITED']})
YIELD node, communityId
SET node.community = communityId RETURN count(node) AS n
```

- **PageRank (`File.rank`)** surfaces true **coordination hotspots** — the central hub files that get touched alongside everything else and where lock contentions concentrate.
- **Community Detection Label Propagation (`File.community`)** discovers natural **work areas** without relying on directory structure (e.g., `backend/mcp/tools.js`, `docs/MCP.md`, and `mission-control/components/memorygraph/MemoryGraphPanel.tsx` form a single functional community even though they live in three different top-level folders).

---

## 8. Engineering Gotchas We Hit in Production

1. **Docker volume symlink trap & AOF replay crash (#21):** The `falkordb/falkordb` image's `/data` is a symlink to `/var/lib/falkordb/data`, so mounting a volume at `/data` persisted nothing across `docker compose down`. Furthermore, replaying `GRAPH.EFFECT` entries from an AOF after an unclean Docker shutdown segfaulted FalkorDB 4.22.1. Switching `docker-compose.falkor.yml` to mount `/var/lib/falkordb/data` with RDB snapshots (`--save 30 1 --save 300 10 --appendonly no`) and reconciling `Meta.lastIngestAt` against the local cursor made restarts 100% crash-proof and self-healing.
2. **`CONSTRAINT CREATE` is asynchronous:** Calling `graph.constraintCreate()` without awaiting it before deleting a test graph caused the constraint to land *after* `GRAPH.DELETE`, silently resurrecting empty `relay_test_*` graphs.
3. **Idempotent counters with batch tokens:** Re-sending history on recovery must never double-increment `File.editCount` or `TOUCHED.count`. Every batch generates a random token `$batch`; `MERGE (e:Edit {key: r.editKey}) ON CREATE SET e._b = $batch` returns `coalesce(e._b = $batch, false) AS created`, and counters only increment for rows created in *this* batch.
4. **In-place migrations & text retention (#18):** Rather than wiping the graph when schema/ingest versions advance, `migrations.js` upgrades `Meta` and node properties in place, while `pruneText` nulls `Turn.text` and `Edit.diffHead` older than `RELAY_FALKOR_TEXT_DAYS` (default 90) so the structural graph can grow indefinitely in memory.

---

## 9. Try It in Three Commands

```bash
relay graph up        # Starts FalkorDB on :6379 + Browser UI on :3010
relay graph enable    # Saves config to ~/.relay/falkor.json & hot-enables running server
relay serve           # Open http://localhost:3002/?tab=graph
```

The next time you run four coding agents across a team, don't let them edit blind. Give them a shared lock table and a FalkorDB memory graph.
