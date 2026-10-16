// In-process "what is this session trying to do" cache. Read on the lock deny path,
// so it must stay a plain Map lookup: no I/O, no database.
const bySession = new Map();
const byAgentLabel = new Map();
const MAX = 2000;

function remember(info) {
  if (!info?.sessionKey || !info.intent) return;
  const prev = bySession.get(info.sessionKey);
  if (prev && (prev.intentAt || 0) > (info.intentAt || 0)) return;
  bySession.delete(info.sessionKey);
  bySession.set(info.sessionKey, info);
  if (bySession.size > MAX) bySession.delete(bySession.keys().next().value);
  const latest = byAgentLabel.get(info.label);
  if (!latest || (latest.intentAt || 0) <= (info.intentAt || 0)) byAgentLabel.set(info.label, info);
}

function forSession(sessionKey) {
  return bySession.get(sessionKey) || null;
}

/** Fallback when a lock's session is unknown: the agent's most recent intent, low confidence. */
function latestForLabel(label) {
  return byAgentLabel.get(label) || null;
}

function clear() {
  bySession.clear();
  byAgentLabel.clear();
}

module.exports = { remember, forSession, latestForLabel, clear };
