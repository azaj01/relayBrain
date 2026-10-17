#!/usr/bin/env node
// Room end-to-end (#16) on one machine: two relays in isolated homes, joined as a room over
// localhost. Host (alice) has the memory graph; guest (bob) has none. Needs a running FalkorDB.
//   npm run test:e2e:room
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const REPO = path.join(__dirname, "..");
const { claudeSlug } = require(REPO + "/backend/lib/transcripts/util");
const { FalkorDB } = require("falkordb");
const FALKOR_URL = process.env.RELAY_FALKOR_URL || "falkor://127.0.0.1:6379";

const ROOT = fs.mkdtempSync(path.join(require("os").tmpdir(), "relay-room-e2e-"));
fs.rmSync(ROOT, { recursive: true, force: true });
const HOST = 3151;
const GUEST = 3152;
const PREFIX = "relay_room_";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

function side(name, login, pid, sid, prompt, file) {
  const home = path.join(ROOT, name, "home");
  const ws = path.join(ROOT, name, "ws");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "auth.ts"), "export const issuer = 'old';\n");
  const data = path.join(home, ".relay", "data");
  fs.mkdirSync(path.join(data, "projects", pid), { recursive: true });
  fs.writeFileSync(path.join(data, "registry.json"), JSON.stringify({ projects: [{ id: pid, name: "shared", path: ws }], users: [{ id: `u_${login}`, login, name: login }] }));
  fs.writeFileSync(path.join(data, "session.json"), JSON.stringify({ userId: `u_${login}`, login, projectId: pid }));
  const tdir = path.join(home, ".claude", "projects", claudeSlug(ws));
  fs.mkdirSync(tdir, { recursive: true });
  const transcript = path.join(tdir, `${sid}.jsonl`);
  const t0 = Date.now() - 60_000;
  const row = (type, content, dt) =>
    JSON.stringify({ type, sessionId: sid, cwd: ws, timestamp: new Date(t0 + dt).toISOString(), message: { role: type, content } });
  fs.writeFileSync(
    transcript,
    [
      row("user", prompt, 0),
      row("assistant", [{ type: "text", text: "On it." }, { type: "tool_use", name: "Edit", input: { file_path: path.join(ws, file), old_string: "'old'", new_string: "'new'" } }], 2000),
    ].join("\n") + "\n"
  );
  return { name, login, pid, sid, home, ws, transcript, agentId: `Claude Code:${name.toUpperCase()}-PC:${sid}` };
}

const alice = side("host", "alice", "proj_host", "aaaaaaaa-0000-4000-8000-000000000001", "migrate the login flow to JWT", "src/auth.ts");
const bob = side("guest", "bob", "proj_guest", "bbbbbbbb-0000-4000-8000-000000000002", "add rate limiting to the API client", "src/auth.ts");

// Room: alice hosts, bob holds a member token.
const bobToken = `rlm_${crypto.randomBytes(16).toString("hex")}`;
const hostRoom = {
  role: "host",
  url: `http://127.0.0.1:${HOST}`,
  roomId: "room_test",
  open: false,
  hostProjectId: alice.pid,
  hostWorkspacePath: alice.ws,
  projectId: alice.pid,
  projectPath: alice.ws,
  hostLogin: "alice",
  memberTokens: [{ login: "bob", tokenHash: crypto.createHash("sha256").update(bobToken).digest("hex"), issuedAt: Date.now() }],
  members: [{ login: "bob" }],
};
const guestRoom = {
  role: "guest",
  url: `http://127.0.0.1:${HOST}`,
  roomId: "room_test",
  memberToken: bobToken,
  hostProjectId: alice.pid,
  hostWorkspacePath: alice.ws,
  hostLogin: "alice",
  projectId: bob.pid,
  projectPath: bob.ws,
};
for (const [s, room] of [[alice, hostRoom], [bob, guestRoom]]) {
  fs.mkdirSync(path.join(s.home, ".relay"), { recursive: true });
  fs.writeFileSync(path.join(s.home, ".relay", "room.json"), JSON.stringify(room, null, 2));
}
// Host has the graph; guest deliberately has none.
fs.writeFileSync(path.join(alice.home, ".relay", "falkor.json"), JSON.stringify({ url: FALKOR_URL, prefix: PREFIX }));

