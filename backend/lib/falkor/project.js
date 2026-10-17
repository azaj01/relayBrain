// Pure: memory.history → row batches for write.js. No I/O, no database.
const path = require("path");
const { relativeEditPath } = require("../transcripts/sync");
const keys = require("./keys");
const { storedText, clip, redact } = require("./redact");

const TURN_TEXT_MAX = 2000;
const DIFF_HEAD_MAX = 1000;
const INTENT_MAX = 280;
const TITLE_MAX = 120;
const STALE_PROMPT_MS = 30 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
// "continue"-style nudges say nothing about intent; the request they continue does.
const FILLER = /^(please\s+)?(continue|go(\s+on|\s+ahead)?|yes|yep|yeah|y|ok(ay)?|sure|proceed|do\s+it|keep\s+going|carry\s+on|next|try\s+again|retry|go\s+for\s+it|sounds\s+good|lgtm|done\??)[\s.!]*$/i;

const GREETING = /^(hi+|hello|hey+|yo|sup|wassup|hola|thanks|thank\s+you|thx|ty)(\s+(there|wassup|sup|man|bro|all|claude|cursor|again|so\s+much))*[\s.!?,]*$/i;

function isFiller(text) {
  const s = String(text || "").trim();
  return s.length <= 30 && (FILLER.test(s) || GREETING.test(s));
}

function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function toolOf(text) {
  const word = String(text || "").trim().split(/\s+/)[0] || "";
  return word.slice(0, 40) || null;
}

function sessionOf(event) {
  const real = keys.sessionKey(event.agent, event.sessionId);
  if (real) return { key: real, bucket: false };
  return { key: keys.bucketSessionKey(event.agent, event.ownerLogin, event.ts), bucket: true };
}

function oneLine(text, max) {
  return clip(redact(String(text || "").replace(/\s+/g, " ").trim()), max);
}

/**
 * @param {object[]} history unified events (sync.js unifyEvent), ordered by compareEvents
 * @param {object} opts
 * @param {string} opts.workspacePath used to make edit paths repo-relative
 * @param {(id: string) => boolean} [opts.isNew] events not yet ingested; default: all
 * @param {boolean} [opts.storeText]
 */
