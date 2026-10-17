const { ConstraintType, EntityType } = require("falkordb");

const SCHEMA_VERSION = 1;
// Bump when projector/key logic changes in a way that would re-key existing nodes.
const INGEST_VERSION = 6;

const KEYED_LABELS = ["Person", "Agent", "Session", "Turn", "Edit", "File", "Decision", "Task", "Contention", "Overlap", "Meta"];

const RANGE_INDEXES = [
  ...KEYED_LABELS.map((label) => [label, "key"]),
  ["Edit", "ts"],
  ["Turn", "ts"],
  ["Contention", "ts"],
  ["Session", "lastAt"],
  ["Session", "label"],
];

const FULLTEXT_INDEXES = [
  ["Turn", "text"],
  ["Decision", "content"],
  ["Task", "description"],
];

const ensured = new Map();

function has(existing, label, prop, type) {
  return existing.some((row) => row.label === label && (row.types?.[prop] || []).includes(type));
}

async function bootstrap(client, projectId) {
  // Writing Meta first creates the graph; read-only calls on a missing graph error.
  const meta = await client.write(
    projectId,
    `MERGE (m:Meta {key: 'meta'})
     ON CREATE SET m.schemaVersion = $schema, m.ingestVersion = $ingest, m.createdAt = $now
     RETURN m.schemaVersion AS schemaVersion, m.ingestVersion AS ingestVersion, m.createdAt AS createdAt,
            m.lastIngestAt AS lastIngestAt`,
    { schema: SCHEMA_VERSION, ingest: INGEST_VERSION, now: Date.now() }
  );

  const existing = await client.read(projectId, "CALL db.indexes() YIELD label, properties, types RETURN label, properties, types");
  for (const [label, prop] of RANGE_INDEXES) {
    if (has(existing, label, prop, "RANGE")) continue;
    await client.write(projectId, `CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
  }
  for (const [label, prop] of FULLTEXT_INDEXES) {
    if (has(existing, label, prop, "FULLTEXT")) continue;
    await client.write(projectId, `CREATE FULLTEXT INDEX FOR (n:${label}) ON (n.${prop})`);
  }

  // Unique constraints are a backstop (MERGE already guarantees one node per key). Awaited
  // on purpose: CONSTRAINT CREATE returns PENDING at once, and a fire-and-forget call that
  // lands after the graph was deleted silently recreates it.
  try {
    const graph = await client.graph(projectId);
    const current = await client.read(projectId, "CALL db.constraints() YIELD label, properties RETURN label, properties");
    for (const label of KEYED_LABELS) {
      if (current.some((c) => c.label === label && (c.properties || []).includes("key"))) continue;
      await graph.constraintCreate(ConstraintType.UNIQUE, EntityType.NODE, label, "key").catch(() => undefined);
    }
  } catch {
    /* constraints are optional */
  }

  const row = meta[0] || {};
  return {
    schemaVersion: row.schemaVersion,
    ingestVersion: row.ingestVersion,
    createdAt: row.createdAt,
    lastIngestAt: row.lastIngestAt || 0,
    needsRebuild: row.schemaVersion !== SCHEMA_VERSION || row.ingestVersion !== INGEST_VERSION,
  };
}

/** Idempotent, once per process per project; a failed attempt is retried on the next call. */
function ensure(client, projectId) {
  if (!ensured.has(projectId)) {
    const pending = bootstrap(client, projectId).catch((err) => {
      ensured.delete(projectId);
      throw err;
    });
    ensured.set(projectId, pending);
  }
  return ensured.get(projectId);
}

function forget(projectId) {
  ensured.delete(projectId);
}

module.exports = { ensure, forget, bootstrap, SCHEMA_VERSION, INGEST_VERSION, KEYED_LABELS };
