const { runNamed, names } = require("./query");
const { projectIdFor } = require("./coord");
const { demoGraphId, seedDemoGraph, rebuildProjectGraph } = require("./demo");
const { loadRoom } = require("../room");
const { loadRegistry, loadSession } = require("../store");

let api = null;

function argsFrom(req) {
  const q = { ...(req.query || {}), ...(req.body || {}) };
  if (typeof q.paths === "string") q.paths = q.paths.split(",").filter(Boolean);
  return q;
}

function isDemoMode(args) {
  return args?.demo === "1" || args?.demo === 1 || args?.demo === true || args?.mode === "demo";
}

function resolveProjectId(args) {
  if (args.projectId) return String(args.projectId);
  const byPath = projectIdFor(args.workspace);
  if (byPath) return byPath;
  const reg = loadRegistry();
  const session = loadSession();
  return reg.projects.find((p) => p.id === session.projectId)?.id || reg.projects[0]?.id || null;
}

function projectPath(projectId) {
  return loadRegistry().projects.find((p) => p.id === projectId)?.path || null;
}

/** A guest's graph lives on the host; ask it through the room's existing read-only MCP endpoint. */
async function askHost(room, name, args) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "relay_graph_query", arguments: { ...args, query: name, projectId: undefined, workspace: undefined } },
  };
  const res = await api.state.deps.fetchHost(room.url, "/mcp", { method: "POST", body: JSON.stringify(body), timeoutMs: 4000 });
  const json = await res.json();
  if (json.error) throw Object.assign(new Error(json.error.message || "host query failed"), { status: 502 });
  const text = json.result?.content?.[0]?.text;
  return { ...JSON.parse(text || "{}"), source: "host" };
}

/** Local graph first unless this machine is a room guest, in which case the host's graph is the room brain. */
async function query(name, args) {
  const baseProjectId = resolveProjectId(args);
  const demo = isDemoMode(args);
  const targetGraphId = demo ? demoGraphId(baseProjectId) : baseProjectId;
  const room = loadRoom(args.workspace || projectPath(baseProjectId) || undefined);
  if (!demo && room?.role === "guest" && room.url && api.state.deps.fetchHost && !args.local) {
    try {
      return await askHost(room, name, args);
    } catch (err) {
      if (!api.state.started) {
        throw Object.assign(new Error(`room host unreachable (${err.message || err}) and this machine has no memory graph of its own`), {
          status: 503,
        });
      }
      /* tunnel down: fall back to whatever this machine's own graph knows */
    }
  }
  if (!api.state.started) return { ok: false, reason: "falkor_disabled", hint: "set RELAY_FALKOR_URL and restart relay serve" };
  if (!api.client.available()) return { ok: false, reason: "falkor_unavailable", breaker: api.client.status() };
  await api.ensureProject(targetGraphId);
  return {
    ok: true,
    projectId: baseProjectId,
    graphId: targetGraphId,
    mode: demo ? "demo" : "live",
    source: "local",
    ...(await runNamed(api.client, targetGraphId, name, args)),
  };
}

function register(app, falkor) {
  api = {
    ...falkor,
    get client() {
      return falkor.state.client;
    },
  };
  const guard = falkor.state.deps.requireRoomMember || ((_req, _res, next) => next());
  const handler = async (req, res) => {
    try {
      res.json(await query(req.params.name, argsFrom(req)));
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, reason: String(err.message || err), queries: names() });
    }
  };
  app.get("/api/graph/queries", (_req, res) => res.json({ queries: names() }));
  app.get("/api/graph/query/:name", guard, handler);
  app.post("/api/graph/query/:name", guard, handler);

  // Local-only actions: seed the isolated demo sandbox or rebuild a real project graph from live transcripts.
  app.post("/api/graph/seed-demo", async (req, res) => {
    if (require("../roomAuth").isRemoteRequest(req)) return res.status(403).json({ ok: false, reason: "local requests only" });
    if (!api.state.started) return res.status(409).json({ ok: false, reason: "falkor_disabled" });
    try {
      const pid = resolveProjectId(argsFrom(req)) || "sandbox";
      const out = await seedDemoGraph(falkor, pid);
      res.json({ ok: true, projectId: pid, ...out });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, reason: String(err.message || err) });
    }
  });

  app.post("/api/graph/rebuild", async (req, res) => {
    if (require("../roomAuth").isRemoteRequest(req)) return res.status(403).json({ ok: false, reason: "local requests only" });
    if (!api.state.started) return res.status(409).json({ ok: false, reason: "falkor_disabled" });
    try {
      const q = argsFrom(req);
      const pid = resolveProjectId(q);
      if (!pid) return res.status(404).json({ ok: false, reason: "no project selected" });
      const out = await rebuildProjectGraph(falkor, pid, { keep: Boolean(q.keep) });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, reason: String(err.message || err) });
    }
  });
}

module.exports = { register, query };