function projectHistory(history, opts = {}) {
  const { workspacePath, isNew = () => true, storeText = true } = opts;
  const groups = new Map();
  let dropped = 0;

  for (const event of history || []) {
    if (!event || !event.id || !event.agent) {
      dropped += 1;
      continue;
    }
    const { key, bucket } = sessionOf(event);
    if (!groups.has(key)) groups.set(key, { key, bucket, events: [] });
    groups.get(key).events.push(event);
  }

  const sessions = [];
  const turns = [];
  const edits = [];
  const intents = new Map();

  for (const group of groups.values()) {
    const first = group.events[0];
    const login = keys.loginKey(first.ownerLogin);
    const agentKey = keys.agentKey(first.ownerLogin, first.agent);
    let lastUser = null;
    let lastMeaningful = null;
    let lastAssistant = null;
    let firstUser = null;
    let thinking = 0;
    let fresh = false;
    let seq = 0;
    const recent = new Map();
    let startedAt = Infinity;
    let lastAt = 0;

    for (const event of group.events) {
      const ts = Number(event.ts) || 0;
      startedAt = Math.min(startedAt, ts);
      lastAt = Math.max(lastAt, ts);
      const isFresh = isNew(event.id);
      if (isFresh) fresh = true;

      if (event.kind === "thinking") {
        thinking += 1;
        continue;
      }

      if (event.kind === "message" && (event.role === "user" || event.role === "assistant")) {
        if (!String(event.text || "").trim()) continue;
        // One conversation can be recorded twice (Copilot writes chatSessions and a transcript
        // for the same session); a repeat of the same message moments later is the same turn.
        const dupKey = `${event.role}|${String(event.text).replace(/\s+/g, " ").trim().slice(0, 200)}`;
        const prevTs = recent.get(dupKey);
        if (prevTs != null && Math.abs(ts - prevTs) <= DUPLICATE_WINDOW_MS) continue;
        recent.set(dupKey, ts);
        const turn = {
          sessionKey: group.key,
          turnKey: keys.turnKey({
            login: event.ownerLogin,
            label: event.agent,
            sessionId: event.sessionId,
            ts: event.ts,
            role: event.role,
            kind: event.kind,
            text: event.text,
          }),
          ts,
          role: event.role,
          kind: "message",
          text: storedText(event.text, TURN_TEXT_MAX, storeText),
          seq: seq++,
          tsSynthetic: keys.tsSynthetic(event.ts, event.tsSynthetic),
        };
        if (event.role === "user") {
          lastUser = { ...turn, raw: event.text };
          if (!isFiller(event.text)) {
            lastMeaningful = lastUser;
            if (!firstUser) firstUser = lastUser;
          }
        } else {
          lastAssistant = turn;
        }
        if (isFresh) turns.push(turn);
        continue;
      }

      if (event.kind === "code_edit") {
        const hasPath = Boolean(event.path || event.file);
        const rel = hasPath ? relativeEditPath(event, workspacePath) : null;
        // Matches sync.js buildViews: an edit outside the workspace is not this project's activity.
        if (hasPath && !rel) continue;
        if (!isFresh) continue;
        const fk = keys.fileKey(rel);
        const stats = diffStats(event.diff);
        const prompt = lastMeaningful || lastUser;
        const promptGap = prompt ? ts - prompt.ts : null;
        edits.push({
          sessionKey: group.key,
          agentKey,
          login,
          loginRaw: String(first.ownerLogin || "local"),
          label: first.agent,
          editKey: `e_${event.id}`,
          fileKey: fk,
          path: fk ? keys.displayPath(rel) : null,
          ext: fk ? path.posix.extname(fk).slice(1) || null : null,
          orphan: !fk,
          ts,
          tool: toolOf(event.text),
          diffHead: storeText ? clip(redact(event.diff || ""), DIFF_HEAD_MAX) : null,
          added: stats.added,
          removed: stats.removed,
          tsSynthetic: keys.tsSynthetic(event.ts, event.tsSynthetic),
          promptKey: prompt ? prompt.turnKey : null,
          promptGap,
          promptStale: promptGap != null && promptGap > STALE_PROMPT_MS,
          promptConfidence: group.bucket ? "low" : "high",
          promptVia: lastUser && prompt !== lastUser ? oneLine(lastUser.raw, 40) : null,
          explainKey: lastAssistant ? lastAssistant.turnKey : null,
          explainGap: lastAssistant ? ts - lastAssistant.ts : null,
        });
      }
    }

    const intentSource = lastMeaningful || lastUser;
    const intentText = intentSource ? oneLine(intentSource.raw, INTENT_MAX) : null;
    const info = {
      sessionKey: group.key,
      agentKey,
      label: first.agent,
      login,
      loginRaw: String(first.ownerLogin || "local"),
      sessionId: group.bucket ? null : String(first.sessionId),
      bucket: group.bucket,
      startedAt: Number.isFinite(startedAt) ? startedAt : 0,
      lastAt,
      thinkingCount: thinking,
      title: storeText && firstUser ? oneLine(firstUser.raw, TITLE_MAX) : null,
      intent: storeText ? intentText : null,
      intentAt: intentSource ? intentSource.ts : null,
    };
    // The cache only lives in this process (deny-reason hints), so it keeps text even when the graph doesn't.
    intents.set(group.key, { ...info, intent: intentText });
    if (fresh) sessions.push(info);
  }

  return { sessions, turns, edits, intents, dropped };
}

const AGENT_LABELS = new Set(["Claude Code", "Cursor", "Codex", "Copilot", "Antigravity"]);
// Watcher patches from bulk tree copies are not anyone's edit.
const BULK_PATCH_AGENTS = new Set(["seed", "snapshot"]);
const UNATTRIBUTED = "Editor";
// Files `relay init/clone/add` writes itself; an unattributed change to them is relay, not a person.
const RELAY_MANAGED = /^(\.claude\/|\.cursor\/|\.codex\/|\.agents\/|\.relay\/|\.github\/hooks\/|\.github\/mcp\.json$|\.github\/copilot-instructions\.md$|\.cursorrules$|claude\.md$|agents\.md$)/;

