const test = require("node:test");
const assert = require("node:assert");
const central = require("./central");
const schema = require("./schema");
const { FalkorClient } = require("./client");
const { readConfig } = require("./config");
const { writeProjection } = require("./write");
const { projectHistory } = require("./project");
const { WS, wsPath } = require("./fixtures");

const URL = process.env.RELAY_FALKOR_TEST_URL;
const live = { skip: URL ? false : "set RELAY_FALKOR_TEST_URL to run FalkorDB integration tests" };

function configure(client) {
  central.configure({
    state: { client, cfg: { storeText: true }, deps: { currentUser: () => ({ login: "alice" }) } },
    projectStats: () => ({}),
    ensureProject: (pid) => schema.ensure(client, pid),
  });
}

test("mentions: file-like tokens only, no urls or versions", () => {
  assert.deepEqual(
    central.mentions("Use JWT in src/auth.ts and update auth.ts, see https://x.io/a.html, bump to 1.2.3"),
    ["src/auth.ts", "auth.ts"]
  );
});

test("toRow: attribution, keys, explicit files", () => {
  configure({});
  const r = central.toRow({ event_id: 7, kind: "decision", decision_id: "jwt", content: "Use JWT", user: "local", agent_label: "Claude Code", files: ["src\\Auth.ts", "../bad"], ts: "2026-10-16T10:00:00Z" });
  assert.equal(r.key, "d_jwt");
  const relayLogin = require("./keys").loginKey(require("../store").loadSession().login || "local");
  assert.equal(r.login, relayLogin, "'local' MCP user falls back to the relay session login, like transcripts do");
  assert.equal(r.agentKey, `${relayLogin}::Claude Code`);
  assert.equal(central.toRow({ event_id: 1, kind: "decision", content: "x", user: "Bob" }).login, "bob");
  assert.equal(r.attribution, "explicit");
  assert.deepEqual(r.explicit, [{ fileKey: "src/auth.ts", path: "src/Auth.ts" }]);
  assert.equal(central.toRow({ event_id: 8, kind: "task", content: "x", agent_source: "mcp:local:stdio" }).attribution, "unknown");
  assert.equal(central.toRow({ event_id: 9, kind: "change" }), null);
});

test("live: revisions, explicit + unambiguous mentioned files, inferred session", live, async () => {
  const c = new FalkorClient({ ...readConfig({ RELAY_FALKOR_URL: URL }), prefix: "relay_test_" });
  const pid = `central_${Date.now()}`;
  configure(c);
  try {
    await schema.ensure(c, pid);
    const now = Date.parse("2026-10-16T10:00:00Z");
    const history = [
      { id: "1", agent: "Claude Code", ownerLogin: "alice", sessionId: "s1", ts: now - 60000, role: "user", kind: "message", text: "auth work" },
      { id: "2", agent: "Claude Code", ownerLogin: "alice", sessionId: "s1", ts: now - 50000, role: "tool", kind: "code_edit", text: "Edit", path: wsPath("src", "auth.ts") },
      { id: "3", agent: "Claude Code", ownerLogin: "alice", sessionId: "s1", ts: now - 40000, role: "tool", kind: "code_edit", text: "Edit", path: wsPath("a", "index.ts") },
      { id: "4", agent: "Claude Code", ownerLogin: "alice", sessionId: "s1", ts: now - 30000, role: "tool", kind: "code_edit", text: "Edit", path: wsPath("b", "index.ts") },
    ];
    await writeProjection(c, pid, projectHistory(history, { workspacePath: WS }));
    const iso = new Date(now).toISOString();
    const rows = [
      { event_id: 1, kind: "decision", decision_id: "jwt", content: "Use JWT; touches auth.ts and index.ts", status: "open", agent_label: "Claude Code", user: "alice", ts: iso },
      { event_id: 2, kind: "decision", decision_id: "jwt", content: "Use JWT with refresh tokens", status: "accepted", agent_label: "Claude Code", user: "alice", files: ["src/session.ts"], ts: new Date(now + 1000).toISOString() },
    ].map(central.toRow);
    await central.writeRows(pid, rows);
    await central.writeRows(pid, rows);

    const d = (await c.read(pid, "MATCH (d:Decision {key:'d_jwt'}) RETURN d.revisions AS revisions, d.status AS status, d.content AS content"))[0];
    assert.deepEqual(d, { revisions: 2, status: "accepted", content: "Use JWT with refresh tokens" });
    const about = await c.read(pid, "MATCH (:Decision {key:'d_jwt'})-[a:ABOUT]->(f:File) RETURN f.key AS f, a.how AS how ORDER BY f");
    assert.deepEqual(about, [
      { f: "src/auth.ts", how: "mentioned" },
      { f: "src/session.ts", how: "explicit" },
    ]);
    const during = await c.read(pid, "MATCH (:Decision)-[x:DURING]->(s:Session) RETURN s.key AS s, x.confidence AS c");
    assert.deepEqual(during, [{ s: "Claude Code::s1", c: "inferred" }]);
    const who = await c.read(pid, "MATCH (p:Person)-[:RUNS]->(a:Agent)-[:DECIDED]->(:Decision) RETURN p.key AS p, a.label AS a");
    assert.deepEqual(who, [{ p: "alice", a: "Claude Code" }]);
  } finally {
    await c.deleteGraph(pid).catch(() => undefined);
    await c.close();
  }
});
