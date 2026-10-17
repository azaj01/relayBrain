const test = require("node:test");
const assert = require("node:assert");
const keys = require("./keys");
const { redact, storedText } = require("./redact");
const { projectHistory, diffStats } = require("./project");
const { demoHistory, WS, CLAUDE_SID, CURSOR_SID } = require("./fixtures");

const CLAUDE = `Claude Code::${CLAUDE_SID}`;
const CURSOR = `Cursor::${CURSOR_SID}`;

test("keys: sentinel sessions are never real sessions", () => {
  for (const s of ["", "session", "local", null, undefined, "LOCAL"]) assert.equal(keys.sessionKey("Cursor", s), null);
  assert.equal(keys.sessionKey("Cursor", "abc"), "Cursor::abc");
});

test("keys: lock agent ids parse into label/host/session", () => {
  assert.deepEqual(keys.parseLockAgentId(`Claude Code:DESKTOP-1:${CLAUDE_SID}`), {
    label: "Claude Code",
    host: "DESKTOP-1",
    session: CLAUDE_SID,
    sessionKnown: true,
  });
  assert.equal(keys.parseLockAgentId("Cursor:box:local").sessionKnown, false);
  assert.equal(keys.parseLockAgentId("Codex:box:a:b").session, "a:b");
  const lock = keys.parseLockAgentId(`Claude Code:DESKTOP-1:${CLAUDE_SID}`);
  assert.equal(keys.sessionKey(lock.label, lock.session), CLAUDE, "lock and transcript must produce the same session key");
});

test("keys: file keys are repo-relative, posix, lowercase, never escaping", () => {
  assert.equal(keys.fileKey("src\\Auth.ts"), "src/auth.ts");
  assert.equal(keys.fileKey("./src//a.js"), "src/a.js");
  for (const bad of ["C:\\x\\y.ts", "/etc/passwd", "../up.js", "a/../../b", "", null]) assert.equal(keys.fileKey(bad), null, String(bad));
});

test("keys: turn key is stable under peer clipping", () => {
  const long = "x".repeat(8000);
  const base = { login: "Alice", label: "Cursor", sessionId: "s", ts: 1.5, role: "user", kind: "message" };
  assert.equal(keys.turnKey({ ...base, text: long }), keys.turnKey({ ...base, login: "alice", text: `${long.slice(0, 3000)}\n…` }));
  assert.notEqual(keys.turnKey({ ...base, text: "a" }), keys.turnKey({ ...base, text: "b" }));
});

test("keys: contention retries inside 10s collapse to one key", () => {
  const base = { kind: "claim_blocked", fileKey: "a.ts", wanter: "w", holder: "h" };
  assert.equal(keys.contentionKey({ ...base, ts: 10_001 }), keys.contentionKey({ ...base, ts: 19_999 }));
  assert.notEqual(keys.contentionKey({ ...base, ts: 10_001 }), keys.contentionKey({ ...base, ts: 20_001 }));
  assert.equal(keys.overlapKey("f", "e1", "e2"), keys.overlapKey("f", "e2", "e1"));
});

test("keys: the parser's own flag wins; older history falls back to the fractional-ms tell", () => {
  assert.equal(keys.tsSynthetic(1786828212080, true), true);
  assert.equal(keys.tsSynthetic(1787214584994.685, false), false);
  assert.equal(keys.tsSynthetic(1787214584994.685, undefined), true);
  assert.equal(keys.tsSynthetic(1786828212080, undefined), false);
});

test("redact: secrets removed, prose kept", () => {
  const out = redact("use sk-ant-abcdefghijklmnopqrstuvwxyz and api_key=supersecretvalue123 plus ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok");
  assert.ok(!out.includes("sk-ant-abc") && !out.includes("supersecret") && !out.includes("ghp_abc"), out);
  assert.ok(out.includes("api_key=[redacted]") && out.endsWith("ok"), out);
  assert.equal(storedText("hello", 10, false), null);
  assert.equal(storedText("abcdefghijkl", 5), "abcde…");
});

test("projector: edits link to the user prompt and agent reply that preceded them", () => {
  const p = projectHistory(demoHistory(), { workspacePath: WS });
  const auth = p.edits.filter((e) => e.fileKey === "src/auth.ts");
  assert.equal(auth.length, 2);
  const turnText = (k) => p.turns.find((t) => t.turnKey === k)?.text;
  assert.equal(turnText(auth[0].promptKey), "switch the login flow to JWT tokens");
  assert.equal(turnText(auth[0].explainKey), "I'll update the token issuer first.");
  assert.match(turnText(auth[1].promptKey), /refresh tokens/);
  assert.equal(auth[0].promptGap, 2000);
  assert.equal(auth[0].sessionKey, CLAUDE);

  const nav = p.edits.find((e) => e.fileKey === "styles/navbar.css");
  assert.equal(turnText(nav.promptKey), "make the navbar sticky", "interleaved agents must not steal each other's prompts");
  assert.equal(nav.tsSynthetic, true);
});

test("projector: path handling (case, separators, outside workspace, missing)", () => {
  const p = projectHistory(demoHistory(), { workspacePath: WS });
  const auth = p.edits.filter((e) => e.fileKey === "src/auth.ts");
  assert.equal(new Set(auth.map((e) => e.fileKey)).size, 1, "Auth.ts and auth.ts are one file");
  assert.ok(!p.edits.some((e) => /notes\.md/.test(e.path || "")), "edits outside the workspace are dropped");
  const codex = p.edits.find((e) => e.sessionKey === "Codex::codex-1");
  assert.equal(codex.orphan, true);
  assert.equal(codex.fileKey, null);
});

