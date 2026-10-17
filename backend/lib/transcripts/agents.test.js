// Full-fidelity projection per agent: an edit in each agent's real transcript format must
// reach the graph with its file, its session, its prompt and a real timestamp.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseFile } = require("./parse");
const { unifyEvent } = require("./sync");
const { projectHistory } = require("../falkor/project");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-agents-"));
const WS = "C:\\Users\\dev\\demo";
function write(rel, rows) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function project(agent, file) {
  const history = parseFile(agent, file).map((e) => unifyEvent(e, agent, "alice"));
  return projectHistory(history, { workspacePath: WS });
}

function assertFull(p, { files, prompt, sessionKey }) {
  assert.deepEqual(p.edits.map((e) => e.fileKey), files);
  const text = (k) => p.turns.find((t) => t.turnKey === k)?.text;
  for (const e of p.edits) {
    assert.equal(text(e.promptKey), prompt, "edit links to the request behind it");
    assert.equal(e.sessionKey, sessionKey);
    assert.equal(e.tsSynthetic, false, "real timestamp");
    assert.equal(e.orphan, false);
  }
}

test("Codex: apply_patch custom_tool_call → one edit per file in the patch", () => {
  const thread = "019e1fdf-e54d-70e2-ae26-d0d7103a404f";
  const patch = `*** Begin Patch\n*** Update File: ${WS}\\src\\auth.ts\n@@\n-old\n+new\n*** Add File: ${WS}\\src\\token.ts\n+export const t = 1;\n*** End Patch`;
  const file = write(`codex/rollout-2026-05-13T11-17-07-${thread}.jsonl`, [
    { timestamp: "2026-05-13T05:47:07Z", type: "session_meta", payload: { id: thread, cwd: WS } },
    { timestamp: "2026-05-13T05:47:10Z", type: "event_msg", payload: { type: "user_message", message: "switch auth to JWT" } },
    { timestamp: "2026-05-13T05:47:20Z", type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "c1", name: "apply_patch", input: patch } },
    { timestamp: "2026-05-13T05:47:21Z", type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: "{\"command\":\"ls\"}" } },
  ]);
  assertFull(project("Codex", file), { files: ["src/auth.ts", "src/token.ts"], prompt: "switch auth to JWT", sessionKey: `Codex::${thread}` });
  const edit = parseFile("Codex", file).find((e) => e.kind === "code_edit");
  assert.match(edit.diff, /-old\n\+new/);
});

test("Codex: older function_call apply_patch with the patch in arguments still parses", () => {
  const thread = "019e1fe3-d2ad-7f32-9628-45090e1bc44a";
  const patch = `*** Begin Patch\n*** Update File: ${WS}\\src\\x.ts\n+y\n*** End Patch`;
  const file = write(`codex/rollout-2026-05-13T11-21-24-${thread}.jsonl`, [
    { timestamp: "2026-05-13T05:50:00Z", type: "event_msg", payload: { type: "user_message", message: "fix x" } },
    { timestamp: "2026-05-13T05:50:05Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: patch }) } },
  ]);
  assertFull(project("Codex", file), { files: ["src/x.ts"], prompt: "fix x", sessionKey: `Codex::${thread}` });
});

test("Antigravity: CODE_ACTION stitched to the planner's TargetFile, session from brain/<uuid>", () => {
  const conv = "46d9adf1-1b25-4cf7-bd41-da8309d19f08";
  const file = write(`antigravity-ide/brain/${conv}/.system_generated/logs/transcript.jsonl`, [
    { type: "USER_INPUT", created_at: "2026-08-15T19:38:03Z", content: "<USER_REQUEST>add a graph view</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", created_at: "2026-08-15T19:38:20Z", content: "Adding it.", tool_calls: [{ name: "write_to_file", args: { TargetFile: `"${WS}\\graph.html"` } }] },
    { type: "CODE_ACTION", created_at: "2026-08-15T19:38:30Z", content: "Created At: x\nCompleted At: y\nCreated the graph page.\n[diff_block_start]\n+<canvas></canvas>\n[diff_block_end]" },
  ]);
  assertFull(project("Antigravity", file), { files: ["graph.html"], prompt: "add a graph view", sessionKey: `Antigravity::${conv}` });
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
