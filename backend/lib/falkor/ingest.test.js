const test = require("node:test");
const assert = require("node:assert");
const { projectPatches, projectPeer, projectHistory, UNATTRIBUTED } = require("./project");
const { writeProjection } = require("./write");
const { FalkorClient } = require("./client");
const { readConfig } = require("./config");
const schema = require("./schema");
const { demoHistory, WS, CLAUDE_SID } = require("./fixtures");

const URL = process.env.RELAY_FALKOR_TEST_URL;
const live = { skip: URL ? false : "set RELAY_FALKOR_TEST_URL to run FalkorDB integration tests" };

function patch(fields) {
  return { id: `patch_${Math.random().toString(16).slice(2, 10)}`, file: "src/auth.ts", agent: "fs.watch", ownerLogin: "alice", lamport: 3, ts: 3000, sha256: "abc", diff: "+x\n", ...fields };
}

test("patch: author comes from the lock holder, not fs.watch", () => {
  const p = projectPatches([patch({ originAgentId: `Claude Code:DESK:${CLAUDE_SID}` })]).edits[0];
  assert.equal(p.label, "Claude Code");
  assert.equal(p.agentKey, "alice::Claude Code");
  assert.equal(p.sessionKey, `Claude Code::${CLAUDE_SID}`);
  assert.equal(p.source, "patch");

  const human = projectPatches([patch({ originAgentId: "o_8f2a1c" })]).edits[0];
  assert.equal(human.label, UNATTRIBUTED);
  assert.equal(human.sessionKey, null);
});

test("patch: bulk seed/snapshot copies and bad paths are skipped", () => {
  const rows = projectPatches([patch({ agent: "seed" }), patch({ agent: "snapshot" }), patch({ file: "../x" }), patch({})]).edits;
  assert.equal(rows.length, 1);
  const managed = [".claude/settings.json", ".cursor/rules/relay.mdc", "CLAUDE.md", ".github/hooks/relay-os.json", ".codex/config.toml"];
  assert.equal(projectPatches(managed.map((file) => patch({ file }))).edits.length, 0, "relay's own installer writes are not edits");
  assert.equal(projectPatches([patch({ file: "CLAUDE.md", originAgentId: `Claude Code:DESK:${CLAUDE_SID}` })]).edits.length, 1, "an agent editing CLAUDE.md still counts");
  assert.equal(projectPatches([patch({ file: ".github/workflows/ci.yml" })]).edits.length, 1);
});

function peerSnapshot() {
  return {
    login: "bob",
    chats: [
      {
        id: "chat_cursor_s9",
        agent: "Cursor",
        ownerLogin: "mallory",
        sessionId: "s9",
        messages: [
          { role: "user", kind: "message", text: "make checkout faster", ts: 100 },
          { role: "assistant", kind: "message", text: "Caching the cart.", ts: 101 },
          { role: "tool", kind: "code_edit", text: "Write cart.ts", file: "cart.ts", ts: 102 },
        ],
      },
    ],
    edits: [
      { id: "e_abc123", agent: "Cursor", ownerLogin: "bob", file: "src/cart.ts", ts: 102, diff: "+cache\n" },
      { id: "e_old999", agent: "Cursor", ownerLogin: "bob", file: "src/old.ts", ts: 50, diff: "+o\n" },
    ],
  };
}

test("peer: owner forced to authenticated login, edits re-attached to session + prompt", () => {
  const p = projectPeer(peerSnapshot(), { login: "bob" });
  assert.ok(p.sessions.every((s) => s.login === "bob"), "payload ownerLogin must not be trusted");
  const cart = p.edits.find((e) => e.editKey === "e_abc123");
  assert.equal(cart.sessionKey, "Cursor::s9");
  assert.equal(cart.fileKey, "src/cart.ts");
  assert.equal(p.turns.find((t) => t.turnKey === cart.promptKey).text, "make checkout faster");
  const old = p.edits.find((e) => e.editKey === "e_old999");
  assert.equal(old.sessionKey, null, "trimmed-thread edits keep file + agent but lose session");
  assert.equal(old.source, "transcript");
});

