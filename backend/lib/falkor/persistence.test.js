// Restart safety (#21): no graph resurrection after delete, and a graph that lost
// data relative to the ingest cursor gets the history re-sent.
const fs = require("fs");
const os = require("os");
const path = require("path");

// Cursor files live under ~/.relay; keep this test's out of the real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-persist-"));
process.env.USERPROFILE = home;
process.env.HOME = home;

const test = require("node:test");
const assert = require("node:assert");
const { FalkorDB } = require("falkordb");
const { FalkorClient } = require("./client");
const { readConfig } = require("./config");
const schema = require("./schema");
const ingest = require("./ingest");
const { demoHistory, WS } = require("./fixtures");

const URL = process.env.RELAY_FALKOR_TEST_URL;
const live = { skip: URL ? false : "set RELAY_FALKOR_TEST_URL to run FalkorDB integration tests" };

async function graphNames() {
  const db = await FalkorDB.connect({ url: URL });
  try {
    return await db.list();
  } finally {
    await db.close();
  }
}

test("live: a deleted graph stays deleted (constraint creation is not left in flight)", live, async () => {
  const c = new FalkorClient({ ...readConfig({ RELAY_FALKOR_URL: URL }), prefix: "relay_test_" });
  const pid = `persist_${Date.now()}`;
  await schema.bootstrap(c, pid);
  await c.deleteGraph(pid);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!(await graphNames()).includes(c.graphName(pid)), "graph came back after delete");
  await c.close();
});

test("live: a graph that lost data behind the cursor gets history re-sent", live, async () => {
  const client = new FalkorClient({ ...readConfig({ RELAY_FALKOR_URL: URL }), prefix: "relay_test_" });
  const pid = `persist_resend_${Date.now()}`;
  const stats = {};
  const api = {
    state: { client, cfg: { storeText: true }, deps: {} },
    projectStats: (p) => (stats[p] ||= { droppedRows: 0 }),
    ensureProject: (p) => schema.ensure(client, p),
  };
  try {
    ingest.configure(api);
    const first = await ingest.ingestHistory(pid, demoHistory(), WS);
    assert.ok(first.turnsCreated > 0);

    // Same process, nothing lost: the cursor skips everything.
    assert.deepEqual(await ingest.ingestHistory(pid, demoHistory(), WS), { skipped: true });

    // Simulate a restart onto a database that lost the graph (wiped volume, lost snapshot).
    await client.deleteGraph(pid);
    schema.forget(pid);
    ingest._resetForTests();
    const again = await ingest.ingestHistory(pid, demoHistory(), WS);
    assert.equal(again.turnsCreated, first.turnsCreated, "history must be re-sent, not skipped by a stale cursor");
    const rows = await client.read(pid, "MATCH (e:Edit)-[:PROMPTED_BY]->(:Turn) RETURN count(e) AS n");
    assert.ok(rows[0].n > 0);

    // And a healthy restart does not re-send.
    schema.forget(pid);
    ingest._resetForTests();
    assert.deepEqual(await ingest.ingestHistory(pid, demoHistory(), WS), { skipped: true });
  } finally {
    await client.deleteGraph(pid).catch(() => undefined);
    await client.close();
  }
});

test("live: the test suite leaves no relay_test_ graphs behind", live, async () => {
  await new Promise((r) => setTimeout(r, 300));
  const leaked = (await graphNames()).filter((g) => g.startsWith("relay_test_persist"));
  assert.deepEqual(leaked, []);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
