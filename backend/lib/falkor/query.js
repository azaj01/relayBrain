// Named, parameterized, read-only queries: the only way anything reads the graph.
// No caller-supplied Cypher, so the surface is safe for room guests over the tunnel.
const keys = require("./keys");

const MAX_LIMIT = 50;
const ACTIVE_MS = 15 * 60 * 1000;

function limitOf(v, d = 10) {
  const n = Number(v) || d;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function requireFile(args) {
  const fk = keys.fileKey(args.path);
  if (!fk) throw Object.assign(new Error("`path` must be a repo-relative file path"), { status: 400 });
  return fk;
}

function fileList(args) {
  const raw = Array.isArray(args.paths) ? args.paths : String(args.paths || args.path || "").split(",");
  const list = [...new Set(raw.map((p) => keys.fileKey(p)).filter(Boolean))].slice(0, 10);
  if (!list.length) throw Object.assign(new Error("`paths` must list repo-relative files"), { status: 400 });
  return list;
}

/** RediSearch syntax characters would turn user text into a query language; keep words only. */
function searchTerms(q) {
  const words = String(q || "")
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8);
  return words.join(" ");
}

const Q = {
  file_story: {
    summary: "Every change to a file, newest first, with the prompt that caused it.",
    cypher: `
MATCH (f:File {key: $fileKey})<-[:MODIFIED]-(e:Edit)-[:BY]->(a:Agent)
WHERE NOT (e)-[:SAME_CHANGE]->()
OPTIONAL MATCH (e)-[p:PROMPTED_BY]->(u:Turn)
OPTIONAL MATCH (e)-[:EXPLAINED_BY]->(x:Turn)
OPTIONAL MATCH (s:Session)-[:MADE]->(e)
RETURN e.ts AS ts, a.label AS agent, a.login AS person, e.source AS source, s.title AS session,
       u.text AS prompt, p.via AS via, x.text AS agentSaid, e.added AS added, e.removed AS removed, e.diffHead AS diff
ORDER BY ts DESC LIMIT $limit`,
    params: (a) => ({ fileKey: requireFile(a), limit: limitOf(a.limit) }),
  },

  who_to_ask: {
    summary: "People (and their agents) who know a file best, by recency and volume.",
    cypher: `
MATCH (p:Person)-[:RUNS]->(a:Agent)-[t:TOUCHED]->(f:File {key: $fileKey})
WITH p, sum(t.count) AS edits, max(t.lastAt) AS lastAt, collect(DISTINCT a.label) AS via
RETURN p.login AS person, edits, lastAt, via
ORDER BY lastAt DESC, edits DESC LIMIT $limit`,
    params: (a) => ({ fileKey: requireFile(a), limit: limitOf(a.limit, 5) }),
  },

  contention_trace: {
    summary: "Why agents were blocked: who held the file, what they were doing, who wanted it.",
    cypher: `
MATCH (c:Contention)-[:ON]->(f:File)
WHERE $fileKey IS NULL OR f.key = $fileKey
OPTIONAL MATCH (c)-[:HELD_BY]->(hs:Session)
OPTIONAL MATCH (ha:Agent)-[:RAN]->(hs)
OPTIONAL MATCH (c)-[:WANTED_BY]->(ws:Session)
OPTIONAL MATCH (wa:Agent)-[:RAN]->(ws)
RETURN c.ts AS ts, c.lastTs AS lastTs, c.kind AS kind, c.attempts AS attempts, f.path AS file,
       coalesce(ha.label, c.holderLabel) AS holder, ha.login AS holderPerson,
       coalesce(c.holderIntent, hs.intent) AS holderWasDoing,
       coalesce(wa.label, c.wanterLabel) AS wanter, wa.login AS wanterPerson, ws.intent AS wanterWasDoing,
       c.reason AS reason
ORDER BY ts DESC LIMIT $limit`,
    params: (a) => ({ fileKey: a.path ? requireFile(a) : null, limit: limitOf(a.limit) }),
  },

  search_memory: {
    summary: "Full-text search across every agent conversation in the project.",
    cypher: `
CALL db.idx.fulltext.queryNodes('Turn', $q) YIELD node, score
MATCH (s:Session)-[:HAS_TURN]->(node)
OPTIONAL MATCH (a:Agent)-[:RAN]->(s)
RETURN node.text AS text, node.ts AS ts, node.role AS role, a.label AS agent, a.login AS person,
       s.title AS session, s.key AS sessionKey, score
ORDER BY score DESC LIMIT $limit`,
    params: (a) => {
      const q = searchTerms(a.q);
      if (!q) throw Object.assign(new Error("`q` must contain words to search for"), { status: 400 });
      return { q, limit: limitOf(a.limit) };
    },
  },

  agent_activity: {
    summary: "What an agent or person has been working on, session by session.",
    cypher: `
MATCH (a:Agent)-[:RAN]->(s:Session)
WHERE ($label IS NULL OR a.label = $label) AND ($login IS NULL OR a.login = $login) AND s.lastAt >= $since
OPTIONAL MATCH (s)-[:MADE]->(e:Edit)-[:MODIFIED]->(f:File)
RETURN a.label AS agent, a.login AS person, s.title AS title, s.intent AS intent, s.lastAt AS lastAt,
       s.turnCount AS turns, s.editCount AS edits, collect(DISTINCT f.path)[..15] AS files
ORDER BY lastAt DESC LIMIT $limit`,
    params: (a) => ({
      label: a.agent ? String(a.agent) : null,
      login: a.person ? keys.loginKey(a.person) : null,
      since: Number(a.since) || 0,
      limit: limitOf(a.limit),
    }),
  },

  hotspots: {
    summary: "Files where coordination matters most: PageRank over co-edits, plus overlaps and blocks.",
    cypher: `
MATCH (f:File) WHERE f.rank IS NOT NULL
OPTIONAL MATCH (f)<-[:ON]-(c:Contention)
OPTIONAL MATCH (f)<-[:ON]-(o:Overlap)
OPTIONAL MATCH (a:Agent)-[:TOUCHED]->(f)
RETURN f.path AS file, f.rank AS rank, f.community AS community, f.editCount AS edits,
       count(DISTINCT c) AS contentions, count(DISTINCT o) AS overlaps, count(DISTINCT a) AS agents
ORDER BY rank DESC LIMIT $limit`,
    params: (a) => ({ limit: limitOf(a.limit) }),
  },

  decision_trace: {
    summary: "Decisions about a file (or all), who made them and in which session.",
    cypher: `
MATCH (d:Decision)
WHERE $fileKey IS NULL OR (d)-[:ABOUT]->(:File {key: $fileKey})
OPTIONAL MATCH (a:Agent)-[:DECIDED]->(d)
OPTIONAL MATCH (d)-[r:DURING]->(s:Session)
OPTIONAL MATCH (d)-[:ABOUT]->(f:File)
RETURN d.key AS id, d.content AS decision, d.status AS status, d.updatedAt AS updatedAt, d.revisions AS revisions,
       a.label AS agent, a.login AS person, s.title AS session, r.confidence AS sessionConfidence,
       collect(DISTINCT f.path) AS files
ORDER BY updatedAt DESC LIMIT $limit`,
    params: (a) => ({ fileKey: a.path ? requireFile(a) : null, limit: limitOf(a.limit) }),
  },

  overlaps: {
    summary: "Places where two different agents changed the same file within minutes.",
    cypher: `
MATCH (o:Overlap)-[:ON]->(f:File)
WHERE $fileKey IS NULL OR f.key = $fileKey
MATCH (o)-[:BETWEEN]->(e:Edit)-[:BY]->(a:Agent)
OPTIONAL MATCH (e)-[:PROMPTED_BY]->(u:Turn)
WITH o, f, collect({agent: a.label, person: a.login, ts: e.ts, prompt: u.text}) AS sides
RETURN o.ts AS ts, f.path AS file, o.gapMs AS gapMs, o.confidence AS confidence, sides
ORDER BY ts DESC LIMIT $limit`,
    params: (a) => ({ fileKey: a.path ? requireFile(a) : null, limit: limitOf(a.limit) }),
  },

  overview: {
    summary: "Counts by node label and relationship type.",
    cypher: `
MATCH (n) WHERE NOT n:Meta
RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC`,
    params: () => ({}),
  },
};