test("peer: peer turn keys equal the local turn keys for the same message", () => {
  const local = projectHistory(
    [{ id: "l1", agent: "Cursor", ownerLogin: "bob", sessionId: "s9", ts: 100, role: "user", kind: "message", text: "make checkout faster" }],
    { workspacePath: WS }
  );
  const peer = projectPeer(peerSnapshot(), { login: "bob" });
  assert.equal(local.turns[0].turnKey, peer.turns[0].turnKey);
});

async function withGraph(fn) {
  const c = new FalkorClient({ ...readConfig({ RELAY_FALKOR_URL: URL }), prefix: "relay_test_" });
  const pid = `ing_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  await schema.bootstrap(c, pid);
  try {
    await fn(c, pid);
  } finally {
    await c.deleteGraph(pid).catch(() => undefined);
    await c.close();
  }
}

test("live: patch and transcript edit of one change link via SAME_CHANGE, either order", live, async () => {
  for (const order of ["patch-first", "transcript-first"]) {
    await withGraph(async (c, pid) => {
      const transcript = projectHistory(demoHistory(), { workspacePath: WS });
      const p = projectPatches([patch({ originAgentId: `Claude Code:DESK:${CLAUDE_SID}`, ts: 3004 })]);
      if (order === "patch-first") {
        await writeProjection(c, pid, transcript.sessions.length ? { ...p, sessions: transcript.sessions } : p);
        await writeProjection(c, pid, transcript);
      } else {
        await writeProjection(c, pid, transcript);
        await writeProjection(c, pid, p);
      }
      const rows = await c.read(pid, "MATCH (p:Edit {source:'patch'})-[s:SAME_CHANGE]->(t:Edit) RETURN t.key AS t, s.gapMs AS gap");
      assert.equal(rows.length, 1, order);
      assert.equal(rows[0].gap, 4, order);
      const made = await c.read(pid, "MATCH (s:Session)-[:MADE]->(e:Edit {source:'patch'}) RETURN s.key AS s");
      assert.equal(made[0].s, `Claude Code::${CLAUDE_SID}`, order);
    });
  }
});

test("live: same peer snapshot pushed 5x does not grow the graph", live, async () => {
  await withGraph(async (c, pid) => {
    const counts = [];
    for (let i = 0; i < 5; i++) {
      await writeProjection(c, pid, projectPeer(peerSnapshot(), { login: "bob" }));
      counts.push((await c.read(pid, "MATCH (n) RETURN count(n) AS n"))[0].n);
    }
    assert.equal(new Set(counts).size, 1, `node counts changed: ${counts}`);
    const touched = await c.read(pid, "MATCH (:Agent {key:'bob::Cursor'})-[t:TOUCHED]->(f:File) RETURN f.key AS f, t.count AS n ORDER BY f");
    assert.deepEqual(touched, [{ f: "src/cart.ts", n: 1 }, { f: "src/old.ts", n: 1 }]);
  });
});

test("live: who_to_ask style query sees both people on a shared file", live, async () => {
  await withGraph(async (c, pid) => {
    await writeProjection(c, pid, projectHistory(demoHistory(), { workspacePath: WS }));
    const snap = peerSnapshot();
    snap.edits[0].file = "src/auth.ts";
    snap.chats[0].messages[2].file = "auth.ts";
    await writeProjection(c, pid, projectPeer(snap, { login: "bob" }));
    const rows = await c.read(
      pid,
      "MATCH (p:Person)-[:RUNS]->(:Agent)-[t:TOUCHED]->(:File {key:'src/auth.ts'}) RETURN p.key AS person, sum(t.count) AS n ORDER BY person"
    );
    assert.deepEqual(rows, [{ person: "alice", n: 2 }, { person: "bob", n: 1 }]);
  });
});
