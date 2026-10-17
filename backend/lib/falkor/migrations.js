// Versioned in-place graph migrations (#18): run at schema.ensure() and recorded on
// Meta.migrations so schema/ingest version bumps preserve history older than memory.json's cap
// instead of requiring a destructive drop-and-rebuild.

const MIGRATIONS = [
  {
    id: "001_meta_versions_v6",
    description: "Ensure Session.stub defaults and stamp Meta to schemaVersion=1, ingestVersion=6 in place",
    async up(client, projectId, { schemaVersion, ingestVersion }) {
      await client.write(
        projectId,
        `MATCH (s:Session) WHERE s.stub IS NULL SET s.stub = false RETURN count(s) AS n`
      );
      await client.write(
        projectId,
        `MATCH (m:Meta {key: 'meta'})
         SET m.schemaVersion = $schema, m.ingestVersion = $ingest, m.migratedAt = $now
         RETURN 1 AS ok`,
        { schema: schemaVersion, ingest: ingestVersion, now: Date.now() }
      );
    },
  },
];

async function runMigrations(client, projectId, { schemaVersion, ingestVersion }) {
  const rows = await client.read(
    projectId,
    "MATCH (m:Meta {key: 'meta'}) RETURN coalesce(m.migrations, []) AS migrations, m.schemaVersion AS s, m.ingestVersion AS i"
  );
  const meta = rows[0] || {};
  const applied = new Set(Array.isArray(meta.migrations) ? meta.migrations : []);
  const ran = [];

  for (const mig of MIGRATIONS) {
    if (applied.has(mig.id)) continue;
    await mig.up(client, projectId, { schemaVersion, ingestVersion });
    applied.add(mig.id);
    ran.push(mig.id);
  }

  // If the graph had an older schemaVersion or ingestVersion, migrate it forward in place
  // so existing Turn/Edit/Session/Decision history is preserved without dropping the graph.
  if (ran.length || meta.s !== schemaVersion || meta.i !== ingestVersion) {
    await client.write(
      projectId,
      `MATCH (m:Meta {key: 'meta'})
       SET m.migrations = $migrations, m.schemaVersion = $schema, m.ingestVersion = $ingest
       RETURN 1 AS ok`,
      { migrations: [...applied], schema: schemaVersion, ingest: ingestVersion }
    );
  }

  return { applied: [...applied], ran };
}

module.exports = { MIGRATIONS, runMigrations };