function start(s, port) {
  const env = { ...process.env, USERPROFILE: s.home, HOME: s.home, RELAY_SKIP_GLOBAL_HOOKS: "1", RELAY_PORT: String(port) };
  delete env.RELAY_FALKOR_URL;
  const srv = spawn(process.execPath, [REPO + "/backend/server.js", "--port", String(port)], { env, cwd: s.ws });
  let log = "";
  srv.stdout.on("data", (d) => (log += d));
  srv.stderr.on("data", (d) => (log += d));
  return { srv, log: () => log };
}
async function up(proc) {
  for (let i = 0; i < 80 && !proc.log().includes("[relay-api]"); i++) await sleep(250);
}
const call = async (port, p, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  const db = await FalkorDB.connect({ url: FALKOR_URL });
  for (const g of await db.list()) if (g.startsWith(PREFIX)) await db.selectGraph(g).delete();
  const graph = db.selectGraph(PREFIX + alice.pid);
  const q = async (cypher) => (await graph.roQuery(cypher)).data;

  const host = start(alice, HOST);
  await up(host);
  const guest = start(bob, GUEST);
  await up(guest);
  await sleep(1500);
  try {
    // Each side ingests its own agent turn; the guest then pushes its snapshot to the host.
    await call(HOST, "/api/ingest-stop", { workspacePath: alice.ws, agent: "Claude Code", sessionId: alice.sid, transcript_path: alice.transcript });
    await call(GUEST, "/api/ingest-stop", { workspacePath: bob.ws, agent: "Claude Code", sessionId: bob.sid, transcript_path: bob.transcript });
    await sleep(6000);

    const people = await q("MATCH (p:Person)-[:RUNS]->(a:Agent)-[:RAN]->(s:Session) RETURN p.key AS person, s.intent AS intent ORDER BY person");
    check("1. guest's sessions reach the host graph under the guest's login", people.some((r) => r.person === "bob" && /rate limiting/.test(r.intent || "")), JSON.stringify(people));

    const who = await q("MATCH (p:Person)-[:RUNS]->(:Agent)-[t:TOUCHED]->(:File {key:'src/auth.ts'}) RETURN p.key AS person, sum(t.count) AS n ORDER BY person");
    check("1b. who_to_ask on the host sees both people on the shared file", who.length === 2, JSON.stringify(who));

    // Spoof: bob's token, but the body claims to be alice.
    const spoof = await call(HOST, "/api/room/history", { projectId: alice.pid, login: "mallory", snapshot: { chats: [{ id: "x", agent: "Cursor", sessionId: "spoof-1", messages: [{ role: "user", kind: "message", text: "spoofed prompt", ts: Date.now() }] }], edits: [] } }, { "x-relay-room-token": bobToken });
    await sleep(3500);
    const spoofed = await q("MATCH (p:Person)-[:RUNS]->(:Agent)-[:RAN]->(s:Session {key:'Cursor::spoof-1'}) RETURN p.key AS person");
    check("2. a pushed login is ignored; history is filed under the token's member", spoof.status === 200 && spoofed.length && spoofed.every((r) => r.person === "bob"), JSON.stringify({ status: spoof.status, filedUnder: spoofed }));
    const noToken = await call(HOST, "/api/room/history", { projectId: alice.pid, login: "bob", snapshot: {} }, { "x-forwarded-for": "8.8.8.8" });
    check("2b. a remote push without a member token is refused", noToken.status === 401, JSON.stringify(noToken));

    // Guest has no FalkorDB: its graph queries are answered by the host.
    const asked = await call(GUEST, `/api/graph/query/who_to_ask?path=src/auth.ts&workspace=${encodeURIComponent(bob.ws)}`);
    check("3. guest without FalkorDB gets graph answers from the host", asked.body.ok && asked.body.source === "host" && asked.body.rows?.length === 2, JSON.stringify({ status: asked.status, source: asked.body.source, rows: asked.body.rows?.map((r) => r.person) }));
    const brief = await call(GUEST, `/api/graph/query/session_brief?paths=src/auth.ts&workspace=${encodeURIComponent(bob.ws)}`);
    check("3b. guest's session brief includes the host's work", /migrate the login flow to JWT/.test(brief.body.markdown || ""), (brief.body.markdown || "").split("\n").slice(0, 6).join(" | "));

    // Host's agent holds auth.ts; guest's agent is blocked and told why.
    const held = await call(HOST, "/api/coord/claim", { agentId: alice.agentId, file: "src/auth.ts", workspaceId: alice.ws });
    const denied = await call(GUEST, "/api/coord/claim", { agentId: bob.agentId, file: "src/auth.ts", workspaceId: bob.ws });
    check("4. guest blocked by host's agent is told what the host's agent is doing", held.body.allowed && denied.body.allowed === false && /migrate the login flow to JWT/.test(denied.body.reason || ""), denied.body.reason);

    // Reverse: guest's agent holds a file; host's agent is blocked and told the guest's intent.
    const gHeld = await call(GUEST, "/api/coord/claim", { agentId: bob.agentId, file: "src/client.ts", workspaceId: bob.ws });
    const hDenied = await call(HOST, "/api/coord/claim", { agentId: alice.agentId, file: "src/client.ts", workspaceId: alice.ws });
    check("4b. host blocked by guest's agent is told the guest's intent (from its snapshot)", gHeld.body.allowed && hDenied.body.allowed === false && /rate limiting/.test(hDenied.body.reason || ""), hDenied.body.reason);
    await sleep(3500);
    const trace = await q("MATCH (c:Contention)-[:ON]->(f:File) RETURN f.key AS file, c.wanterLabel AS wanter, c.holderIntent AS holderWasDoing ORDER BY file");
    check("4c. both blocks recorded in the host graph with the holder's intent", trace.length === 2 && trace.every((r) => r.holderWasDoing), JSON.stringify(trace));

    // Tunnel down.
    host.srv.kill();
    await sleep(800);
    const down = await call(GUEST, `/api/graph/query/who_to_ask?path=src/auth.ts&workspace=${encodeURIComponent(bob.ws)}`);
    check("5. host down: guest gets a clear 503, not a crash", down.status === 503 && /unreachable/.test(down.body.reason || ""), JSON.stringify(down));
  } finally {
    host.srv.kill();
    guest.srv.kill();
    for (const g of await db.list()) if (g.startsWith(PREFIX)) await db.selectGraph(g).delete();
    await db.close();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    if (failed) {
      console.log("--- host log ---\n" + host.log().split("\n").filter((l) => /falkor|room|error|Error/i.test(l)).slice(-25).join("\n"));
      console.log("--- guest log ---\n" + guest.log().split("\n").filter((l) => /falkor|room|error|Error/i.test(l)).slice(-25).join("\n"));
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }
})();
