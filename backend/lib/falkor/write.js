// Parameterized batch writers. Labels/relationship types are constants here; every
// value travels as a parameter. Counters are only bumped for nodes this batch created
// (batch token), so replaying any batch is a no-op.
const crypto = require("crypto");

const CHUNK = 400;
const TRANSCRIPT_EDIT_AGENTS = new Set(["Claude Code", "Cursor", "Codex", "Antigravity"]);

function token() {
  return crypto.randomBytes(8).toString("hex");
}

function chunks(rows, size = CHUNK) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function dedupe(rows, key) {
  const seen = new Map();
  for (const row of rows) if (row && row[key] != null) seen.set(row[key], row);
  return [...seen.values()];
}

async function each(client, projectId, query, rows, extra = {}) {
  const results = [];
  for (const part of chunks(rows)) {
    const data = await client.write(projectId, query, { rows: part, ...extra });
    results.push(...data);
  }
  return results;
}

const SESSIONS = `
UNWIND $rows AS r
MERGE (p:Person {key: r.login})
  ON CREATE SET p.login = r.loginRaw, p.firstSeen = r.startedAt
SET p.lastSeen = CASE WHEN p.lastSeen IS NULL OR r.lastAt > p.lastSeen THEN r.lastAt ELSE p.lastSeen END
MERGE (a:Agent {key: r.agentKey})
  ON CREATE SET a.label = r.label, a.login = r.login, a.firstSeen = r.startedAt
SET a.lastSeen = CASE WHEN a.lastSeen IS NULL OR r.lastAt > a.lastSeen THEN r.lastAt ELSE a.lastSeen END
MERGE (p)-[:RUNS]->(a)
MERGE (s:Session {key: r.sessionKey})
  ON CREATE SET s.sessionId = r.sessionId, s.label = r.label, s.bucket = r.bucket,
                s.turnCount = 0, s.editCount = 0, s.startedAt = r.startedAt
SET s.login = r.login, s.stub = false,
    s.startedAt = CASE WHEN s.startedAt IS NULL OR r.startedAt < s.startedAt THEN r.startedAt ELSE s.startedAt END,
    s.lastAt = CASE WHEN s.lastAt IS NULL OR r.lastAt > s.lastAt THEN r.lastAt ELSE s.lastAt END,
    s.thinkingCount = CASE WHEN s.thinkingCount IS NULL OR r.thinkingCount > s.thinkingCount THEN r.thinkingCount ELSE s.thinkingCount END,
    s.title = coalesce(s.title, r.title)
FOREACH (_ IN CASE WHEN r.intentAt IS NOT NULL AND (s.intentAt IS NULL OR r.intentAt >= s.intentAt) THEN [1] ELSE [] END |
  SET s.intent = r.intent, s.intentAt = r.intentAt)
MERGE (a)-[:RAN]->(s)
RETURN count(s) AS n`;

const TURNS = `
UNWIND $rows AS r
MATCH (s:Session {key: r.sessionKey})
MERGE (t:Turn {key: r.turnKey})
  ON CREATE SET t.ts = r.ts, t.role = r.role, t.kind = r.kind, t.text = r.text,
                t.seq = r.seq, t.tsSynthetic = r.tsSynthetic, t._b = $batch
MERGE (s)-[:HAS_TURN]->(t)
RETURN r.sessionKey AS sessionKey, coalesce(t._b = $batch, false) AS created`;

const EDITS = `
UNWIND $rows AS r
MERGE (p:Person {key: r.login})
  ON CREATE SET p.login = r.loginRaw, p.firstSeen = r.ts
MERGE (a:Agent {key: r.agentKey})
  ON CREATE SET a.label = r.label, a.login = r.login, a.firstSeen = r.ts
MERGE (p)-[:RUNS]->(a)
MERGE (e:Edit {key: r.editKey})
  ON CREATE SET e.source = r.source, e.ts = r.ts, e.tool = r.tool, e.diffHead = r.diffHead,
                e.added = r.added, e.removed = r.removed, e.tsSynthetic = r.tsSynthetic,
                e.orphan = r.orphan, e.lamport = r.lamport, e.sha256 = r.sha256, e._b = $batch
MERGE (e)-[:BY]->(a)
WITH r, e
OPTIONAL MATCH (s:Session {key: r.sessionKey})
FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | MERGE (s)-[:MADE]->(e))
RETURN r.editKey AS editKey, coalesce(e._b = $batch, false) AS created`;

