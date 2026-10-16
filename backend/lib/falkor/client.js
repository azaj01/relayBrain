const { FalkorDB } = require("falkordb");

function sanitizeGraphId(projectId) {
  return String(projectId || "default").replace(/[^A-Za-z0-9_]/g, "_");
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { timeout: true })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

class FalkorClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.db = null;
    this.connecting = null;
    this.queues = new Map();
    this.breaker = { state: "closed", until: 0, failures: 0, lastError: null, lastOkAt: 0 };
  }

  graphName(projectId) {
    return `${this.cfg.prefix}${sanitizeGraphId(projectId)}`;
  }

  available() {
    if (this.breaker.state !== "open") return true;
    if (Date.now() >= this.breaker.until) {
      this.breaker.state = "probing";
      return true;
    }
    return false;
  }

  async connection() {
    if (this.db) return this.db;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const db = await withTimeout(
        FalkorDB.connect({
          url: this.cfg.url,
          disableOfflineQueue: true,
          socket: {
            connectTimeout: 2000,
            reconnectStrategy: (retries) => Math.min(500 * (retries + 1), 5000),
          },
        }),
        4000,
        "falkor connect"
      );
      // An EventEmitter "error" with no listener throws and would take relay serve down.
      db.on("error", (err) => {
        this.breaker.lastError = String(err?.message || err);
      });
      this.db = db;
      return db;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  ok() {
    this.breaker.state = "closed";
    this.breaker.failures = 0;
    this.breaker.lastOkAt = Date.now();
  }

  fail(err) {
    const b = this.breaker;
    const message = String(err?.message || err);
    b.lastError = message;
    // Cypher errors are our bugs, not an outage; only the transport trips the breaker.
    const transport = /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|closed|offline|socket|connect/i.test(message);
    if (!transport && !err?.timeout) return;
    b.failures += 1;
    if (b.state === "probing" || transport || b.failures >= 3) {
      b.state = "open";
      b.until = Date.now() + this.cfg.breakerCooldownMs;
    }
  }

  async run(kind, projectId, query, params) {
    if (!this.available()) {
      const err = new Error("falkor unavailable (breaker open)");
      err.breaker = true;
      throw err;
    }
    try {
      const db = await this.connection();
      const graph = db.selectGraph(this.graphName(projectId));
      const timeoutMs = kind === "read" ? this.cfg.readTimeoutMs : this.cfg.writeTimeoutMs;
      const opts = { params: params || {}, TIMEOUT: timeoutMs };
      const call = kind === "read" ? graph.roQuery(query, opts) : graph.query(query, opts);
      const result = await withTimeout(call, timeoutMs + 500, `falkor ${kind}`);
      this.ok();
      return result.data || [];
    } catch (err) {
      if (!err.breaker) this.fail(err);
      throw err;
    }
  }

  // FalkorDB serializes writes per graph; chaining keeps our own batches from piling up.
  write(projectId, query, params) {
    const key = this.graphName(projectId);
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.run("write", projectId, query, params));
    this.queues.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  read(projectId, query, params) {
    return this.run("read", projectId, query, params);
  }

  async graph(projectId) {
    const db = await this.connection();
    return db.selectGraph(this.graphName(projectId));
  }

  async deleteGraph(projectId) {
    const g = await this.graph(projectId);
    try {
      await g.delete();
    } catch (err) {
      if (!/empty key|not exist|Invalid graph operation on empty key/i.test(String(err.message))) throw err;
    }
  }

  status() {
    return {
      state: this.breaker.state,
      failures: this.breaker.failures,
      lastError: this.breaker.lastError,
      lastOkAt: this.breaker.lastOkAt || null,
      reopensAt: this.breaker.state === "open" ? this.breaker.until : null,
      connected: Boolean(this.db),
    };
  }

  async close() {
    const db = this.db;
    this.db = null;
    if (db) await db.close().catch(() => undefined);
  }
}

module.exports = { FalkorClient, sanitizeGraphId, withTimeout };