const NEIGHBORHOOD = `
MATCH (f:File {key: $fileKey})
OPTIONAL MATCH (f)<-[:MODIFIED]-(e:Edit)-[:BY]->(a:Agent)
WHERE NOT (e)-[:SAME_CHANGE]->()
OPTIONAL MATCH (s:Session)-[:MADE]->(e)
OPTIONAL MATCH (e)-[:PROMPTED_BY]->(u:Turn)
WITH f, e, a, s, u ORDER BY e.ts DESC LIMIT 25
RETURN f.key AS fileKey, f.path AS filePath, f.rank AS rank,
       collect({edit: e.key, ts: e.ts, agent: a.key, agentLabel: a.label, person: a.login,
                session: s.key, sessionTitle: s.title, sessionIntent: s.intent, prompt: u.key, promptText: u.text}) AS rows`;

const NEIGHBOR_EXTRAS = `
MATCH (f:File {key: $fileKey})
OPTIONAL MATCH (f)<-[:ON]-(c:Contention)
OPTIONAL MATCH (c)-[:HELD_BY]->(hs:Session)
OPTIONAL MATCH (c)-[:WANTED_BY]->(ws:Session)
WITH f, collect(DISTINCT {key: c.key, kind: c.kind, attempts: c.attempts, ts: c.ts, holder: hs.key, holderLabel: hs.label,
                           holderIntent: coalesce(c.holderIntent, hs.intent), wanter: ws.key, wanterLabel: ws.label}) AS contentions
OPTIONAL MATCH (f)<-[:ABOUT]-(d:Decision)
WITH f, contentions, collect(DISTINCT {key: d.key, content: d.content, status: d.status}) AS decisions
OPTIONAL MATCH (f)-[x:CO_EDITED]->(g:File)
WITH f, contentions, decisions, g, x ORDER BY x.weight DESC
RETURN contentions, decisions, collect({key: g.key, path: g.path, weight: x.weight})[..8] AS coEdited`;

