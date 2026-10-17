const { readConfig, loadFileConfig, saveFileConfig, configPath, validUrl } = require("./config");
const { FalkorClient } = require("./client");
const schema = require("./schema");

const state = {
  cfg: null,
  client: null,
  deps: {},
  projects: new Map(),
  started: false,
};

function projectStats(projectId) {
  if (!state.projects.has(projectId)) {
    state.projects.set(projectId, {
      schemaVersion: null,
      needsRebuild: false,
      lastIngestAt: null,
      lastIngestCount: 0,
      bufferDrops: 0,
      droppedRows: 0,
      pendingLinks: 0,
      lastError: null,
    });
  }
  return state.projects.get(projectId);
}

function enabled() {
  return Boolean(state.started && state.cfg?.enabled);
}

async function ensureProject(projectId) {
  const info = await schema.ensure(state.client, projectId);
  const stats = projectStats(projectId);
  stats.schemaVersion = info.schemaVersion;
  stats.needsRebuild = info.needsRebuild;
  return info;
}

/** After any write: refresh the UI and let the analytics job know there's new structure. */
function notify(projectId, payload = {}) {
  try {
    // Not "graph": that event name already carries the dependency graph to the dashboard.
    state.deps.sse?.emit?.("memory-graph", { workspaceId: projectId, at: Date.now(), ...payload });
  } catch {
    /* UI refresh is best-effort */
  }
  require("./bus").emit("graph-written", { projectId });
}

function maskUrl(url) {
  return url ? url.replace(/\/\/[^@/]*@/, "//***@") : null;
}

function health() {
  return {
    enabled: Boolean(state.cfg?.enabled),
    running: state.started,
    url: maskUrl(state.cfg?.url),
    source: state.cfg?.source || null,
    configFile: configPath(),
    storeText: state.cfg?.storeText ?? null,
    breaker: state.client ? state.client.status() : null,
    projects: Object.fromEntries(state.projects),
  };
}

/** Starts the client and every module once; used at boot and by a runtime enable. */
function startGraph() {
  if (state.started) return;
  state.client = new FalkorClient(state.cfg);
  state.started = true;
  for (const name of MODULES) {
    try {
      require(name).start(module.exports);
    } catch (err) {
      console.warn(`[relay-falkor] ${name} failed to start: ${err.message || err}`);
    }
  }
  state.client
    .connection()
    .then(() => console.log(`[relay-falkor] connected ${maskUrl(state.cfg.url)}`))
    .catch((err) => console.warn(`[relay-falkor] not reachable yet (${err.message || err}); relay continues without it`));
}

/**
 * Turns the graph on in a running relay serve (`relay graph enable`, Mission Control's
 * Enable button). Saves the URL so the next start remembers it.
 */
async function enableAtRuntime(url) {
  const target = String(url || "").trim() || "falkor://127.0.0.1:6379";
  if (!validUrl(target)) throw Object.assign(new Error("URL must look like falkor://host:port"), { status: 400 });
  const saved = { ...(loadFileConfig() || {}), url: target };
  delete saved.disabled;
  saveFileConfig(saved);
  if (state.started) return { ...health(), note: "already running; restart relay serve to switch databases" };
  state.cfg = readConfig();
  if (!state.cfg.enabled) throw Object.assign(new Error("RELAY_FALKOR_DISABLED is set in this process"), { status: 409 });
  startGraph();
  try {
    await state.client.connection();
  } catch (err) {
    return { ...health(), warning: `saved, but FalkorDB is not reachable yet: ${err.message || err}` };
  }
  return health();
}

function registerRoutes(app) {
  app.get("/api/graph/health", (_req, res) => res.json(health()));
  app.post("/api/graph/enable", async (req, res) => {
    // Writes this machine's config: never through the room tunnel.
    if (require("../roomAuth").isRemoteRequest(req)) return res.status(403).json({ ok: false, reason: "local requests only" });
    try {
      res.json({ ok: true, ...(await enableAtRuntime(req.body?.url)) });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, reason: String(err.message || err) });
    }
  });
  // Registered even when disabled here: a room guest without FalkorDB still reads the host's graph.
  require("./routes").register(app, module.exports);
}

/**
 * Wires the memory graph into relay serve. Never throws: a broken or absent
 * FalkorDB must leave every existing relay behavior untouched.
 */
function init(app, deps = {}) {
  try {
    state.cfg = readConfig();
    state.deps = deps;
    registerRoutes(app);
    if (!state.cfg.enabled) {
      console.log("[relay-falkor] memory graph off (run `relay graph enable`, or set RELAY_FALKOR_URL)");
      return health();
    }
    startGraph();
  } catch (err) {
    console.warn(`[relay-falkor] init failed: ${err.message || err}`);
  }
  return health();
}

const MODULES = ["./ingest", "./coord", "./central", "./analytics"];

module.exports = { init, state, enabled, ensureProject, projectStats, health, notify, enableAtRuntime };