// One real change often arrives twice: transcript code_edit (intent) and watcher patch (disk truth).
const SAME_CHANGE = `
UNWIND $rows AS r
MATCH (p:Edit {source: 'patch'})-[:MODIFIED]->(f:File {key: r.fileKey})
MATCH (p)-[:BY]->(a:Agent {key: r.agentKey})
WHERE NOT (p)-[:SAME_CHANGE]->()
MATCH (t:Edit {source: 'transcript'})-[:MODIFIED]->(f)
MATCH (t)-[:BY]->(a)
WHERE abs(t.ts - p.ts) <= $windowMs
RETURN p.key AS patchKey, t.key AS editKey, abs(t.ts - p.ts) AS gap`;

const LINK_SAME_CHANGE = `
UNWIND $rows AS r
MATCH (p:Edit {key: r.patchKey})
MATCH (t:Edit {key: r.editKey})
MERGE (p)-[s:SAME_CHANGE]->(t)
SET s.gapMs = r.gap
RETURN count(s) AS n`;

const EDIT_FILES = `
UNWIND $rows AS r
MATCH (e:Edit {key: r.editKey})
MERGE (f:File {key: r.fileKey})
  ON CREATE SET f.editCount = 0
SET f.path = r.path, f.ext = r.ext
MERGE (e)-[:MODIFIED]->(f)
RETURN count(e) AS n`;

const FILE_COUNTS = `
UNWIND $rows AS r
MATCH (f:File {key: r.fileKey})
SET f.editCount = coalesce(f.editCount, 0) + r.n,
    f.lastEditAt = CASE WHEN f.lastEditAt IS NULL OR r.lastAt > f.lastEditAt THEN r.lastAt ELSE f.lastEditAt END
RETURN count(f) AS n`;

const TOUCHED = `
UNWIND $rows AS r
MATCH (a:Agent {key: r.agentKey})
MATCH (f:File {key: r.fileKey})
MERGE (a)-[t:TOUCHED]->(f)
  ON CREATE SET t.count = 0, t.firstAt = r.firstAt, t.lastAt = r.lastAt
SET t.count = t.count + r.n,
    t.firstAt = CASE WHEN r.firstAt < t.firstAt THEN r.firstAt ELSE t.firstAt END,
    t.lastAt = CASE WHEN r.lastAt > t.lastAt THEN r.lastAt ELSE t.lastAt END
RETURN count(t) AS n`;

const SESSION_COUNTS = `
UNWIND $rows AS r
MATCH (s:Session {key: r.sessionKey})
SET s.turnCount = coalesce(s.turnCount, 0) + r.turns,
    s.editCount = coalesce(s.editCount, 0) + r.edits
RETURN count(s) AS n`;

const PROMPTS = `
UNWIND $rows AS r
MATCH (e:Edit {key: r.editKey})
OPTIONAL MATCH (u:Turn {key: r.promptKey})
FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
  MERGE (e)-[p:PROMPTED_BY]->(u)
  SET p.gapMs = r.promptGap, p.stale = r.promptStale, p.confidence = r.promptConfidence, p.via = r.promptVia)
WITH e, r
OPTIONAL MATCH (x:Turn {key: r.explainKey})
FOREACH (_ IN CASE WHEN x IS NULL THEN [] ELSE [1] END |
  MERGE (e)-[q:EXPLAINED_BY]->(x)
  SET q.gapMs = r.explainGap)
RETURN count(e) AS n`;

