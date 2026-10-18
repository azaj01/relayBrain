#!/usr/bin/env node
// Drop one project's memory graph and rebuild it from ~/.relay data.
//   RELAY_FALKOR_URL=falkor://localhost:6379 node scripts/falkor-rebuild.js <projectId|all> [--keep]
const falkor = require("../backend/lib/falkor");
const { rebuildProjectGraph } = require("../backend/lib/falkor/demo");
const { loadRegistry } = require("../backend/lib/store");

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
  for (const p of projects) {
    const out = await rebuildProjectGraph(falkor, p.id, { keep });
    console.log(
      `${out.projectId}  ${out.path}\n  events=${out.events} peers=${out.peers} ${JSON.stringify(out.ingest)} analytics=${JSON.stringify(out.analytics)} in ${out.ms}ms`
    );
  }
  await falkor.state.client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