const HOTSPOT_SEEDS = `MATCH (f:File) WHERE f.rank IS NOT NULL RETURN f.key AS k ORDER BY f.rank DESC LIMIT 1`;

/** Small node/edge set around one file, shaped for the Mission Control canvas. */
async function neighborhood(client, projectId, args) {
  let fk = args.path ? requireFile(args) : null;
  if (!fk) fk = (await client.read(projectId, HOTSPOT_SEEDS))[0]?.k || null;
  if (!fk) return { nodes: [], edges: [], focus: null };
  const [main] = await client.read(projectId, NEIGHBORHOOD, { fileKey: fk });
  const [extra] = await client.read(projectId, NEIGHBOR_EXTRAS, { fileKey: fk });
  if (!main) return { nodes: [], edges: [], focus: null };
  const nodes = new Map();
  const edges = [];
  const node = (id, kind, label, props = {}) => {
    if (id && !nodes.has(id)) nodes.set(id, { id, kind, label, props });
  };
  const seenEdges = new Set();
  const edge = (from, to, type) => {
    const k = `${from}|${to}|${type}`;
    if (!from || !to || seenEdges.has(k)) return;
    seenEdges.add(k);
    edges.push({ from, to, type });
  };
  node(`file:${main.fileKey}`, "file", main.filePath, { rank: main.rank, focus: true });
  for (const r of main.rows || []) {
    if (!r.edit) continue;
    node(`agent:${r.agent}`, "agent", `${r.agentLabel} · ${r.person}`, { person: r.person, label: r.agentLabel });
    if (r.session) {
      node(`session:${r.session}`, "session", r.sessionTitle || r.session.split("::")[1]?.slice(0, 8) || "session", { intent: r.sessionIntent });
      edge(`agent:${r.agent}`, `session:${r.session}`, "RAN");
      edge(`session:${r.session}`, `file:${main.fileKey}`, "EDITED");
    } else {
      edge(`agent:${r.agent}`, `file:${main.fileKey}`, "EDITED");
    }
    if (r.prompt && r.session) {
      node(`turn:${r.prompt}`, "prompt", r.promptText ? String(r.promptText).slice(0, 80) : "prompt", { text: r.promptText });
      edge(`turn:${r.prompt}`, `session:${r.session}`, "PROMPTED");
    }
  }
  for (const c of extra?.contentions || []) {
    if (!c.key) continue;
    node(`contention:${c.key}`, "contention", `${c.kind === "claim_blocked" ? "blocked" : c.kind} ×${c.attempts || 1}`, c);
    edge(`contention:${c.key}`, `file:${main.fileKey}`, "ON");
    if (c.holder) {
      node(`session:${c.holder}`, "session", c.holderLabel || "holder", { intent: c.holderIntent });
      edge(`contention:${c.key}`, `session:${c.holder}`, "HELD_BY");
    }
    if (c.wanter) {
      node(`session:${c.wanter}`, "session", c.wanterLabel || "wanter", {});
      edge(`contention:${c.key}`, `session:${c.wanter}`, "WANTED_BY");
    }
  }
  for (const d of extra?.decisions || []) {
    if (!d.key) continue;
    node(`decision:${d.key}`, "decision", String(d.content || "decision").slice(0, 60), d);
    edge(`decision:${d.key}`, `file:${main.fileKey}`, "ABOUT");
  }
  for (const g of extra?.coEdited || []) {
    if (!g.key) continue;
    node(`file:${g.key}`, "file", g.path, { weight: g.weight });
    edge(`file:${main.fileKey}`, `file:${g.key}`, "CO_EDITED");
  }
  return { focus: main.fileKey, nodes: [...nodes.values()].slice(0, 150), edges };
}

