#!/usr/bin/env node
// Seeds a rich, realistic multi-agent coordination history + FalkorDB graph for the live demo (#14, #15).
// By default seeds the isolated demo sandbox graph (`demo_<projectId>`), never polluting real workspace graphs.
// Pass `--raw` only if you explicitly want to write into the raw target projectId.
const falkor = require("../backend/lib/falkor");
const { seedDemoGraph } = require("../backend/lib/falkor/demo");
const { loadRegistry } = require("../backend/lib/store");

async function main() {
  const args = process.argv.slice(2);
  const rawTarget = args.includes("--raw");
  const targetArg = args.find((a) => !a.startsWith("--"));
  const baseId = targetArg || loadRegistry().projects?.[0]?.id || "proj_demo";

  const info = falkor.init({ get() {}, post() {} }, {});
  if (!info.enabled) {
    console.error("FalkorDB is not enabled. Run `relay graph enable` or set RELAY_FALKOR_URL first.");
    process.exit(1);
  }
  const { targetId, summary } = await seedDemoGraph(falkor, baseId, { rawTarget });
  console.log(`Seeded isolated FalkorDB demo graph "${targetId}" (for workspace "${baseId}"):`, JSON.stringify(summary));
  await falkor.state.client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
