const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const ASSIGNMENT = /\b(password|passwd|secret|api[_-]?key|token)(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi;

function redact(text) {
  let s = String(text ?? "");
  for (const re of PATTERNS) s = s.replace(re, "[redacted]");
  return s.replace(ASSIGNMENT, (_m, name, sep) => `${name}${sep}[redacted]`);
}

function clip(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Text as stored in the graph: redacted, clipped, or dropped entirely when text storage is off. */
function storedText(text, max, storeText = true) {
  if (!storeText) return null;
  return clip(redact(text), max);
}

module.exports = { redact, clip, storedText };
