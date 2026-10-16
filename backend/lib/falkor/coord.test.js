const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LockTable } = require("../../coordinator/lockTable");
const coord = require("./coord");
const intents = require("./intents");
const { FalkorClient } = require("./client");
const { readConfig } = require("./config");
const schema = require("./schema");
const { writeProjection } = require("./write");
const { projectHistory } = require("./project");

const URL = process.env.RELAY_FALKOR_TEST_URL;
const live = { skip: URL ? false : "set RELAY_FALKOR_TEST_URL to run FalkorDB integration tests" };

const A = "Claude Code:DESK:aaaaaaaa-1111";
const B = "Cursor:DESK:bbbbbbbb-2222";

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "relay-coord-"));
  return { ws, table: new LockTable({ workspacePath: ws, locksDir: path.join(ws, ".relay", "locks") }) };
}

function fakeApi(client) {
  const stats = {};
  return {
    state: { client, cfg: { storeText: true, breakerCooldownMs: 100 }, deps: {} },
    projectStats: (pid) => (stats[pid] ||= { bufferDrops: 0 }),
    ensureProject: (pid) => schema.ensure(client, pid),
  };
}

test("wrapper never changes a lock decision", () => {
  const plain = workspace();
  const wrapped = workspace();
  coord.wrapClaim(wrapped.table);
  coord.wrapClaim(wrapped.table);
  const script = [
    [A, "src/a.ts"],
    [B, "src/a.ts"],
    [B, "src/b.ts"],
    [A, "src/b.ts"],
    [A, "src/a.ts"],
  ];
  for (const [agentId, file] of script) {
    const p = plain.table.claim({ agentId, file, workspaceId: plain.ws });
    const w = wrapped.table.claim({ agentId, file, workspaceId: wrapped.ws });
    assert.equal(w.allowed, p.allowed, `${agentId} ${file}`);
    assert.equal(w.holder, p.holder);
  }
  const batchP = plain.table.claim({ agentId: B, files: ["src/c.ts", "src/a.ts"], workspaceId: plain.ws });
  const batchW = wrapped.table.claim({ agentId: B, files: ["src/c.ts", "src/a.ts"], workspaceId: wrapped.ws });
  assert.equal(batchW.allowed, batchP.allowed);
});

test("a denied agent is told what the holder is working on", () => {
  intents.clear();
  intents.remember({ sessionKey: "Claude Code::aaaaaaaa-1111", label: "Claude Code", intent: "migrate auth to JWT", intentAt: Date.now() - 3 * 60000 });
  const { ws, table } = workspace();
  coord.wrapClaim(table);
  assert.equal(table.claim({ agentId: A, file: "src/auth.ts", workspaceId: ws }).allowed, true);
  const denied = table.claim({ agentId: B, file: "src/auth.ts", workspaceId: ws });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /locked by .*Pick a different task\. They're working on: "migrate auth to JWT" \(3 min ago\)\./);
  assert.equal(denied.holderIntent.confidence, "high");
});

test("unknown holder session falls back to the agent's latest intent, labelled as such", () => {
  intents.clear();
  intents.remember({ sessionKey: "Claude Code::other", label: "Claude Code", intent: "refactor routes", intentAt: Date.now() });
  const r = coord.enrichDeny({ allowed: false, holder: "Claude Code:DESK:local", reason: "File `x` is locked." });
  assert.equal(r.holderIntent.confidence, "low");
  assert.match(r.reason, /That agent was last working on: "refactor routes"/);
  intents.clear();
  const none = coord.enrichDeny({ allowed: false, holder: "Codex:DESK:zzz", reason: "locked" });
  assert.equal(none.reason, "locked");
  assert.equal(coord.enrichDeny({ allowed: false, holder: "::", reason: "x" }).reason, "x");
});

async function withGraph(fn) {
  const c = new FalkorClient({ ...readConfig({ RELAY_FALKOR_URL: URL }), prefix: "relay_test_" });
  const pid = `coord_${Date.now()}`;
  try {
    await fn(c, pid);
  } finally {
    await c.deleteGraph(pid).catch(() => undefined);
    await c.close();
  }
}

test("live: retry storm → one Contention with holder session, intent and 4-hop trace", live, async () => {
  await withGraph(async (c, pid) => {
    coord.configure(fakeApi(c));
    intents.clear();
    // Holder session already known from its transcript.
    const history = [
      { id: "h1", agent: "Claude Code", ownerLogin: "alice", sessionId: "aaaaaaaa-1111", ts: Date.now() - 60000, role: "user", kind: "message", text: "migrate auth to JWT" },
    ];
    await schema.ensure(c, pid);
    const projection = projectHistory(history, { workspacePath: "C:\\ws" });
    for (const info of projection.intents.values()) intents.remember(info);
    await writeProjection(c, pid, projection);

    // Start of a 10 s contention bucket, so 25 retries 100 ms apart can't straddle two buckets.
    const now = Math.floor(Date.now() / 10_000) * 10_000;
    for (let i = 0; i < 25; i++) {
      coord.recordContention(pid, { kind: "claim_blocked", file: "src/auth.ts", wanter: B, holder: A, reason: "locked", ts: now + i * 100, holderIntentText: "migrate auth to JWT" });
    }
    coord.recordHeld(pid, A, "src/auth.ts");
    coord.recordHeld(pid, A, "src/auth.ts");
    await coord.flushAll();

    const rows = await c.read(
      pid,
      `MATCH (c:Contention)-[:ON]->(f:File {key:'src/auth.ts'})
       OPTIONAL MATCH (c)-[:HELD_BY]->(hs:Session)<-[:RAN]-(ha:Agent)
       OPTIONAL MATCH (c)-[:WANTED_BY]->(ws:Session)
       RETURN c.attempts AS attempts, ha.label AS holder, ha.login AS holderPerson, hs.intent AS holderWasDoing,
              c.holderIntent AS intentAtBlock, ws.label AS wanter, ws.stub AS wanterStub`
    );
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.deepEqual(rows[0], {
      attempts: 25,
      holder: "Claude Code",
      holderPerson: "alice",
      holderWasDoing: "migrate auth to JWT",
      intentAtBlock: "migrate auth to JWT",
      wanter: "Cursor",
      wanterStub: true,
    });
    const heldRows = await c.read(pid, "MATCH (s:Session)-[h:HELD]->(f:File) RETURN s.key AS s, h.count AS n");
    assert.deepEqual(heldRows, [{ s: "Claude Code::aaaaaaaa-1111", n: 2 }]);
  });
});
