const crypto = require("crypto");

// Fallback ids relay invents when an agent reports no session (unifyEvent → "session", lockAgentIdFor → "local").
const SESSION_SENTINELS = new Set(["", "session", "local", "null", "undefined"]);
const CONTENTION_BUCKET_MS = 10_000;

function hash(parts, len = 20) {
  return crypto.createHash("sha1").update(parts.map((p) => String(p ?? "")).join("␟")).digest("hex").slice(0, len);
}

function loginKey(login) {
  const v = String(login || "").trim().toLowerCase();
  return v || "local";
}

function agentKey(login, label) {
  return `${loginKey(login)}::${String(label || "agent").trim()}`;
}

function isRealSession(sessionId) {
  return !SESSION_SENTINELS.has(String(sessionId ?? "").trim().toLowerCase());
}

function sessionKey(label, sessionId) {
  if (!isRealSession(sessionId)) return null;
  return `${String(label || "agent").trim()}::${String(sessionId).trim()}`;
}

function day(ts) {
  const d = new Date(Number(ts) || 0);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
}

/** Groups session-less activity per agent, person and day so it never merges across people. */
function bucketSessionKey(label, login, ts) {
  return `${String(label || "agent").trim()}::nosession::${loginKey(login)}::${day(ts)}`;
}

/** `label:host:session` — labels and hostnames never contain ':'; session ids might. */
function parseLockAgentId(agentId) {
  const parts = String(agentId || "").split(":");
  const label = parts[0] || "";
  const host = parts[1] || "";
  const session = parts.slice(2).join(":");
  return { label, host, session, sessionKnown: isRealSession(session) };
}

function fileKey(p) {
  if (p == null) return null;
  let s = String(p).trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!s || /^[a-zA-Z]:\//.test(s) || /^[a-zA-Z]:$/.test(s) || s.startsWith("/")) return null;
  s = s.replace(/^(\.\/)+/, "").replace(/\/$/, "");
  if (!s || s === "." || s === ".." || s.startsWith("../") || s.includes("/../")) return null;
  return s.toLowerCase();
}

function displayPath(p) {
  return String(p || "").trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** Content-addressed so a local turn and the same turn clipped in a peer snapshot converge. */
function turnKey({ login, label, sessionId, ts, role, kind, text }) {
  return `t_${hash([loginKey(login), label, sessionId, ts, role, kind, String(text || "").slice(0, 200)])}`;
}

function contentionKey({ kind, fileKey: fk, wanter, holder, ts }) {
  const bucket = Math.floor((Number(ts) || 0) / CONTENTION_BUCKET_MS);
  return `c_${hash([kind, fk, wanter, holder, bucket])}`;
}

function overlapKey(fk, editA, editB) {
  const [a, b] = [String(editA), String(editB)].sort();
  return `o_${hash([fk, a, b])}`;
}

/** Cursor/Claude/Codex fall back to `mtime + index*1000` (fractional ms); Copilot always synthesizes. */
function tsSynthetic(ts, label) {
  return !Number.isInteger(Number(ts)) || label === "Copilot";
}

module.exports = {
  hash,
  loginKey,
  agentKey,
  isRealSession,
  sessionKey,
  bucketSessionKey,
  parseLockAgentId,
  fileKey,
  displayPath,
  turnKey,
  contentionKey,
  overlapKey,
  tsSynthetic,
  CONTENTION_BUCKET_MS,
};
