#!/usr/bin/env node
// `node --test "backend/**/*.test.js"` only expands globs on Node 21+, and relay supports
// Node 20, so find the files here and hand node --test an explicit list.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith(".test.js")) files.push(path.relative(root, p));
  }
})(path.join(root, "backend"));

const r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files.sort()], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
