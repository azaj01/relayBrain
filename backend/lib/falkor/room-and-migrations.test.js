// Room end-to-end tests (#16) and retention / in-place migration tests (#18).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-room-e2e-"));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { readConfig } = require("./config");
const { FalkorClient } = require("./client");
const schema = require("./schema");
const { runMigrations } = require("./migrations");
const analytics = require("./analytics");
const coord = require("./coord");
const intents = require("./intents");
const routes = require("./routes");
const { writeProjection } = require("./write");
const { projectHistory, projectPeer } = require("./project");
const { saveRoom, clearRoom } = require("../room");
const { saveRegistry, saveSession } = require("../store");
const { LockTable } = require("../../coordinator/lockTable");
const { WS, wsPath, CLAUDE_SID } = require("./fixtures");

const URL = process.env.RELAY_FALKOR_TEST_URL;
const live = { skip: URL ? false : "set RELAY_FALKOR_TEST_URL to run FalkorDB integration tests" };

test("config: RELAY_FALKOR_TEXT_DAYS defaults to 90 and can be overridden", () => {
  assert.equal(readConfig({}).textRetentionDays, 90);
  assert.equal(readConfig({ RELAY_FALKOR_TEXT_DAYS: "30" }).textRetentionDays, 30);
  assert.equal(readConfig({}, { url: "falkor://localhost:6379", textDays: 14 }).textRetentionDays, 14);
});

test("migrations: in-place version upgrade preserves existing nodes and stamps Meta", async () => {
  const writes = [];
  let metaState = { migrations: [], s: 1, i: 3 };
  const fakeClient = {
    async read(_pid, q) {
      if (q.includes("Meta")) return [metaState];
      return [];
    },
    async write(_pid, q, params) {
      writes.push({ q, params });
      if (params?.migrations) {
        metaState = { migrations: params.migrations, s: params.schema, i: params.ingest };
      }
      return [{ ok: 1 }];
    },
  };
  const first = await runMigrations(fakeClient, "proj_1", { schemaVersion: 1, ingestVersion: 6 });
  assert.deepEqual(first.ran, ["001_meta_versions_v6"]);
  assert.equal(metaState.i, 6);

  const second = await runMigrations(fakeClient, "proj_1", { schemaVersion: 1, ingestVersion: 6 });
  assert.deepEqual(second.ran, [], "idempotent on second run");
});

test("retention: pruneText nulls Turn.text and Edit.diffHead older than N days", async () => {
  const calls = [];
  const fakeClient = {
    async write(_pid, q, params) {
      calls.push({ q, params });
      return [{ n: 4 }];
    },
  };
  const now = 1_800_000_000_000;
  const out = await analytics.pruneText(fakeClient, "proj_1", 30, now);
  assert.deepEqual(out, { turnsPruned: 4, editsPruned: 4 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.cutoff, now - 30 * 86_400_000);
});

test("room e2e: guest without FalkorDB queries host graph over /mcp and degrades cleanly when tunnel drops", async () => {
  const wsGuest = path.join(home, "guest-repo");
  fs.mkdirSync(wsGuest, { recursive: true });
  saveRegistry({ projects: [{ id: "proj_guest", name: "demo", path: wsGuest }] });
  saveSession({ login: "bob", projectId: "proj_guest" });

  // Stand up a mock host HTTP server speaking POST /mcp for relay_graph_query
  const hostApp = express();
  hostApp.use(express.json());
  let hostDown = false;
  hostApp.post("/mcp", (req, res) => {
    if (hostDown) return res.status(502).json({ error: "tunnel_down" });
    const { id, params } = req.body || {};
    const qName = params?.arguments?.query;
    const payload = {
      ok: true,
      projectId: "proj_host",
      query: qName,
      summary: "answered by host",
      rows: [{ person: "alice", edits: 3, via: ["Claude Code"] }, { person: "bob", edits: 1, via: ["Cursor"] }],
    };
    res.json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    });
  });

  const server = http.createServer(hostApp);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const hostPort = server.address().port;
  const hostUrl = `http://127.0.0.1:${hostPort}`;

  try {
    saveRoom(
      {
        role: "guest",
        url: hostUrl,
        hostProjectId: "proj_host",
        projectId: "proj_guest",
        projectPath: wsGuest,
        memberToken: "rlm_testtoken",
      },
      wsGuest
    );

    const guestApp = express();
    guestApp.use(express.json());
    routes.register(guestApp, {
      state: {
        started: false, // Guest has NO FalkorDB running locally!
        client: null,
        deps: {
          fetchHost: (url, pathname, init) =>
            fetch(`${url}${pathname}`, {
              ...init,
              headers: { "Content-Type": "application/json" },
            }).then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r;
            }),
        },
      },
    });

    // 1. Guest without FalkorDB gets answer from Host graph
    const ans = await routes.query("who_to_ask", { path: "src/auth.ts", workspace: wsGuest });
    assert.equal(ans.ok, true);
    assert.equal(ans.source, "host");
    assert.equal(ans.rows.length, 2);

    // 2. Tunnel goes down -> guest without FalkorDB degrades cleanly
    hostDown = true;
    await assert.rejects(() => routes.query("who_to_ask", { path: "src/auth.ts", workspace: wsGuest }));
  } finally {
    clearRoom(wsGuest);
    await new Promise((r) => server.close(r));
  }
});

