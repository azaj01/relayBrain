// Decisions & tasks. MCP stdio processes append to the Central JSONL log themselves;
// relay serve (the only graph writer) tails those files into the graph.
const fs = require("fs");
const path = require("path");
const keys = require("./keys");
const { storedText } = require("./redact");
const { each } = require("./write");
const { eventsPath } = require("../centralStore");
const { loadRegistry, loadSession, projectDir } = require("../store");

const POLL_MS = 5000;
const DURING_WINDOW_MS = 10 * 60 * 1000;
const MENTION = /(?:[\w.-]+[\\/])*[\w-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b/g;

let api = null;
const fileState = new Map();

function cursorFile(projectId) {
  return path.join(projectDir(projectId), "graph-central-cursor.json");
}

function loadCursor(projectId) {
  try {
    return JSON.parse(fs.readFileSync(cursorFile(projectId), "utf8"));
  } catch {
    return {};
  }
}

function saveCursor(projectId, cur) {
  const file = cursorFile(projectId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(cur));
  fs.renameSync(`${file}.tmp`, file);
}

function eventsDir() {
  return path.dirname(eventsPath("_probe"));
}

/** A Central id is usually the relay project id; otherwise a project that names it as its centralProjectId. */
function relayProjectFor(centralId) {
  const projects = loadRegistry().projects || [];
  return projects.find((p) => p.id === centralId) || projects.find((p) => p.centralProjectId === centralId) || null;
}

function mentions(text) {
  const out = new Set();
  const s = String(text || "");
  let m;
  MENTION.lastIndex = 0;
  while ((m = MENTION.exec(s))) {
    if (s.slice(Math.max(0, m.index - 3), m.index).includes("://")) continue;
    if (/^\d+(\.\d+)+$/.test(m[0])) continue;
    out.add(m[0].replace(/\\/g, "/"));
  }
  return [...out].slice(0, 20);
}

// Same fallback /api/ingest-stop uses for transcripts, so decisions and sessions agree on who "local" is.
function loginFor(event) {
  const user = String(event.user || "").trim();
  if (user && user.toLowerCase() !== "local") return user;
  try {
    return loadSession().login || "local";
  } catch {
    return "local";
  }
}

function labelFor(event) {
  if (event.agent_label) return String(event.agent_label);
  const parsed = keys.parseLockAgentId(event.agent_source);
  return ["Claude Code", "Cursor", "Codex", "Copilot", "Antigravity"].includes(parsed.label) ? parsed.label : null;
}

function toRow(event) {
  const kind = event.kind === "decision" ? "Decision" : event.kind === "task" ? "Task" : null;
  if (!kind) return null;
  const idField = kind === "Decision" ? event.decision_id : event.task_id;
  const ts = Date.parse(event.ts) || Date.now();
  const login = loginFor(event);
  const label = labelFor(event);
  const explicit = (Array.isArray(event.files) ? event.files : []).map((f) => ({ fileKey: keys.fileKey(f), path: keys.displayPath(f) })).filter((f) => f.fileKey);
  return {
    kind,
    key: idField ? `${kind === "Decision" ? "d" : "k"}_${String(idField).slice(0, 120)}` : `evt_${event.event_id}`,
    eventId: Number(event.event_id) || 0,
    content: storedText(event.content || "", 2000, api.state.cfg.storeText) ?? "",
    status: String(event.status || "open").slice(0, 40),
    ts,
    login: keys.loginKey(login),
    loginRaw: login,
    label,
    agentKey: label ? keys.agentKey(login, label) : null,
    attribution: label ? (event.agent_label ? "explicit" : "inferred") : "unknown",
    explicit,
    mentioned: explicit.length ? [] : mentions(event.content),
  };
}

const UPSERT = (label, textProp, rel) => `
UNWIND $rows AS r
MERGE (d:${label} {key: r.key})
  ON CREATE SET d.createdAt = r.ts, d.updatedAt = r.ts, d.${textProp} = r.content, d.status = r.status,
                d.eventIds = [], d.attribution = r.attribution
FOREACH (_ IN CASE WHEN r.ts >= d.updatedAt THEN [1] ELSE [] END |
  SET d.${textProp} = r.content, d.status = r.status, d.updatedAt = r.ts)
SET d.eventIds = CASE WHEN r.eventId IN d.eventIds THEN d.eventIds ELSE d.eventIds + r.eventId END
SET d.revisions = size(d.eventIds)
FOREACH (_ IN CASE WHEN r.agentKey IS NULL THEN [] ELSE [1] END |
  MERGE (p:Person {key: r.login}) ON CREATE SET p.login = r.loginRaw, p.firstSeen = r.ts
  MERGE (a:Agent {key: r.agentKey}) ON CREATE SET a.label = r.label, a.login = r.login, a.firstSeen = r.ts
  MERGE (p)-[:RUNS]->(a)
  MERGE (a)-[x:${rel}]->(d)
  SET x.ts = r.ts)
RETURN count(d) AS n`;

const ABOUT_EXPLICIT = (label) => `
UNWIND $rows AS r
MATCH (d:${label} {key: r.key})
MERGE (f:File {key: r.fileKey}) ON CREATE SET f.path = r.path, f.editCount = 0
MERGE (d)-[a:ABOUT]->(f)
SET a.how = 'explicit'
RETURN count(a) AS n`;

const FILE_CANDIDATES = `
UNWIND $tokens AS tok
MATCH (f:File)
WHERE f.key = tok OR f.key ENDS WITH ('/' + tok)
RETURN tok, collect(f.key) AS keys`;

const ABOUT_MENTIONED = (label) => `
UNWIND $rows AS r
MATCH (d:${label} {key: r.key})
MATCH (f:File {key: r.fileKey})
MERGE (d)-[a:ABOUT]->(f)
ON CREATE SET a.how = 'mentioned'
RETURN count(a) AS n`;

// Prefer the same person's session; any session of that agent is the fallback.
const SESSION_NEAR = `
MATCH (s:Session)
WHERE s.label = $label AND s.lastAt >= $from AND s.lastAt <= $to
RETURN s.key AS key, s.login = $login AS samePerson
ORDER BY samePerson DESC, s.lastAt DESC LIMIT 1`;

const DURING = (label) => `
UNWIND $rows AS r
MATCH (d:${label} {key: r.key})
MATCH (s:Session {key: r.sessionKey})
MERGE (d)-[x:DURING]->(s)
SET x.confidence = 'inferred'
RETURN count(x) AS n`;

async function writeRows(projectId, rows) {
  const { client } = api;
  for (const label of ["Decision", "Task"]) {
    const group = rows.filter((r) => r.kind === label);
    if (!group.length) continue;
    await each(client, projectId, UPSERT(label, label === "Decision" ? "content" : "description", label === "Decision" ? "DECIDED" : "UPDATED"), group);

    const explicit = group.flatMap((r) => r.explicit.map((f) => ({ key: r.key, ...f })));
    if (explicit.length) await each(client, projectId, ABOUT_EXPLICIT(label), explicit);

    const tokens = [...new Set(group.flatMap((r) => r.mentioned.map((m) => keys.fileKey(m)).filter(Boolean)))];
    if (tokens.length) {
      const found = await client.read(projectId, FILE_CANDIDATES, { tokens });
      // A bare "index.ts" matching five files means nothing; only link unambiguous mentions.
      const resolved = new Map(found.filter((row) => row.keys.length === 1).map((row) => [row.tok, row.keys[0]]));
      const links = group.flatMap((r) =>
        r.mentioned.map((m) => resolved.get(keys.fileKey(m))).filter(Boolean).map((fileKey) => ({ key: r.key, fileKey }))
      );
      if (links.length) await each(client, projectId, ABOUT_MENTIONED(label), links);
    }

    const during = [];
    for (const r of group) {
      if (!r.label) continue;
      const near = await client.read(projectId, SESSION_NEAR, { label: r.label, login: r.login, from: r.ts - DURING_WINDOW_MS, to: r.ts + DURING_WINDOW_MS });
      if (near[0]?.key) during.push({ key: r.key, sessionKey: near[0].key });
    }
    if (during.length) await each(client, projectId, DURING(label), during);
  }
}

function readNewEvents(file, after) {
  const out = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (Number(ev.event_id) > after) out.push(ev);
    } catch {
      /* partial line; picked up next poll */
    }
  }
  return out;
}

