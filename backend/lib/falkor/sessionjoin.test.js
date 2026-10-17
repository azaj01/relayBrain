// The lock ↔ session join, per agent: a lock id built from each agent's documented
// hook payload must name the same session the transcript parser derives.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseFile } = require("../transcripts/parse");
const { lockAgentIdFor } = require("../../../hooks/relay-hook-lib");
const keys = require("./keys");
const coord = require("./coord");
const intents = require("./intents");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-join-"));
function write(rel, rows) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function transcriptSession(agent, file) {
  const events = parseFile(agent, file);
  assert.ok(events.length, `${agent}: parser produced no events`);
  return keys.sessionKey(agent, events[0].sessionId);
}

function lockSession(mode, payload) {
  const lock = keys.parseLockAgentId(lockAgentIdFor(mode, payload));
  return keys.sessionKey(lock.label, lock.session);
}

const ts = "2026-10-16T10:00:00.000Z";

test("Claude Code: session_id + transcript_path", () => {
  const sid = "52b29a54-d8fb-4091-ab60-463ac73c9d6c";
  const file = write(`claude/${sid}.jsonl`, [{ type: "user", sessionId: sid, timestamp: ts, message: { role: "user", content: "hi there friend" } }]);
  assert.equal(lockSession("claude", { session_id: sid, transcript_path: file, tool_name: "Edit" }), transcriptSession("Claude Code", file));
});

test("Cursor: conversation_id is not trusted; transcript_path decides", () => {
  const id = "3e62675d-9b0f-4d99-b17d-c1d875fe98dc";
  const file = write(`cursor/agent-transcripts/${id}/${id}.jsonl`, [{ role: "user", timestamp: ts, message: { content: "make the navbar sticky" } }]);
  const payload = { conversation_id: "conv-not-the-file-id", generation_id: "g1", transcript_path: file, workspace_roots: [root], tool_name: "Write" };
  assert.equal(lockSession("cursor", payload), transcriptSession("Cursor", file));
});

test("Codex: rollout filename carries the thread id the hook sends as session_id", () => {
  const thread = "019e1fdf-e54d-70e2-ae26-d0d7103a404f";
  const file = write(`codex/sessions/2026/05/13/rollout-2026-05-13T11-17-07-${thread}.jsonl`, [
    { timestamp: ts, type: "session_meta", payload: { id: thread, cwd: root } },
    { timestamp: ts, type: "event_msg", payload: { type: "user_message", message: "add retries to the client" } },
  ]);
  const expected = transcriptSession("Codex", file);
  assert.equal(expected, `Codex::${thread}`);
  assert.equal(lockSession("codex", { session_id: thread, turn_id: "t1", transcript_path: file, tool_name: "apply_patch" }), expected);
  assert.equal(lockSession("codex", { session_id: thread, turn_id: "t1", tool_name: "apply_patch" }), expected, "without transcript_path too");
});

test("Antigravity: conversationId is the brain/<uuid> directory", () => {
  const conv = "16840c9a-684a-441b-baae-598c6eb77ba0";
  const file = write(`gemini/antigravity/brain/${conv}/.system_generated/logs/transcript.jsonl`, [
    { type: "USER_INPUT", created_at: ts, content: "<USER_REQUEST>build a graph view</USER_REQUEST>" },
  ]);
  assert.equal(lockSession("antigravity", { conversationId: conv, workspacePaths: [root] }), transcriptSession("Antigravity", file));
});

test("Copilot: sessionId names the chat session file", () => {
  const sid = "7a1c2e3f-0000-4000-8000-1234567890ab";
  const file = write(`copilot/chatSessions/${sid}.jsonl`, [{ type: "user.message", timestamp: ts, data: { content: "rename the helper" } }]);
  assert.equal(lockSession("copilot", { sessionId: sid, timestamp: Date.now(), cwd: root, toolName: "edit", toolArgs: {} }), transcriptSession("Copilot", file));
});

test("two concurrent sessions of one agent: the deny quotes the holder's own session", () => {
  intents.clear();
  const a = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const b = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  intents.remember({ sessionKey: `Cursor::${a}`, label: "Cursor", intent: "migrate auth to JWT", intentAt: Date.now() - 120_000 });
  intents.remember({ sessionKey: `Cursor::${b}`, label: "Cursor", intent: "restyle the footer", intentAt: Date.now() });
  const holder = lockAgentIdFor("cursor", { conversation_id: "x", transcript_path: path.join(root, "agent-transcripts", a, `${a}.jsonl`) });
  const r = coord.enrichDeny({ allowed: false, holder, reason: "locked." });
  assert.equal(r.holderIntent.confidence, "high");
  assert.match(r.reason, /migrate auth to JWT/, "must not fall back to the label's latest intent (the footer)");
  intents.clear();
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
