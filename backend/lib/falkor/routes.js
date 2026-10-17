const { runNamed, names } = require("./query");
const { projectIdFor } = require("./coord");
const { loadRoom } = require("../room");
const { loadRegistry, loadSession } = require("../store");

let api = null;

function argsFrom(req) {
  const q = { ...(req.query || {}), ...(req.body || {}) };
  if (typeof q.paths === "string") q.paths = q.paths.split(",").filter(Boolean);
  return q;
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
  const projectId = resolveProjectId(args);
  const room = loadRoom(args.workspace || projectPath(projectId) || undefined);
  if (room?.role === "guest" && room.url && api.state.deps.fetchHost && !args.local) {
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
  await api.ensureProject(projectId);
  return { ok: true, projectId, source: "local", ...(await runNamed(api.client, projectId, name, args)) };
}

function register(app, falkor) {
  api = { ...falkor, get client() {
    return falkor.state.client;
  } };
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
}

module.exports = { register, query };
