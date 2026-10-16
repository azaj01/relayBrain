// Per-project ingest cursor. Purely an optimization: MERGE + batch tokens keep the
// graph correct even if this file is lost; losing it only costs one full re-send.
const fs = require("fs");
const path = require("path");
const { projectDir } = require("../store");
const { INGEST_VERSION } = require("./schema");

const MAX_SEEN = 6000;

function cursorPath(projectId) {
  return path.join(projectDir(projectId), "graph-cursor.json");
}

function blank() {
  return { ingestVersion: INGEST_VERSION, seen: [], centralEventId: {}, updatedAt: 0 };
}

function load(projectId) {
  try {
    const raw = JSON.parse(fs.readFileSync(cursorPath(projectId), "utf8"));
    if (raw.ingestVersion !== INGEST_VERSION) return blank();
    return { ...blank(), ...raw, seen: Array.isArray(raw.seen) ? raw.seen : [] };
  } catch {
    return blank();
  }
}

function save(projectId, cursor) {
  const file = cursorPath(projectId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...cursor, updatedAt: Date.now() }));
  fs.renameSync(tmp, file);
}

function seenSet(cursor) {
  return new Set(cursor.seen);
}

function commit(projectId, cursor, ids) {
  const set = new Set(cursor.seen);
  for (const id of ids) {
    set.delete(id);
    set.add(id);
  }
  cursor.seen = [...set].slice(-MAX_SEEN);
  save(projectId, cursor);
  return cursor;
}

function reset(projectId) {
  try {
    fs.unlinkSync(cursorPath(projectId));
  } catch {
    /* already gone */
  }
}

module.exports = { load, save, commit, reset, seenSet, cursorPath };