function patchRow(patch, { storeText = true } = {}) {
  if (!patch?.id || !patch.file || BULK_PATCH_AGENTS.has(patch.agent)) return null;
  const fk = keys.fileKey(patch.file);
  if (!fk) return null;
  // patch.agent is just "fs.watch"; the lock holder that triggered the flush is the real author.
  const origin = keys.parseLockAgentId(patch.originAgentId);
  const labelFromAgent = AGENT_LABELS.has(patch.agent) ? patch.agent : null;
  const label = AGENT_LABELS.has(origin.label) ? origin.label : labelFromAgent || UNATTRIBUTED;
  if (label === UNATTRIBUTED && RELAY_MANAGED.test(fk)) return null;
  const sk = label === origin.label && origin.sessionKnown ? keys.sessionKey(label, origin.session) : null;
  const diff = String(patch.diff || "");
  const stats = diffStats(diff);
  return {
    sessionKey: sk,
    agentKey: keys.agentKey(patch.ownerLogin, label),
    login: keys.loginKey(patch.ownerLogin),
    loginRaw: String(patch.ownerLogin || "local"),
    label,
    editKey: String(patch.id),
    source: "patch",
    fileKey: fk,
    path: keys.displayPath(patch.file),
    ext: path.posix.extname(fk).slice(1) || null,
    orphan: false,
    ts: Number(patch.ts) || Date.now(),
    tool: "patch",
    diffHead: storeText && !diff.startsWith("sha256:") ? clip(redact(diff), DIFF_HEAD_MAX) : null,
    added: stats.added,
    removed: stats.removed,
    tsSynthetic: false,
    lamport: Number.isFinite(Number(patch.lamport)) ? Number(patch.lamport) : null,
    sha256: patch.sha256 || null,
    promptKey: null,
    explainKey: null,
  };
}

function projectPatches(patches, opts = {}) {
  return { sessions: [], turns: [], edits: patches.map((p) => patchRow(p, opts)).filter(Boolean), intents: new Map(), dropped: 0 };
}

/**
 * A room peer's snapshot (roomSync.sanitize shape) → the same rows as local history.
 * Peers ship threads + edit rows but no raw history, and their edit rows carry no
 * session, so each edit is re-attached to its thread's code_edit message.
 */
function projectPeer(snapshot, { login, trustRowOwners = false, isNew = () => true, storeText = true } = {}) {
  const events = [];
  const edits = [...(snapshot?.edits || [])];
  const used = new Set();
  const ownerOf = (row) => (trustRowOwners ? row?.ownerLogin || login : login);

  for (const thread of snapshot?.chats || []) {
    if (!thread?.agent) continue;
    const owner = ownerOf(thread);
    for (const m of thread.messages || []) {
      if (!m) continue;
      const base = { agent: thread.agent, ownerLogin: owner, sessionId: thread.sessionId, ts: Number(m.ts) || 0 };
      if (m.kind === "code_edit") {
        const base2 = path.posix.basename(String(m.file || "").replace(/\\/g, "/")).toLowerCase();
        const idx = edits.findIndex(
          (e, i) =>
            !used.has(i) &&
            e.agent === thread.agent &&
            Number(e.ts) === base.ts &&
            path.posix.basename(String(e.file || "").replace(/\\/g, "/")).toLowerCase() === base2
        );
        if (idx < 0) continue;
        used.add(idx);
        const edit = edits[idx];
        events.push({ ...base, id: String(edit.id).replace(/^e_/, ""), role: "tool", kind: "code_edit", text: m.text, file: m.file, path: edit.file, diff: edit.diff });
        continue;
      }
      if (m.role !== "user" && m.role !== "assistant") continue;
      const tk = keys.turnKey({ login: owner, label: thread.agent, sessionId: thread.sessionId, ts: m.ts, role: m.role, kind: "message", text: m.text });
      events.push({ ...base, id: `peer_${tk}`, role: m.role, kind: "message", text: m.text });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  const projection = projectHistory(events, { workspacePath: null, isNew, storeText });

  // Edits whose thread message was trimmed away still count; they just lose their session.
  for (let i = 0; i < edits.length; i++) {
    if (used.has(i)) continue;
    const e = edits[i];
    const owner = ownerOf(e);
    const row = String(e.id || "").startsWith("patch_")
      ? patchRow({ ...e, ownerLogin: owner }, { storeText })
      : patchRow({ ...e, id: e.id, ownerLogin: owner, originAgentId: null }, { storeText });
    if (!row || !isNew(row.editKey)) continue;
    if (!String(e.id || "").startsWith("patch_")) row.source = "transcript";
    projection.edits.push(row);
  }
  return projection;
}

module.exports = { projectHistory, projectPatches, projectPeer, patchRow, diffStats, TURN_TEXT_MAX, INTENT_MAX, UNATTRIBUTED };
