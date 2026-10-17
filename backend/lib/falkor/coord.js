// Coordination events → graph, plus graph context handed to agents at the moment of conflict.
// Everything on the claim path is synchronous Map/array work; writes happen on timers.
const { bus } = require("./bus");
const keys = require("./keys");
const intents = require("./intents");
const { each } = require("./write");
const { loadRegistry } = require("../store");
const { normalizeCompare } = require("../transcripts/util");

const HELD_FLUSH_MS = 10_000;
const CONTENTION_FLUSH_MS = 2_000;
const LABEL_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000;
const MAX_ROWS = 5000;

let api = null;
const held = new Map();
const contentions = new Map();
let registryCache = { at: 0, projects: [] };

/** Lookup only: unlike server.js projectForPath, never registers a new workspace. */
function projectIdFor(workspaceId) {
  if (!workspaceId) return null;
  if (Date.now() - registryCache.at > 5000) {
    try {
      registryCache = { at: Date.now(), projects: loadRegistry().projects || [] };
    } catch {
      registryCache = { at: Date.now(), projects: [] };
    }
  }
  const target = normalizeCompare(workspaceId);
  const hit = registryCache.projects.find((p) => p.id === workspaceId || normalizeCompare(p.path) === target);
  return hit?.id || null;
}

function ago(ts) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

/** What the holder is doing, from the in-process intent cache. Never touches the database. */
function holderIntent(holderAgentId) {
  const h = keys.parseLockAgentId(holderAgentId);
  if (!h.label) return null;
  const sk = h.sessionKnown ? keys.sessionKey(h.label, h.session) : null;
  const exact = sk ? intents.forSession(sk) : null;
  if (exact?.intent) return { text: exact.intent, at: exact.intentAt, confidence: "high", sessionKey: sk, label: h.label };
  const latest = intents.latestForLabel(h.label);
  if (latest?.intent && Date.now() - (latest.intentAt || 0) < LABEL_FALLBACK_MAX_AGE_MS) {
    return { text: latest.intent, at: latest.intentAt, confidence: "low", sessionKey: latest.sessionKey, label: h.label };
  }
  return null;
}

function enrichDeny(result) {
  if (!result || result.allowed || !result.holder || result.holderIntent) return result;
  const intent = holderIntent(result.holder);
  if (!intent) return result;
  result.holderIntent = { text: intent.text, at: intent.at, confidence: intent.confidence };
  const who = intent.confidence === "high" ? "They're" : "That agent was last";
  result.reason = `${result.reason || "File is locked."} ${who} working on: "${intent.text}" (${intent.at ? ago(intent.at) : "recently"}).`;
  return result;
}

function sideOf(agentId) {
  const p = keys.parseLockAgentId(agentId);
  const sk = p.sessionKnown ? keys.sessionKey(p.label, p.session) : null;
  return { agentId: agentId || null, label: p.label || null, session: p.sessionKnown ? p.session : null, sessionKey: sk };
}

function recordContention(projectId, { kind, file, wanter, holder, reason, ts = Date.now(), holderIntentText = null }) {
  const fk = keys.fileKey(file);
  if (!projectId || !fk) return;
  const key = keys.contentionKey({ kind, fileKey: fk, wanter: wanter || "", holder: holder || "", ts });
  const existing = contentions.get(key);
  if (existing) {
    existing.attempts += 1;
    existing.lastTs = Math.max(existing.lastTs, ts);
    return;
  }
  if (contentions.size >= MAX_ROWS) {
    api.projectStats(projectId).bufferDrops += 1;
    return;
  }
  const w = sideOf(wanter);
  const h = sideOf(holder);
  contentions.set(key, {
    projectId,
    key,
    kind,
    fileKey: fk,
    path: keys.displayPath(file),
    ts,
    lastTs: ts,
    attempts: 1,
    reason: reason ? String(reason).slice(0, 500) : null,
    wanter: w.agentId,
    wanterLabel: w.label,
    wanterSession: w.session,
    wanterSessionKey: w.sessionKey,
    holder: h.agentId,
    holderLabel: h.label,
    holderSession: h.session,
    holderSessionKey: h.sessionKey,
    holderIntent: holderIntentText,
  });
}

