// Debounced per-project job: overlaps, projections, FalkorDB graph algorithms.
// Never inline with ingest; results land as properties so reads stay one hop.
const { bus } = require("./bus");
const keys = require("./keys");
const { each } = require("./write");

const DEBOUNCE_MS = 15_000;
const MIN_INTERVAL_MS = 30_000;
const OVERLAP_WINDOW_MS = 5 * 60 * 1000;
const MAX_FILES_PER_SESSION = 50;

let api = null;
const timers = new Map();
const lastRun = new Map();
const running = new Set();

const OVERLAP_CANDIDATES = `
MATCH (e1:Edit)-[:MODIFIED]->(f:File)<-[:MODIFIED]-(e2:Edit)
WHERE e1.key < e2.key AND abs(e1.ts - e2.ts) <= $window
  AND NOT (e1)-[:SAME_CHANGE]->() AND NOT (e2)-[:SAME_CHANGE]->()
MATCH (e1)-[:BY]->(a1:Agent), (e2)-[:BY]->(a2:Agent)
WHERE a1.key <> a2.key
RETURN f.key AS fileKey, e1.key AS k1, e2.key AS k2, e1.ts AS t1, e2.ts AS t2,
       coalesce(e1.tsSynthetic, false) OR coalesce(e2.tsSynthetic, false) AS synthetic`;

const OVERLAP_WRITE = `
UNWIND $rows AS r
MATCH (e1:Edit {key: r.k1})
MATCH (e2:Edit {key: r.k2})
MATCH (f:File {key: r.fileKey})
MERGE (o:Overlap {key: r.key})
  ON CREATE SET o.ts = r.ts, o.gapMs = r.gap, o.windowMs = $window, o.confidence = r.confidence
MERGE (o)-[:ON]->(f)
MERGE (o)-[:BETWEEN]->(e1)
MERGE (o)-[:BETWEEN]->(e2)
RETURN count(o) AS n`;

const SESSION_FILES = `
MATCH (s:Session)-[:MADE]->(:Edit)-[:MODIFIED]->(f:File)
WITH s, collect(DISTINCT f.key) AS files
WHERE size(files) > 1 AND size(files) <= $max
RETURN files`;

const SESSION_FILES_INCREMENTAL = `
MATCH (s:Session)-[:MADE]->(e:Edit)
WHERE e.ts >= $since
WITH DISTINCT s
MATCH (s)-[:MADE]->(:Edit)-[:MODIFIED]->(f:File)
WITH s, collect(DISTINCT f.key) AS files
WHERE size(files) > 1 AND size(files) <= $max
RETURN s.key AS sessionKey, files`;

const AGENT_OVERLAPS = `
MATCH (o:Overlap)-[:BETWEEN]->(e:Edit)-[:BY]->(a:Agent)
WITH o, collect(DISTINCT a.key) AS agents, max(o.ts) AS ts
WHERE size(agents) = 2
RETURN agents, ts`;

const CLEAR = (rel) => `MATCH ()-[r:${rel}]->() DELETE r RETURN count(r) AS n`;

const CO_EDITED_WRITE = `
UNWIND $rows AS r
MATCH (a:File {key: r.a})
MATCH (b:File {key: r.b})
MERGE (a)-[x:CO_EDITED]->(b) SET x.weight = r.w
MERGE (b)-[y:CO_EDITED]->(a) SET y.weight = r.w
RETURN count(x) AS n`;

const CO_EDITED_SESSION_INCREMENTAL = `
UNWIND $rows AS r
MATCH (a:File {key: r.a})
MATCH (b:File {key: r.b})
MERGE (a)-[x:CO_EDITED]->(b)
  ON CREATE SET x.sessions = []
FOREACH (_ IN CASE WHEN r.s IN x.sessions THEN [] ELSE [1] END |
  SET x.sessions = x.sessions + r.s)
SET x.weight = size(x.sessions)
MERGE (b)-[y:CO_EDITED]->(a)
  ON CREATE SET y.sessions = []
FOREACH (_ IN CASE WHEN r.s IN y.sessions THEN [] ELSE [1] END |
  SET y.sessions = y.sessions + r.s)
SET y.weight = size(y.sessions)
RETURN count(x) AS n`;

const PRUNE_TURN_TEXT = `
MATCH (t:Turn)
WHERE t.ts < $cutoff AND t.text IS NOT NULL
SET t.text = NULL, t.prunedAt = $now
RETURN count(t) AS n`;

const PRUNE_EDIT_DIFF = `
MATCH (e:Edit)
WHERE e.ts < $cutoff AND e.diffHead IS NOT NULL
SET e.diffHead = NULL, e.prunedAt = $now
RETURN count(e) AS n`;

const OVERLAPS_WITH_WRITE = `
UNWIND $rows AS r
MATCH (a:Agent {key: r.a})
MATCH (b:Agent {key: r.b})
MERGE (a)-[x:OVERLAPS_WITH]->(b) SET x.weight = r.w, x.lastAt = r.lastAt
MERGE (b)-[y:OVERLAPS_WITH]->(a) SET y.weight = r.w, y.lastAt = r.lastAt
RETURN count(x) AS n`;

const FILE_RANK = `CALL algo.pageRank('File', 'CO_EDITED') YIELD node, score SET node.rank = score RETURN count(node) AS n`;
const FILE_COMMUNITY = `CALL algo.labelPropagation({nodeLabels: ['File'], relationshipTypes: ['CO_EDITED']}) YIELD node, communityId
SET node.community = communityId RETURN count(node) AS n`;
const AGENT_RANK = `CALL algo.pageRank('Agent', 'OVERLAPS_WITH') YIELD node, score SET node.entanglement = score RETURN count(node) AS n`;