const BRIEF_EDITS = `
MATCH (f:File {key: $fileKey})<-[:MODIFIED]-(e:Edit)-[:BY]->(a:Agent)
WHERE NOT (e)-[:SAME_CHANGE]->()
OPTIONAL MATCH (e)-[:PROMPTED_BY]->(u:Turn)
RETURN e.ts AS ts, a.label AS agent, a.login AS person, u.text AS prompt
ORDER BY ts DESC LIMIT 8`;
const BRIEF_FILE = `MATCH (f:File {key: $fileKey}) RETURN f.path AS path, f.rank AS rank, f.community AS community, f.editCount AS edits`;
const BRIEF_ACTIVE = `
MATCH (s:Session)-[h:HELD]->(f:File {key: $fileKey})
WHERE h.lastAt >= $activeSince
OPTIONAL MATCH (a:Agent)-[:RAN]->(s)
RETURN coalesce(a.label, s.label) AS agent, a.login AS person, s.intent AS intent, h.lastAt AS lastAt
ORDER BY lastAt DESC LIMIT 3`;
const BRIEF_NEIGHBORS = `
MATCH (f:File {key: $fileKey})
WHERE f.community IS NOT NULL
MATCH (g:File) WHERE g.community = f.community AND g.key <> f.key
MATCH (a:Agent)-[t:TOUCHED]->(g) WHERE t.lastAt >= $activeSince
RETURN g.path AS file, a.label AS agent, a.login AS person, t.lastAt AS lastAt
ORDER BY lastAt DESC LIMIT 3`;