test("projector: thinking excluded, secrets redacted, sentinel sessions bucketed", () => {
  const p = projectHistory(demoHistory(), { workspacePath: WS });
  assert.ok(!p.turns.some((t) => /issuer first$/.test(t.text) && t.kind === "thinking"));
  assert.equal(p.sessions.find((s) => s.sessionKey === CLAUDE).thinkingCount, 1);
  assert.ok(p.turns.every((t) => !String(t.text).includes("supersecret")));
  const ag = p.sessions.find((s) => s.label === "Antigravity");
  assert.equal(ag.bucket, true);
  assert.match(ag.sessionKey, /^Antigravity::nosession::alice::/);
  assert.equal(ag.sessionId, null);
});

test("projector: session intent is the latest prompt, title the first", () => {
  const p = projectHistory(demoHistory(), { workspacePath: WS });
  const s = p.intents.get(CLAUDE);
  assert.equal(s.title, "switch the login flow to JWT tokens");
  assert.match(s.intent, /^also add refresh tokens/);
  assert.ok(!s.intent.includes("supersecret"));
  assert.equal(p.intents.get(CURSOR).intent, "make the navbar sticky");
});

test("projector: deterministic, and isNew limits output without breaking links", () => {
  const a = projectHistory(demoHistory(), { workspacePath: WS });
  const b = projectHistory(demoHistory(), { workspacePath: WS });
  assert.deepEqual(a.edits, b.edits);
  assert.deepEqual(a.turns.map((t) => t.turnKey), b.turns.map((t) => t.turnKey));

  const history = demoHistory();
  const seen = new Set(history.slice(0, 7).map((e) => e.id));
  const d = projectHistory(history, { workspacePath: WS, isNew: (id) => !seen.has(id) });
  assert.deepEqual(d.edits.map((e) => e.fileKey), ["src/auth.ts", null]);
  assert.equal(d.edits[0].promptKey, a.edits.find((e) => e.editKey === d.edits[0].editKey).promptKey, "a new edit still links to an already-ingested prompt");
  assert.ok(!d.sessions.some((s) => s.sessionKey === CURSOR), "sessions with no new events are not re-sent");
});

test("projector: text storage off keeps cache intent but stores no text", () => {
  const p = projectHistory(demoHistory(), { workspacePath: WS, storeText: false });
  assert.ok(p.turns.every((t) => t.text === null));
  assert.ok(p.sessions.every((s) => s.intent === null && s.title === null));
  assert.ok(p.edits.every((e) => e.diffHead === null));
  assert.equal(p.intents.get(CURSOR).intent, "make the navbar sticky");
});

test("projector: 2000 events in under 50ms", () => {
  const big = [];
  for (let i = 0; i < 2000; i++) {
    big.push({
      id: `b${i}`,
      agent: i % 2 ? "Cursor" : "Claude Code",
      ownerLogin: "alice",
      sessionId: `s${i % 20}`,
      ts: i,
      role: i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool",
      kind: i % 3 === 2 ? "code_edit" : "message",
      text: `event ${i} `.repeat(30),
      path: `C:\\Users\\dev\\demo\\src\\f${i % 50}.ts`,
      diff: "+a\n-b\n",
    });
  }
  const t = process.hrtime.bigint();
  const p = projectHistory(big, { workspacePath: WS });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(p.edits.length > 600);
  assert.ok(ms < 50, `took ${ms}ms`);
});

test("projector: filler prompts ('continue') defer to the request they continue", () => {
  const base = { agent: "Claude Code", ownerLogin: "alice", sessionId: "s1" };
  const p = projectHistory(
    [
      { ...base, id: "a", ts: 1, role: "user", kind: "message", text: "add dark mode to the settings page" },
      { ...base, id: "b", ts: 2, role: "tool", kind: "code_edit", text: "Edit a.ts", path: "C:\\Users\\dev\\demo\\a.ts" },
      { ...base, id: "c", ts: 3, role: "user", kind: "message", text: "continue" },
      { ...base, id: "d", ts: 4, role: "tool", kind: "code_edit", text: "Edit b.ts", path: "C:\\Users\\dev\\demo\\b.ts" },
      { ...base, id: "e", ts: 5, role: "user", kind: "message", text: "Yes!" },
      { ...base, id: "f", ts: 6, role: "tool", kind: "code_edit", text: "Edit c.ts", path: "C:\\Users\\dev\\demo\\c.ts" },
    ],
    { workspacePath: WS }
  );
  const text = (k) => p.turns.find((t) => t.turnKey === k)?.text;
  assert.deepEqual(p.edits.map((e) => text(e.promptKey)), Array(3).fill("add dark mode to the settings page"));
  assert.deepEqual(p.edits.map((e) => e.promptVia), [null, "continue", "Yes!"]);
  const greeted = projectHistory(
    [
      { ...base, id: "g1", ts: 1, role: "user", kind: "message", text: "hi wassup" },
      { ...base, id: "g2", ts: 2, role: "user", kind: "message", text: "build a csv importer" },
      { ...base, id: "g3", ts: 3, role: "user", kind: "message", text: "thanks!" },
    ],
    { workspacePath: WS }
  );
  assert.equal(greeted.intents.get("Claude Code::s1").title, "build a csv importer");
  assert.equal(greeted.intents.get("Claude Code::s1").intent, "build a csv importer");
  assert.equal(p.intents.get("Claude Code::s1").intent, "add dark mode to the settings page");
});

test("diffStats ignores headers", () => {
  assert.deepEqual(diffStats("--- a\n+++ b\n+x\n-y\n+z\n"), { added: 2, removed: 1 });
});