function recordHeld(projectId, agentId, file, ts = Date.now()) {
  const side = sideOf(agentId);
  const fk = keys.fileKey(file);
  if (!projectId || !side.sessionKey || !fk) return;
  const key = `${projectId}|${side.sessionKey}|${fk}`;
  const row = held.get(key);
  if (row) {
    row.count += 1;
    row.lastAt = ts;
    return;
  }
  if (held.size >= MAX_ROWS) return;
  held.set(key, { projectId, sessionKey: side.sessionKey, label: side.label, sessionId: side.session, fileKey: fk, path: keys.displayPath(file), count: 1, firstAt: ts, lastAt: ts });
}

function observeClaim(args, result) {
  if (!args || !result) return;
  if (Array.isArray(args.files) && args.files.length) return; // the per-file recursion reports each file
  if (args.mode === "read" || result.reading) return;
  const projectId = projectIdFor(args.workspaceId);
  if (result.allowed) {
    recordHeld(projectId, args.agentId, args.file);
    return;
  }
  if (!result.holder) return;
  enrichDeny(result);
  // bumpCollision() in server.js emits a second "collision" event after claim() returns,
  // with the already-enriched reason string, so holderIntentText must fall back to holderIntent(holder).
  const intentText = result.holderIntent?.text || holderIntent(result.holder)?.text || null;
  recordContention(projectId, {
    kind: "claim_blocked",
    file: args.file,
    wanter: args.agentId,
    holder: result.holder,
    reason: result.reason,
    holderIntentText: intentText,
  });
}

function wrapClaim(lockTable) {
  if (!lockTable || lockTable.__relayFalkorWrapped) return;
  const original = lockTable.claim;
  lockTable.claim = function claimWithGraph(args) {
    const result = original.call(this, args);
    try {
      observeClaim(args, result);
    } catch {
      /* the graph must never change a lock decision */
    }
    return result;
  };
  lockTable.__relayFalkorWrapped = true;
}

const SESSION_STUB = (side) => `
FOREACH (_ IN CASE WHEN r.${side}SessionKey IS NULL THEN [] ELSE [1] END |
  MERGE (s:Session {key: r.${side}SessionKey})
    ON CREATE SET s.label = r.${side}Label, s.sessionId = r.${side}Session, s.turnCount = 0, s.editCount = 0,
                  s.startedAt = r.ts, s.lastAt = r.ts, s.stub = true
  MERGE (c)-[:${side === "wanter" ? "WANTED_BY" : "HELD_BY"}]->(s))`;

const CONTENTION = `
UNWIND $rows AS r
MERGE (c:Contention {key: r.key})
  ON CREATE SET c.kind = r.kind, c.ts = r.ts, c.attempts = 0, c.reason = r.reason,
                c.wanter = r.wanter, c.holder = r.holder, c.wanterLabel = r.wanterLabel,
                c.holderLabel = r.holderLabel, c.holderIntent = r.holderIntent
SET c.attempts = c.attempts + r.attempts,
    c.lastTs = CASE WHEN c.lastTs IS NULL OR r.lastTs > c.lastTs THEN r.lastTs ELSE c.lastTs END
MERGE (f:File {key: r.fileKey})
  ON CREATE SET f.path = r.path, f.editCount = 0
MERGE (c)-[:ON]->(f)
${SESSION_STUB("wanter")}
${SESSION_STUB("holder")}
RETURN count(c) AS n`;

const HELD = `
UNWIND $rows AS r
MERGE (s:Session {key: r.sessionKey})
  ON CREATE SET s.label = r.label, s.sessionId = r.sessionId, s.turnCount = 0, s.editCount = 0,
                s.startedAt = r.firstAt, s.lastAt = r.lastAt, s.stub = true
MERGE (f:File {key: r.fileKey})
  ON CREATE SET f.path = r.path, f.editCount = 0
MERGE (s)-[h:HELD]->(f)
  ON CREATE SET h.count = 0, h.firstAt = r.firstAt, h.lastAt = r.lastAt
SET h.count = h.count + r.count,
    h.lastAt = CASE WHEN r.lastAt > h.lastAt THEN r.lastAt ELSE h.lastAt END
RETURN count(h) AS n`;

