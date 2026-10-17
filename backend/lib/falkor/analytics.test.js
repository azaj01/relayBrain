const test = require("node:test");
const assert = require("node:assert");
const analytics = require("./analytics");
const schema = require("./schema");
const { FalkorClient } = require("./client");
const { readConfig } = require("./config");
const { writeProjection } = require("./write");
const { projectHistory } = require("./project");
const { WS, wsPath } = require("./fixtures");

const URL = process.env.RELAY_FALKOR_TEST_URL;
const live = { skip: URL ? false : "set RELAY_FALKOR_TEST_URL to run FalkorDB integration tests" };

function edit(id, agent, sessionId, ts, file, login = "alice") {
  return { id, agent, ownerLogin: login, sessionId, ts, role: "tool", kind: "code_edit", text: "Edit", path: wsPath(...file.split("\\")) };
}

test("live: overlaps between agents, co-edit projection, pagerank + communities", live, async () => {
  const c = new FalkorClient({ ...readConfig({ RELAY_FALKOR_URL: URL }), prefix: "relay_test_" });
  const pid = `an_${Date.now()}`;
  const stats = {};
  analytics.configure({
    state: { client: c, cfg: {}, deps: {} },
    projectStats: (p) => (stats[p] ||= {}),
    ensureProject: (p) => schema.ensure(c, p),
  });
  try {
    const t = 1_800_000_000_000;
    const history = [
      { id: "u1", agent: "Claude Code", ownerLogin: "alice", sessionId: "s1", ts: t, role: "user", kind: "message", text: "auth" },
      edit("e1", "Claude Code", "s1", t + 1000, "src\\auth.ts"),
      edit("e2", "Claude Code", "s1", t + 2000, "src\\core.ts"),
      edit("e3", "Claude Code", "s1", t + 3000, "src\\login.ts"),
      { id: "u2", agent: "Cursor", ownerLogin: "bob", sessionId: "s2", ts: t, role: "user", kind: "message", text: "nav" },
      edit("e4", "Cursor", "s2", t + 60_000, "src\\core.ts", "bob"),
      edit("e5", "Cursor", "s2", t + 61_000, "src\\nav.ts", "bob"),
      edit("e6", "Cursor", "s3", t + 3_600_000, "src\\auth.ts", "bob"),
    ];
    await writeProjection(c, pid, projectHistory(history, { workspacePath: WS }));
    const summary = await analytics.run(pid);
    await analytics.run(pid);

    const overlaps = await c.read(pid, "MATCH (o:Overlap)-[:ON]->(f:File) RETURN f.key AS f, o.gapMs AS gap");
    assert.deepEqual(overlaps, [{ f: "src/core.ts", gap: 58_000 }], "only edits by different agents inside 5 min overlap, idempotently");
    const ranked = await c.read(pid, "MATCH (f:File) RETURN f.key AS f, f.rank AS rank ORDER BY rank DESC");
    assert.equal(ranked[0].f, "src/core.ts", `core is the hub: ${JSON.stringify(ranked)}`);
    const co = await c.read(pid, "MATCH (:File {key:'src/core.ts'})-[x:CO_EDITED]->(f:File) RETURN f.key AS f ORDER BY f");
    assert.deepEqual(co.map((r) => r.f), ["src/auth.ts", "src/login.ts", "src/nav.ts"]);
    const ent = await c.read(pid, "MATCH (a:Agent)-[x:OVERLAPS_WITH]->(b:Agent) RETURN a.key AS a, b.key AS b, x.weight AS w ORDER BY a");
    assert.deepEqual(ent, [
      { a: "alice::Claude Code", b: "bob::Cursor", w: 1 },
      { a: "bob::Cursor", b: "alice::Claude Code", w: 1 },
    ]);
    const communities = await c.read(pid, "MATCH (f:File) WHERE f.community IS NOT NULL RETURN count(f) AS n");
    assert.equal(communities[0].n, 4);
    assert.equal(summary.overlaps, 1);
  } finally {
    await c.deleteGraph(pid).catch(() => undefined);
    await c.close();
  }
});