/**
 * Prunes Turn.text and Edit.diffHead older than `days` while preserving all nodes,
 * edges, timestamps, and metadata (#18).
 */
async function pruneText(client, projectId, days = 90, now = Date.now()) {
  if (!Number.isFinite(days) || days <= 0) return { turnsPruned: 0, editsPruned: 0 };
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const tRes = await client.write(projectId, PRUNE_TURN_TEXT, { cutoff, now });
  const eRes = await client.write(projectId, PRUNE_EDIT_DIFF, { cutoff, now });
  return {
    turnsPruned: Number(tRes[0]?.n || 0),
    editsPruned: Number(eRes[0]?.n || 0),
  };
}

async function run(projectId, opts = {}) {
  const { client } = api;
  const t = Date.now();
  await api.ensureProject(projectId);

  const metaRows = await client.read(projectId, "MATCH (m:Meta {key:'meta'}) RETURN coalesce(m.lastAnalyticsAt, 0) AS since");
  const since = opts.full ? 0 : Number(metaRows[0]?.since || 0);

  const candidates = await client.read(projectId, OVERLAP_CANDIDATES, { window: OVERLAP_WINDOW_MS });
  const overlaps = candidates.map((c) => ({
    key: keys.overlapKey(c.fileKey, c.k1, c.k2),
    k1: c.k1,
    k2: c.k2,
    fileKey: c.fileKey,
    ts: Math.max(c.t1, c.t2),
    gap: Math.abs(c.t1 - c.t2),
    confidence: c.synthetic ? "low" : "high",
  }));
  if (overlaps.length) await each(client, projectId, OVERLAP_WRITE, overlaps, { window: OVERLAP_WINDOW_MS });

  // Incremental CO_EDITED projection (#18): only scan sessions that received edits since
  // Meta.lastAnalyticsAt (or all sessions on cold start / opts.full). Each CO_EDITED edge
  // tracks the set of session keys that co-edited the pair so weight = size(sessions) is
  // idempotent across incremental runs.
  const touchedSessions = await client.read(projectId, SESSION_FILES_INCREMENTAL, { since, max: MAX_FILES_PER_SESSION });
  if (since === 0) await client.write(projectId, CLEAR("CO_EDITED"));
  const incRows = [];
  for (const { sessionKey, files } of touchedSessions) {
    const sorted = [...files].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        incRows.push({ a: sorted[i], b: sorted[j], s: sessionKey });
      }
    }
  }
  if (incRows.length) await each(client, projectId, CO_EDITED_SESSION_INCREMENTAL, incRows);
  const coCountRows = await client.read(projectId, "MATCH ()-[r:CO_EDITED]->() RETURN count(r) / 2 AS n");
  const coEditedCount = Number(coCountRows[0]?.n || 0);

  const agentPairs = new Map();
  for (const { agents, ts } of await client.read(projectId, AGENT_OVERLAPS)) {
    const [a, b] = [...agents].sort();
    const row = agentPairs.get(`${a}|${b}`) || { a, b, w: 0, lastAt: 0 };
    row.w += 1;
    row.lastAt = Math.max(row.lastAt, ts);
    agentPairs.set(`${a}|${b}`, row);
  }
  await client.write(projectId, CLEAR("OVERLAPS_WITH"));
  if (agentPairs.size) await each(client, projectId, OVERLAPS_WITH_WRITE, [...agentPairs.values()]);

  await client.write(projectId, FILE_RANK);
  await client.write(projectId, FILE_COMMUNITY).catch(() => undefined);
  await client.write(projectId, AGENT_RANK).catch(() => undefined);

  const retentionDays = api.state?.cfg?.textRetentionDays ?? 90;
  const pruned = await pruneText(client, projectId, retentionDays, t).catch(() => ({ turnsPruned: 0, editsPruned: 0 }));

  await client.write(projectId, "MATCH (m:Meta {key:'meta'}) SET m.lastAnalyticsAt = $now RETURN 1", { now: t });

  const summary = {
    overlaps: overlaps.length,
    coEdited: coEditedCount,
    incrementalSessions: touchedSessions.length,
    agentPairs: agentPairs.size,
    turnsPruned: pruned.turnsPruned,
    editsPruned: pruned.editsPruned,
    ms: Date.now() - t,
  };
  api.projectStats(projectId).lastAnalytics = summary;
  console.log(`[relay-falkor] ${projectId}: analytics ${JSON.stringify(summary)}`);
  api.state.deps.sse?.emit?.("graph", { workspaceId: projectId, at: Date.now(), analytics: summary });
  return summary;
}

function schedule(projectId) {
  clearTimeout(timers.get(projectId));
  const wait = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - (Date.now() - (lastRun.get(projectId) || 0)));
  const timer = setTimeout(async () => {
    timers.delete(projectId);
    if (running.has(projectId) || !api.client.available()) return;
    running.add(projectId);
    lastRun.set(projectId, Date.now());
    try {
      await run(projectId);
    } catch (err) {
      api.projectStats(projectId).lastError = `analytics: ${err.message || err}`;
    } finally {
      running.delete(projectId);
    }
  }, wait);
  if (timer.unref) timer.unref();
  timers.set(projectId, timer);
}

function start(falkor) {
  api = { ...falkor, client: falkor.state.client, state: falkor.state };
  bus.on("graph-written", ({ projectId }) => projectId && schedule(projectId));
}

function configure(falkor) {
  api = { ...falkor, client: falkor.state.client, state: falkor.state };
}

module.exports = { start, configure, run, schedule, pruneText };
