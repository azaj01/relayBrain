// Copilot (VS Code agent) transcripts: edits, real timestamps, twin files, hook claims.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseFile, patchSections } = require("./parse");
const { unifyEvent } = require("./sync");
const { projectHistory } = require("../falkor/project");
const { extractFilePaths } = require("../../../hooks/relay-hook-lib");
const { EDIT } = require("../editMatchers");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-copilot-"));
const SID = "fcc51653-804f-4e4f-9330-347a42abd57c";
const storage = path.join(root, "workspaceStorage", "129f00c0b424af65aacbf15570f3ecf2");
const transcript = path.join(storage, "GitHub.copilot-chat", "transcripts", `${SID}.jsonl`);
const chat = path.join(storage, "chatSessions", `${SID}.jsonl`);
const WS = "C:\\Users\\dev\\demo";

function writeRows(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const T = (min) => new Date(Date.parse("2026-04-18T01:00:00Z") + min * 60000).toISOString();
const patch = "*** Begin Patch\n*** Update File: C:\\Users\\dev\\demo\\Dockerfile\n@@\n+FROM python:3.11-slim\n*** Add File: C:\\Users\\dev\\demo\\run.sh\n+echo hi\n*** End Patch";

writeRows(transcript, [
  { type: "session.start", data: { sessionId: SID, startTime: T(10) }, timestamp: T(10) },
  { type: "user.message", data: { content: "make a python file that converts the dataset" }, timestamp: T(11) },
  { type: "assistant.message", data: { content: "I'll create the converter." }, timestamp: T(11.5) },
  { type: "tool.execution_start", data: { toolName: "create_file", arguments: { filePath: `${WS}\\convert.py`, content: "import json\nprint(1)\n" } }, timestamp: T(12) },
  { type: "tool.execution_start", data: { toolName: "read_file", arguments: { filePath: `${WS}\\convert.py` } }, timestamp: T(12.2) },
  { type: "user.message", data: { content: "[Terminal 3ed3702d-ca6a-4619-ad6f-bc65e3635358 notification: command completed with exit code 0.]" }, timestamp: T(13) },
  { type: "tool.execution_start", data: { toolName: "replace_string_in_file", arguments: JSON.stringify({ filePath: `${WS}\\convert.py`, oldString: "print(1)", newString: "print(2)" }) }, timestamp: T(14) },
  {
    type: "tool.execution_start",
    data: {
      toolName: "multi_replace_string_in_file",
      arguments: { replacements: [{ filePath: `${WS}\\a.py`, oldString: "a", newString: "b" }, { filePath: `${WS}\\a.py`, oldString: "c", newString: "d" }, { filePath: `${WS}\\b.py`, oldString: "e", newString: "f" }] },
    },
    timestamp: T(15),
  },
  { type: "tool.execution_start", data: { toolName: "apply_patch", arguments: { input: patch, explanation: "docker" } }, timestamp: T(16) },
]);

// Patch log: kind 0 initial state, kind 2 appends requests (with real timestamps), kind 1 sets values.
writeRows(chat, [
  { kind: 0, v: { version: 3, sessionId: SID, creationDate: Date.parse(T(0)), customTitle: "Dataset conversion", requests: [] } },
  { kind: 2, k: ["requests"], v: [{ requestId: "r0", timestamp: Date.parse(T(1)), message: { text: "look at BUG_CODEZIP.jsonl and plan the conversion" }, response: [] }] },
  { kind: 2, k: ["requests", 0, "response"], v: [{ value: "Here is the plan." }] },
  { kind: 2, k: ["requests"], v: [{ requestId: "r1", timestamp: Date.parse(T(11)), message: { text: "make a python file that converts the dataset" }, response: [] }] },
  { kind: 1, k: ["customTitle"], v: "Java→Python dataset" },
]);

test("transcript: every edit tool becomes a code_edit; reads and injected terminal messages do not", () => {
  const events = parseFile("Copilot", transcript);
  const edits = events.filter((e) => e.kind === "code_edit");
  assert.deepEqual(
    edits.map((e) => [e.text.split(" ")[0], e.file]),
    [
      ["create_file", "convert.py"],
      ["replace_string_in_file", "convert.py"],
      ["multi_replace_string_in_file", "a.py"],
      ["multi_replace_string_in_file", "b.py"],
      ["apply_patch", "Dockerfile"],
      ["apply_patch", "run.sh"],
    ]
  );
  assert.match(edits[1].diff, /-print\(1\)[\s\S]*\+print\(2\)/);
  assert.equal(edits[2].diff.split("+b").length, 2, "two replacements in one file share one diff");
  assert.ok(events.every((e) => e.sessionId === SID));
  assert.ok(!events.some((e) => e.role === "user" && /\[Terminal/.test(e.text)), "terminal callbacks are not prompts");
  assert.equal(edits[0].ts, Date.parse(T(12)), "transcript timestamps are real");
});

test("chatSessions: kind 2 appends are folded, so requests keep their real timestamps and text", () => {
  // Without its twin, the patch log contributes every request.
  fs.renameSync(transcript, `${transcript}.off`);
  try {
    const users = parseFile("Copilot", chat).filter((e) => e.role === "user");
    assert.deepEqual(users.map((e) => [e.text, e.ts]), [
      ["look at BUG_CODEZIP.jsonl and plan the conversion", Date.parse(T(1))],
      ["make a python file that converts the dataset", Date.parse(T(11))],
    ]);
  } finally {
    fs.renameSync(`${transcript}.off`, transcript);
  }
});

test("twin files: chatSessions only adds what happened before the transcript started", () => {
  const users = parseFile("Copilot", chat).filter((e) => e.role === "user");
  assert.deepEqual(users.map((e) => e.text), ["look at BUG_CODEZIP.jsonl and plan the conversion"]);
});

test("projector: Copilot edits link to the request that caused them, with no duplicate turns", () => {
  const history = [...parseFile("Copilot", chat), ...parseFile("Copilot", transcript)]
    .sort((a, b) => a.ts - b.ts)
    .map((e) => unifyEvent(e, "Copilot", "alice"));
  const p = projectHistory(history, { workspacePath: WS });
  assert.equal(p.edits.length, 6);
  const prompt = (k) => p.turns.find((t) => t.turnKey === k)?.text;
  assert.ok(p.edits.every((e) => prompt(e.promptKey) === "make a python file that converts the dataset"));
  const texts = p.turns.map((t) => `${t.role}|${t.text}`);
  assert.equal(new Set(texts).size, texts.length, "each turn appears once");
  assert.equal(p.intents.get(`Copilot::${SID}`).title, "look at BUG_CODEZIP.jsonl and plan the conversion");
});

test("patchSections splits a multi-file apply_patch", () => {
  assert.deepEqual(
    patchSections(patch).map((s) => [s.op, path.win32.basename(s.filePath)]),
    [
      ["update", "Dockerfile"],
      ["add", "run.sh"],
    ]
  );
});

test("hooks: Copilot edit tools match, and apply_patch claims the files inside the patch", () => {
  const re = new RegExp(`^(${EDIT.copilot})$`);
  for (const t of ["replace_string_in_file", "multi_replace_string_in_file", "create_file", "apply_patch", "edit", "create"]) assert.ok(re.test(t), t);
  for (const t of ["read_file", "run_in_terminal", "grep_search"]) assert.ok(!re.test(t), t);
  assert.deepEqual(extractFilePaths({ toolName: "apply_patch", toolArgs: { input: patch } }), ["C:\\Users\\dev\\demo\\Dockerfile", "C:\\Users\\dev\\demo\\run.sh"]);
  assert.deepEqual(extractFilePaths({ tool_name: "apply_patch", tool_input: { command: ["apply_patch", patch] } }), ["C:\\Users\\dev\\demo\\Dockerfile", "C:\\Users\\dev\\demo\\run.sh"]);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
