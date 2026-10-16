const { readConfig } = require("./config");
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

function health() {
  return {
    enabled: Boolean(state.cfg?.enabled),
    url: state.cfg?.url ? state.cfg.url.replace(/\/\/[^@/]*@/, "//***@") : null,
    storeText: state.cfg?.storeText ?? null,
    breaker: state.client ? state.client.status() : null,
    projects: Object.fromEntries(state.projects),
  };
}

function registerRoutes(app) {
  app.get("/api/graph/health", (_req, res) => res.json(health()));
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
      console.log("[relay-falkor] memory graph disabled (set RELAY_FALKOR_URL to enable)");
      return health();
    }
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
      .then(() => console.log(`[relay-falkor] connected ${health().url}`))
      .catch((err) => console.warn(`[relay-falkor] not reachable yet (${err.message || err}); relay continues without it`));
  } catch (err) {
    console.warn(`[relay-falkor] init failed: ${err.message || err}`);
  }
  return health();
}

const MODULES = ["./ingest", "./coord", "./central", "./analytics"];

module.exports = { init, state, enabled, ensureProject, projectStats, health, notify };
