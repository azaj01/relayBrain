#!/usr/bin/env node
// Drop one project's memory graph and rebuild it from ~/.relay data.
//   RELAY_FALKOR_URL=falkor://localhost:6379 node scripts/falkor-rebuild.js <projectId|all> [--keep]
const falkor = require("../backend/lib/falkor");
const cursor = require("../backend/lib/falkor/cursor");
const schema = require("../backend/lib/falkor/schema");
const { ingestHistory, ingestPeer } = require("../backend/lib/falkor/ingest");
const analytics = require("../backend/lib/falkor/analytics");
const { loadRegistry, loadMemory } = require("../backend/lib/store");

async function rebuildOne(project, keep) {
  const { client } = falkor.state;
  if (!keep) {
    await client.deleteGraph(project.id);
    schema.forget(project.id);
    cursor.reset(project.id);
  }
  const memory = loadMemory(project.id);
  const history = memory.history || [];
  const t = Date.now();
  const result = await ingestHistory(project.id, history, project.path, { full: true });
  const peers = Object.entries(memory.roomPeers || {});
  for (const [key, snapshot] of peers) {
    await ingestPeer(project.id, { snapshot, login: snapshot.login || key, trustRowOwners: key === "host" });
  }
  const stats = await analytics.run(project.id);
  console.log(
    `${project.id}  ${project.path}\n  events=${history.length} peers=${peers.length} ${JSON.stringify(result)} analytics=${JSON.stringify(stats)} in ${Date.now() - t}ms`
  );
}

async function main() {
  const target = process.argv[2];
  const keep = process.argv.includes("--keep");
  if (!target) {
    console.error("usage: falkor-rebuild <projectId|all> [--keep]");
    process.exit(2);
  }
  const info = falkor.init({ get() {}, post() {} }, {});
  if (!info.enabled) {
    console.error("RELAY_FALKOR_URL is not set");
    process.exit(2);
  }
  const projects = loadRegistry().projects.filter((p) => target === "all" || p.id === target);
  if (!projects.length) {
    console.error(`no project ${target}`);
    process.exit(2);
  }
  for (const p of projects) await rebuildOne(p, keep);
  await falkor.state.client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