function ago(ts, now) {
  if (!ts) return "";
  const m = Math.round((now - ts) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function clipLine(s, n = 140) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Everything an agent should know before touching these files, as data and as markdown. */
async function sessionBrief(client, projectId, args, run) {
  const files = fileList(args);
  const now = Date.now();
  const activeSince = now - ACTIVE_MS;
  const out = [];
  for (const fileKey of files) {
    const [info] = await client.read(projectId, BRIEF_FILE, { fileKey });
    const recent = await client.read(projectId, BRIEF_EDITS, { fileKey });
    const people = (await run("who_to_ask", { path: fileKey, limit: 3 })).rows;
    const decisions = (await run("decision_trace", { path: fileKey, limit: 3 })).rows;
    const blocks = (await run("contention_trace", { path: fileKey, limit: 3 })).rows;
    const active = await client.read(projectId, BRIEF_ACTIVE, { fileKey, activeSince });
    const nearby = await client.read(projectId, BRIEF_NEIGHBORS, { fileKey, activeSince });
    out.push({ file: info?.path || fileKey, known: Boolean(info), rank: info?.rank ?? null, community: info?.community ?? null, edits: info?.edits || 0, recent, people, decisions, blocks, active, nearby });
  }

  const md = ["# Relay memory brief", ""];
  for (const f of out) {
    md.push(`## ${f.file}`);
    if (!f.known) {
      md.push("- No history in the project memory graph yet.", "");
      continue;
    }
    if (f.active.length) for (const a of f.active) md.push(`- ⚠️ **In use right now** by ${a.agent}${a.person ? ` (${a.person})` : ""}${a.intent ? `: "${clipLine(a.intent)}"` : ""}`);
    for (const b of f.blocks) md.push(`- Contention ${ago(b.ts, now)}: ${b.wanter} was blocked by ${b.holder}${b.holderWasDoing ? ` while it worked on "${clipLine(b.holderWasDoing, 90)}"` : ""}`);
    for (const d of f.decisions) md.push(`- Decision (${d.status}): ${clipLine(d.decision)}${d.agent ? `, by ${d.agent}` : ""}`);
    const why = new Map();
    for (const r of f.recent) {
      const k = `${r.agent}|${r.person}|${r.prompt || ""}`;
      if (why.has(k)) why.get(k).n += 1;
      else why.set(k, { ...r, n: 1 });
    }
    for (const r of why.values()) {
      md.push(`- ${ago(r.ts, now)} ${r.agent} (${r.person}) changed it${r.n > 1 ? ` ${r.n}×` : ""} because: "${clipLine(r.prompt || "unknown")}"`);
    }
    if (f.people.length) md.push(`- Ask: ${f.people.map((p) => `${p.person} (${p.edits} edits via ${p.via.join("/")})`).join(", ")}`);
    for (const n of f.nearby) md.push(`- Same work area: ${n.file} touched ${ago(n.lastAt, now)} by ${n.agent} (${n.person})`);
    md.push("");
  }
  return { files: out, markdown: md.join("\n") };
}

function names() {
  return [...Object.keys(Q), "session_brief", "neighborhood"];
}

/** Runs one named query. Throws a 400-style error on bad input. */
async function runNamed(client, projectId, name, args = {}) {
  if (!projectId) throw Object.assign(new Error("no project"), { status: 404 });
  const run = (n, a) => runNamed(client, projectId, n, a);
  if (name === "session_brief") return { query: name, ...(await sessionBrief(client, projectId, args, run)) };
  if (name === "neighborhood") return { query: name, ...(await neighborhood(client, projectId, args)) };
  const def = Q[name];
  if (!def) throw Object.assign(new Error(`unknown query "${name}". Try: ${names().join(", ")}`), { status: 400 });
  const params = def.params(args);
  const rows = await client.read(projectId, def.cypher, params);
  return { query: name, summary: def.summary, cypher: def.cypher.trim(), params, rows };
}

module.exports = { runNamed, names, searchTerms, Q };