let scanning = false;

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    await scanOnce();
  } finally {
    scanning = false;
  }
}

async function scanOnce() {
  if (!api.client.available()) return;
  let names = [];
  try {
    names = fs.readdirSync(eventsDir()).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(eventsDir(), name);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (fileState.get(file) === mtime) continue;
    const centralId = name.replace(/\.jsonl$/, "");
    const project = relayProjectFor(centralId);
    if (!project) {
      fileState.set(file, mtime);
      continue;
    }
    const cur = loadCursor(project.id);
    const after = Number(cur[centralId] || 0);
    const events = readNewEvents(file, after);
    const rows = events.map(toRow).filter(Boolean);
    try {
      if (rows.length) {
        await api.ensureProject(project.id);
        await writeRows(project.id, rows);
        console.log(`[relay-falkor] ${project.id}: +${rows.length} decision/task event(s)`);
        api.notify?.(project.id, { decisions: rows.length });
      }
      if (events.length) {
        cur[centralId] = Math.max(after, ...events.map((e) => Number(e.event_id) || 0));
        saveCursor(project.id, cur);
      }
      fileState.set(file, mtime);
    } catch (err) {
      api.projectStats(project.id).lastError = String(err.message || err);
    }
  }
}

function start(falkor) {
  api = { ...falkor, client: falkor.state.client, state: falkor.state };
  const tick = () => scan().catch(() => undefined);
  const t = setInterval(tick, POLL_MS);
  if (t.unref) t.unref();
  try {
    fs.mkdirSync(eventsDir(), { recursive: true });
    fs.watch(eventsDir(), { persistent: false }, () => setTimeout(tick, 200));
  } catch {
    /* polling covers it */
  }
  setTimeout(tick, 1000);
}

function configure(falkor) {
  api = { ...falkor, client: falkor.state.client, state: falkor.state };
}

module.exports = { start, configure, scan, toRow, mentions, writeRows };
