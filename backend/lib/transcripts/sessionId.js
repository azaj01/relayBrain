// One definition of "which session is this transcript", shared by the transcript
// parser and the lock hooks. A lock id and a transcript must name the same session
// or the memory graph cannot say what a lock holder was doing. Dependency-free:
// hooks load this on every claim.
const path = require("path");

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function base(file) {
  return path.basename(String(file), path.extname(String(file)));
}

/**
 * @param {string} agent "Claude Code" | "Cursor" | "Codex" | "Copilot" | "Antigravity"
 * @param {string} file transcript path as discovered on disk or reported by a hook
 */
function sessionIdFromTranscript(agent, file) {
  if (!file || typeof file !== "string") return null;
  const normalized = file.replace(/\\/g, "/");
  if (agent === "Codex") {
    // rollout-2026-05-13T11-17-07-<thread uuid>.jsonl; hooks send the thread uuid as session_id.
    const m = base(normalized).match(UUID_TAIL);
    return m ? m[1] : base(normalized);
  }
  if (agent === "Antigravity") {
    // brain/<conversation uuid>/.system_generated/logs/transcript.jsonl
    const parts = normalized.split("/");
    const i = parts.lastIndexOf("brain");
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
    return path.posix.basename(path.posix.dirname(path.posix.dirname(path.posix.dirname(normalized)))) || base(normalized);
  }
  // Claude Code <session>.jsonl, Cursor agent-transcripts/<id>/<id>.jsonl, Copilot chatSessions/<id>.json
  return base(normalized);
}

module.exports = { sessionIdFromTranscript };
