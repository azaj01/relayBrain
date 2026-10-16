const test = require("node:test");
const assert = require("node:assert");
const { FalkorClient } = require("./client");
const { readConfig } = require("./config");
const schema = require("./schema");

const URL = process.env.RELAY_FALKOR_TEST_URL;
const live = { skip: URL ? false : "set RELAY_FALKOR_TEST_URL to run FalkorDB integration tests" };

function cfg(url) {
  return { ...readConfig({ RELAY_FALKOR_URL: url }), prefix: "relay_test_", breakerCooldownMs: 200 };
}

test("config: disabled without url, enabled with url, kill-switch wins", () => {
  assert.equal(readConfig({}).enabled, false);
  assert.equal(readConfig({ RELAY_FALKOR_URL: "falkor://x:1" }).enabled, true);
  assert.equal(readConfig({ RELAY_FALKOR_URL: "falkor://x:1", RELAY_FALKOR_DISABLED: "1" }).enabled, false);
  assert.equal(readConfig({ RELAY_FALKOR_TEXT: "0" }).storeText, false);
});

test("graph names are sanitized per project", () => {
  const c = new FalkorClient(cfg("falkor://localhost:1"));
  assert.equal(c.graphName("proj_ab-12/..x"), "relay_test_proj_ab_12___x");
});

test("breaker opens on an unreachable server and fails fast while open", async () => {
  const c = new FalkorClient(cfg("falkor://127.0.0.1:6399"));
  await assert.rejects(c.read("p", "RETURN 1"));
  assert.equal(c.status().state, "open");
  const t = Date.now();
  await assert.rejects(c.read("p", "RETURN 1"), /breaker open/);
  assert.ok(Date.now() - t < 50, "open breaker must not touch the network");
});

test("schema bootstrap is idempotent and a syntax error does not trip the breaker", live, async () => {
  const c = new FalkorClient(cfg(URL));
  const pid = `s1_${Date.now()}`;
  try {
    const first = await schema.bootstrap(c, pid);
    assert.equal(first.needsRebuild, false);
    const count = async () => (await c.read(pid, "CALL db.indexes() YIELD label RETURN count(label) AS n"))[0].n;
    const n1 = await count();
    await schema.bootstrap(c, pid);
    assert.equal(await count(), n1);

    await assert.rejects(c.read(pid, "MATCH (n RETURN n"));
    assert.equal(c.status().state, "closed");
  } finally {
    await c.deleteGraph(pid).catch(() => undefined);
    await c.close();
  }
});

test("writes to one project are serialized", live, async () => {
  const c = new FalkorClient(cfg(URL));
  const pid = `s1q_${Date.now()}`;
  try {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => c.write(pid, "MERGE (n:Counter {key:'c'}) ON CREATE SET n.v = 0 SET n.v = n.v + 1 RETURN n.v", { i }))
    );
    const rows = await c.read(pid, "MATCH (n:Counter {key:'c'}) RETURN n.v AS v");
    assert.equal(rows[0].v, 20);
  } finally {
    await c.deleteGraph(pid).catch(() => undefined);
    await c.close();
  }
});