function byProject(map) {
  const out = new Map();
  for (const row of map.values()) {
    if (!out.has(row.projectId)) out.set(row.projectId, []);
    out.get(row.projectId).push(row);
  }
  return out;
}

async function flush(map, query, label) {
  if (!map.size || !api.client.available()) return;
  const groups = byProject(map);
  map.clear();
  for (const [projectId, rows] of groups) {
    try {
      await api.ensureProject(projectId);
      await each(api.client, projectId, query, rows);
      if (label === "contention") {
        const attempts = rows.reduce((n, r) => n + r.attempts, 0);
        console.log(`[relay-falkor] ${projectId}: +${rows.length} contention(s), ${attempts} blocked attempt(s)`);
        api.notify?.(projectId, { contentions: rows.length });
      }
    } catch (err) {
      api.projectStats(projectId).lastError = String(err.message || err);
      // Only retry when the batch provably never reached the server; a re-sent batch would double the counters.
      if (!err.breaker) continue;
      for (const r of rows) if (map.size < MAX_ROWS) map.set(r.key || `${r.projectId}|${r.sessionKey}|${r.fileKey}`, r);
    }
  }
}

function every(ms, fn) {
  const t = setInterval(() => fn().catch(() => undefined), ms);
  if (t.unref) t.unref();
  return t;
}

const WARM_INTENTS = `
MATCH (s:Session) WHERE s.intent IS NOT NULL
OPTIONAL MATCH (a:Agent)-[:RAN]->(s)
RETURN s.key AS sessionKey, s.label AS label, s.intent AS intent, s.intentAt AS intentAt, a.key AS agentKey
ORDER BY s.intentAt DESC LIMIT 1000`;

/** The intent cache is in-process; after a restart it is refilled from the graph, not from the next ingest. */
async function warmIntents() {
  let projects = [];
  try {
    projects = loadRegistry().projects || [];
  } catch {
    return 0;
  }
  let n = 0;
  for (const p of projects) {
    try {
      const rows = await api.client.read(p.id, WARM_INTENTS);
      for (const r of rows.reverse()) {
        intents.remember(r);
        n += 1;
      }
    } catch {
      /* project has no graph yet */
    }
  }
  return n;
}

function start(falkor) {
  api = { ...falkor, client: falkor.state.client, state: falkor.state };
  wrapClaim(falkor.state.deps.lockTable);
  const warm = setTimeout(() => {
    warmIntents()
      .then((n) => n && console.log(`[relay-falkor] warmed ${n} session intent(s) from the graph`))
      .catch(() => undefined);
  }, 500);
  if (warm.unref) warm.unref();
  bus.on("collision", ({ projectId, kind, detail = {}, ts }) => {
    if (kind === "claim_blocked") return; // already captured, with intent, by the claim wrapper
    recordContention(projectId, {
      kind,
      file: detail.file,
      wanter: detail.agentId || detail.agent || null,
      holder: detail.holder || null,
      reason: detail.reason || null,
      ts: ts || Date.now(),
      holderIntentText: detail.holder ? holderIntent(detail.holder)?.text || null : null,
    });
  });
  every(CONTENTION_FLUSH_MS, () => flush(contentions, CONTENTION, "contention"));
  every(HELD_FLUSH_MS, () => flush(held, HELD, "held"));
}

function flushAll() {
  return Promise.all([flush(contentions, CONTENTION, "contention"), flush(held, HELD, "held")]);
}

function configure(falkor) {
  api = { ...falkor, client: falkor.state.client, state: falkor.state };
}

module.exports = { start, configure, wrapClaim, enrichDeny, holderIntent, observeClaim, recordContention, recordHeld, flushAll, projectIdFor, warmIntents };
