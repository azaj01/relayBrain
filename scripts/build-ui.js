#!/usr/bin/env node
// Builds Mission Control as static files into mission-control/out, which the npm
// package ships and `relay serve` hosts on the API port. Runs on `npm pack` / `npm publish`.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ui = path.join(__dirname, "..", "mission-control");
const nextBin = require.resolve("next/dist/bin/next", { paths: [ui] });

// Type stubs left by `next dev` can point at routes that no longer exist and fail the type check.
for (const dir of [".next/types", ".next/dev/types"]) fs.rmSync(path.join(ui, dir), { recursive: true, force: true });
fs.rmSync(path.join(ui, "out"), { recursive: true, force: true });

const res = spawnSync(process.execPath, [nextBin, "build"], {
  cwd: ui,
  stdio: "inherit",
  env: { ...process.env, RELAY_STATIC_EXPORT: "1", NEXT_PUBLIC_RELAY_API: "" },
});
if (res.status !== 0) process.exit(res.status || 1);
if (!fs.existsSync(path.join(ui, "out", "index.html"))) {
  console.error("build-ui: mission-control/out/index.html was not produced");
  process.exit(1);
}
console.log("build-ui: mission-control/out ready");