test("room e2e: bidirectional lock deny enrichment (host blocks guest & guest blocks host)", () => {
  intents.clear();
  const wsHost = path.join(home, "host-repo");
  fs.mkdirSync(wsHost, { recursive: true });
  const table = new LockTable({ workspacePath: wsHost, locksDir: path.join(wsHost, ".relay", "locks") });
  coord.wrapClaim(table);

  // Host session intent from local transcript
  const hostProj = projectHistory(
    [{ id: "h1", agent: "Claude Code", ownerLogin: "alice", sessionId: CLAUDE_SID, ts: Date.now() - 30_000, role: "user", kind: "message", text: "switch login flow to JWT tokens" }],
    { workspacePath: WS }
  );
  for (const info of hostProj.intents.values()) intents.remember(info);

  // Guest session intent from peer snapshot push (force-stamped to authenticated login 'bob')
  const guestSnap = {
    login: "spoofed",
    chats: [
      {
        id: "chat_cursor_g99",
        agent: "Cursor",
        ownerLogin: "spoofed",
        sessionId: "g99",
        messages: [{ role: "user", kind: "message", text: "add OAuth callback handler", ts: Date.now() - 15_000 }],
      },
    ],
    edits: [],
  };
  const guestProj = projectPeer(guestSnap, { login: "bob", trustRowOwners: false });
  assert.equal(guestProj.sessions[0].login, "bob", "peer owner spoofing prevented");
  for (const info of guestProj.intents.values()) intents.remember(info);

  // Direction A: Host holds src/auth.ts, Guest is blocked and told Host's intent
  const hostAgent = `Claude Code:HOSTBOX:${CLAUDE_SID}`;
  const guestAgent = `Cursor:GUESTBOX:g99@bob`;
  assert.equal(table.claim({ agentId: hostAgent, file: "src/auth.ts", workspaceId: wsHost }).allowed, true);
  const blockedGuest = table.claim({ agentId: guestAgent, file: "src/auth.ts", workspaceId: wsHost });
  assert.equal(blockedGuest.allowed, false);
  assert.match(blockedGuest.reason, /switch login flow to JWT tokens/);
  table.release({ agentId: hostAgent, file: "src/auth.ts", workspaceId: wsHost });

  // Direction B: Guest holds src/oauth.ts (with @bob suffix stamped by host), Host is blocked and told Guest's intent
  // with HIGH confidence (exact session match, not low-confidence label fallback)!
  // Add a newer Cursor session so a label fallback would return the wrong intent:
  intents.remember({ sessionKey: "Cursor::other_session", label: "Cursor", intent: "unrelated footer tweak", intentAt: Date.now() });
  assert.equal(table.claim({ agentId: guestAgent, file: "src/oauth.ts", workspaceId: wsHost }).allowed, true);
  const blockedHost = table.claim({ agentId: hostAgent, file: "src/oauth.ts", workspaceId: wsHost });
  assert.equal(blockedHost.allowed, false);
  assert.equal(blockedHost.holderIntent.confidence, "high", "must match guest's exact session after stripping @login");
  assert.match(blockedHost.reason, /add OAuth callback handler/, "host must strip @login suffix when looking up guest session intent");
});

test("live: version bump preserves history older than memory.json and pruneText keeps structure", live, async () => {
  const c = new FalkorClient({ ...readConfig({ RELAY_FALKOR_URL: URL }), prefix: "relay_test_" });
  const pid = `mig_${Date.now()}`;
  try {
    // Seed an "older" graph at ingestVersion = 4 with an ancient turn beyond memory.json's window
    await c.write(pid, "MERGE (m:Meta {key:'meta'}) SET m.schemaVersion = 1, m.ingestVersion = 4, m.createdAt = 1000");
    const oldTs = Date.now() - 120 * 86_400_000; // 120 days ago
    await writeProjection(
      c,
      pid,
      projectHistory(
        [
          { id: "old1", agent: "Claude Code", ownerLogin: "alice", sessionId: "s_old", ts: oldTs, role: "user", kind: "message", text: "initial architecture prompt" },
          { id: "old2", agent: "Claude Code", ownerLogin: "alice", sessionId: "s_old", ts: oldTs + 1000, role: "tool", kind: "code_edit", text: "Edit", path: wsPath("src", "arch.ts"), diff: "+old\n" },
        ],
        { workspacePath: WS }
      )
    );

    // Bootstrap now runs migrations in place instead of flagging needsRebuild
    const info = await schema.bootstrap(c, pid);
    assert.equal(info.needsRebuild, false, "migration upgraded ingestVersion in place");
    assert.equal(info.ingestVersion, schema.INGEST_VERSION);

    // Ancient turn and edit are still in the graph!
    const beforePrune = await c.read(pid, "MATCH (e:Edit)-[:PROMPTED_BY]->(t:Turn) RETURN t.text AS txt, e.diffHead AS diff");
    assert.equal(beforePrune.length, 1);
    assert.equal(beforePrune[0].txt, "initial architecture prompt");

    // Run 90-day retention: text/diffHead on 120-day-old nodes are nulled, but nodes and PROMPTED_BY edge remain!
    const pruned = await analytics.pruneText(c, pid, 90, Date.now());
    assert.equal(pruned.turnsPruned, 1);
    assert.equal(pruned.editsPruned, 1);
    const afterPrune = await c.read(pid, "MATCH (e:Edit)-[:PROMPTED_BY]->(t:Turn) RETURN t.text AS txt, e.diffHead AS diff, t.prunedAt IS NOT NULL AS pruned");
    assert.equal(afterPrune.length, 1);
    assert.equal(afterPrune[0].txt, null);
    assert.equal(afterPrune[0].diff, null);
    assert.equal(afterPrune[0].pruned, true);
  } finally {
    await c.deleteGraph(pid).catch(() => undefined);
    await c.close();
  }
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
