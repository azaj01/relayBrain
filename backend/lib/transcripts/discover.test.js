// Claude sessions started one folder above the repo (VS Code opened on a parent
// folder) live under the parent's slug and must still reach the repo's dashboard.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// A home folder with a space in it, like "C:\Users\Jane Doe" — the case that broke discovery.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay home "));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { discoverAll } = require("./discover");
const { claudeSlug } = require("./util");

const parent = path.join(home, "Hack Day");
const ws = path.join(parent, "relay");
fs.mkdirSync(ws, { recursive: true });

function session(dirFor, name, cwd, file) {
  const dir = path.join(home, ".claude", "projects", claudeSlug(dirFor));
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { type: "user", cwd, sessionId: name, message: { role: "user", content: "fix the login" } },
    {
      type: "assistant",
      cwd,
      sessionId: name,
      message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: file } }] },
    },
  ];
  const out = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return out;
}

const claudeFiles = () =>
  discoverAll(ws)
    .filter((f) => f.agent === "Claude Code")
    .map((f) => path.basename(f.file))
    .sort();

test("Claude: a session opened on the parent folder that edits the repo is found", () => {
  session(ws, "own", ws, path.join(ws, "a.js"));
  session(parent, "parent-into-repo", parent, path.join(ws, "src", "auth.ts"));
  session(parent, "parent-elsewhere", parent, path.join(parent, "notes.md"));
  session(parent, "sibling-repo", parent, path.join(parent, "relay-old", "x.js"));
  assert.deepEqual(claudeFiles(), ["own.jsonl", "parent-into-repo.jsonl"]);
});

test("Claude: a parent-folder session that reaches the repo later is picked up on the next look", () => {
  const file = session(parent, "late", parent, path.join(parent, "plan.md"));
  assert.ok(!claudeFiles().includes("late.jsonl"));
  const row = { type: "assistant", cwd: parent, message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: path.join(ws, "b.js") } }] } };
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
  assert.ok(claudeFiles().includes("late.jsonl"));
});