function tally(rows, keyOf, init, add) {
  const map = new Map();
  for (const row of rows) {
    const k = keyOf(row);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, init(row));
    add(map.get(k), row);
  }
  return [...map.values()];
}

/**
 * Writes one projected history batch in dependency order:
 * people/agents/sessions → turns → edits → files/touches → counters → prompt links.
 */
async function writeProjection(client, projectId, projection) {
  const batch = token();
  const sessions = dedupe(projection.sessions, "sessionKey");
  const turns = dedupe(projection.turns, "turnKey");
  const edits = dedupe(projection.edits, "editKey").map((e) => ({ source: "transcript", lamport: null, sha256: null, ...e }));

  if (sessions.length) await each(client, projectId, SESSIONS, sessions);

  const turnResults = turns.length ? await each(client, projectId, TURNS, turns, { batch }) : [];
  const editResults = edits.length ? await each(client, projectId, EDITS, edits, { batch }) : [];

  const createdEdit = new Set(editResults.filter((r) => r.created).map((r) => r.editKey));
  const fileRows = edits.filter((e) => e.fileKey);
  if (fileRows.length) await each(client, projectId, EDIT_FILES, fileRows);

  // These agents' transcripts already record each edit, so their watcher patch is the same change twice.
  const counted = (e) => e.source !== "patch" || !TRANSCRIPT_EDIT_AGENTS.has(e.label);
  const freshFileRows = fileRows.filter((e) => createdEdit.has(e.editKey) && counted(e));
  const fileCounts = tally(
    freshFileRows,
    (e) => e.fileKey,
    (e) => ({ fileKey: e.fileKey, n: 0, lastAt: e.ts }),
    (acc, e) => {
      acc.n += 1;
      acc.lastAt = Math.max(acc.lastAt, e.ts);
    }
  );
  if (fileCounts.length) await each(client, projectId, FILE_COUNTS, fileCounts);

  const touches = tally(
    freshFileRows,
    (e) => `${e.agentKey}|${e.fileKey}`,
    (e) => ({ agentKey: e.agentKey, fileKey: e.fileKey, n: 0, firstAt: e.ts, lastAt: e.ts }),
    (acc, e) => {
      acc.n += 1;
      acc.firstAt = Math.min(acc.firstAt, e.ts);
      acc.lastAt = Math.max(acc.lastAt, e.ts);
    }
  );
  if (touches.length) await each(client, projectId, TOUCHED, touches);

  const counters = new Map();
  const bump = (sessionKey, field) => {
    if (!counters.has(sessionKey)) counters.set(sessionKey, { sessionKey, turns: 0, edits: 0 });
    counters.get(sessionKey)[field] += 1;
  };
  for (const r of turnResults) if (r.created) bump(r.sessionKey, "turns");
  for (const e of edits) if (e.sessionKey && createdEdit.has(e.editKey) && counted(e)) bump(e.sessionKey, "edits");
  if (counters.size) await each(client, projectId, SESSION_COUNTS, [...counters.values()]);

  const linked = edits.filter((e) => e.promptKey || e.explainKey);
  if (linked.length) await each(client, projectId, PROMPTS, linked);

  const pairs = dedupe(
    fileRows.map((e) => ({ k: `${e.agentKey}|${e.fileKey}`, agentKey: e.agentKey, fileKey: e.fileKey })),
    "k"
  );
  if (pairs.length) {
    const candidates = await each(client, projectId, SAME_CHANGE, pairs, { windowMs: 15_000 });
    const best = new Map();
    for (const c of candidates) {
      const prev = best.get(c.patchKey);
      if (!prev || c.gap < prev.gap) best.set(c.patchKey, c);
    }
    if (best.size) await each(client, projectId, LINK_SAME_CHANGE, [...best.values()]);
  }

  return {
    sessions: sessions.length,
    turns: turns.length,
    turnsCreated: turnResults.filter((r) => r.created).length,
    edits: edits.length,
    editsCreated: createdEdit.size,
  };
}

module.exports = { writeProjection, each, chunks, dedupe, token };
