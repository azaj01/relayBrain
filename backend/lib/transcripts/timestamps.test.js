// #10: every parser says whether its times are real, Cursor is anchored on <timestamp>,
// and watcher patches find their transcript edit by content when times are approximate.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseFile } = require("./parse");
const { cursorStampTs, realTs } = require("./util");
const { unifyEvent } = require("./sync");
const { matchSameChange } = require("../falkor/write");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ts-"));
function write(rel, rows) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

test("cursorStampTs parses Cursor's embedded wall-clock time", () => {
  assert.equal(new Date(cursorStampTs("<timestamp>Saturday, Aug 22, 2026, 3:41 PM (UTC+5:30)</timestamp>\n<user_query>x</user_query>")).toISOString(), "2026-08-22T10:11:00.000Z");
  assert.equal(new Date(cursorStampTs("<timestamp>Monday, Aug 17, 2026, 1:39 AM (UTC-7)</timestamp>")).toISOString(), "2026-08-17T08:39:00.000Z");
  assert.equal(cursorStampTs("no stamp here"), null);
  assert.equal(realTs("2026-08-22T10:11:00Z"), Date.parse("2026-08-22T10:11:00Z"));
  assert.equal(realTs(undefined), null);
  assert.equal(realTs("not a date"), null);
});

test("Cursor: rows before a stamp are synthetic; the stamped turn and what follows are anchored", () => {
  const id = "0c3b4e57-307f-44d6-868c-8a249947470a";
  const file = write(`cursor/agent-transcripts/${id}/${id}.jsonl`, [
    { role: "user", message: { content: [{ type: "text", text: "<user_query>old turn without a stamp</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
    { role: "user", message: { content: [{ type: "text", text: "<timestamp>Saturday, Aug 22, 2026, 3:41 PM (UTC+5:30)</timestamp>\n<user_query>create test.txt</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Creating it." }, { type: "tool_use", name: "Write", input: { path: "C:/ws/test.txt", contents: "hello world from cursor\n" } }] } },
  ]);
  const events = parseFile("Cursor", file);
  const user2 = events.find((e) => e.text === "create test.txt");
  const edit = events.find((e) => e.kind === "code_edit");
  assert.equal(events[0].tsSynthetic, true);
  assert.equal(user2.tsSynthetic, false);
  assert.equal(user2.ts, Date.parse("2026-08-22T10:11:00Z"));
  assert.equal(edit.tsSynthetic, false);
  assert.equal(edit.ts, user2.ts + 1000, "rows after the anchor count forward from it");
  assert.ok(!user2.text.includes("<timestamp>"));
  assert.equal(unifyEvent(edit, "Cursor", "alice").tsSynthetic, false, "the flag survives unifyEvent");
});

test("parsers with recorded times say so", () => {
  const sid = "11111111-2222-3333-4444-555555555555";
  const claude = write(`claude/${sid}.jsonl`, [
    { type: "user", sessionId: sid, timestamp: "2026-10-16T10:00:00Z", message: { role: "user", content: "hi there" } },
    { type: "assistant", sessionId: sid, message: { role: "assistant", content: [{ type: "text", text: "no timestamp on this row" }] } },
  ]);
  const [a, b] = parseFile("Claude Code", claude);
  assert.equal(a.tsSynthetic, false);
  assert.equal(b.tsSynthetic, true);

  const copilot = write("copilot/GitHub.copilot-chat/transcripts/abc.jsonl", [
    { type: "session.start", data: { sessionId: "abc" }, timestamp: "2026-10-16T10:00:00Z" },
    { type: "user.message", data: { content: "rename it" }, timestamp: "2026-10-16T10:01:00Z" },
  ]);
  assert.equal(parseFile("Copilot", copilot)[0].tsSynthetic, false, "Copilot transcripts are real-timed, not blanket synthetic");
});

test("SAME_CHANGE: exact time wins; otherwise shared added lines within the window", () => {
  const patchDiff = "--- a/x.ts\n+++ b/x.ts\n+export const issuer = 'jwt';\n+export const ttl = 900;\n";
  const links = matchSameChange([
    // Patch A: a transcript edit 4 s away → time match, even though another candidate shares content.
    { patchKey: "A", editKey: "t-near", gap: 4000, patchDiff, editDiff: "+unrelated line here" },
    { patchKey: "A", editKey: "t-content", gap: 120000, patchDiff, editDiff: "+export const issuer = 'jwt';" },
    // Patch B: Cursor edit 3 min off (minute-precision stamp) but same added lines → content match.
    { patchKey: "B", editKey: "t-cursor", gap: 180000, patchDiff, editDiff: "+export const issuer = 'jwt';\n+export const ttl = 900;" },
    { patchKey: "B", editKey: "t-other", gap: 60000, patchDiff, editDiff: "+something else entirely" },
    // Patch C: nothing close in time, nothing shared → no link.
    { patchKey: "C", editKey: "t-x", gap: 300000, patchDiff, editDiff: "+different" },
  ]);
  assert.deepEqual(links.map((l) => [l.patchKey, l.editKey, l.method]), [
    ["A", "t-near", "time"],
    ["B", "t-cursor", "content"],
  ]);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
