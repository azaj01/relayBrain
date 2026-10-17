// `relay graph …`: run, enable and inspect the FalkorDB memory graph without env vars.
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { readConfig, saveFileConfig, clearFileConfig, loadFileConfig, configPath, validUrl } = require("../backend/lib/falkor/config");

const root = path.join(__dirname, "..");
const compose = path.join(root, "docker-compose.falkor.yml");
const DEFAULT_URL = "falkor://127.0.0.1:6379";

function api() {
  return `http://127.0.0.1:${Number(process.env.RELAY_PORT || 3001)}`;
}

function mask(url) {
  return url ? url.replace(/\/\/[^@/]*@/, "//***@") : url;
}

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
  return r.json();
}

function help() {
  console.log(`relay graph: the FalkorDB memory graph

  relay graph up                 Start FalkorDB in Docker (docker-compose.falkor.yml)
  relay graph enable [url]       Save the FalkorDB URL (default ${DEFAULT_URL}) and switch a running relay on
  relay graph disable            Turn the graph off (takes effect on the next relay serve)
  relay graph status             Config, connection and per-project ingest state
  relay graph stats [id|all]     Node/edge counts per label, memory usage, and turn time range
  relay graph rebuild [id|all]   Rebuild a project's graph from its relay history (default: all)
  relay graph seed [id]          Seed a realistic 5-agent coordination graph for live demos
`);
}

function up() {
  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", windowsHide: true });
  if (docker.error || docker.status !== 0) {
    console.error("Docker is not running. Start Docker Desktop (or the docker daemon), then run `relay graph up` again.");
    console.error(`Or run FalkorDB yourself and point relay at it: relay graph enable falkor://host:port`);
    process.exitCode = 1;
    return;
  }
  const r = spawnSync("docker", ["compose", "-f", compose, "up", "-d"], { stdio: "inherit", windowsHide: true });
  if (r.status !== 0) {
    process.exitCode = r.status || 1;
    return;
  }
  console.log(`\nFalkorDB is up on ${DEFAULT_URL} (browser UI: http://localhost:3010).`);
  console.log("Next: relay graph enable");
}

async function probe(url) {
  const { FalkorDB } = require("falkordb");
  const db = await Promise.race([
    FalkorDB.connect({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 4000)),
  ]);
  try {
    db.on?.("error", () => undefined);
    return await db.list();
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function enable(url) {
  const target = (url || "").trim() || DEFAULT_URL;
  if (!validUrl(target)) {
    console.error(`Not a FalkorDB URL: ${target}  (expected falkor://[user:pass@]host:port)`);
    process.exitCode = 1;
    return;
  }
  try {
    const graphs = await probe(target);
    console.log(`Connected to ${mask(target)} (${graphs.length} graph(s)).`);
  } catch (err) {
    console.error(`Cannot reach ${mask(target)}: ${err.message || err}`);
    console.error("Start it with `relay graph up`, or pass the right URL. Saving anyway.");
  }
  let running = false;
  try {
    const body = await getJson(`${api()}/api/graph/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
    });
    running = true;
    if (!body.ok) console.error(`relay serve refused: ${body.reason}`);
    else console.log(body.note || body.warning || "relay serve: memory graph is on.");
  } catch {
    saveFileConfig({ ...(loadFileConfig() || {}), url: target });
  }
  console.log(`Saved to ${configPath()}.`);
  if (!running) console.log("Start relay (`relay serve`) and it will use the graph.");
  const env = readConfig();
  if (env.source === "env") console.log(`Note: RELAY_FALKOR_URL is set in this shell and overrides the saved URL.`);
}

function disable() {
  const cfg = loadFileConfig();
  if (!cfg) {
    console.log("No saved graph config. (If RELAY_FALKOR_URL is set in your shell, unset it.)");
    return;
  }
  clearFileConfig();
  console.log(`Removed ${configPath()}. Restart relay serve to stop using the graph.`);
}

async function status() {
  const cfg = readConfig();
  console.log(`config: ${cfg.url ? `${mask(cfg.url)} (from ${cfg.source})` : "none — run `relay graph enable`"}`);
  console.log(`file:   ${configPath()}${fs.existsSync(configPath()) ? "" : " (not present)"}`);
  let health = null;
  try {
    health = await getJson(`${api()}/api/graph/health`);
  } catch {
    console.log("relay:  not running on " + api());
  }
  if (health) {
    const b = health.breaker;
    // Breaker states, in plain words: "closed" is the healthy one.
    const conn = !b ? "" : b.state === "closed" ? ", connected" : b.state === "open" ? ", FalkorDB unreachable (retrying)" : ", reconnecting";
    console.log(`relay:  graph ${health.running ? "running" : "off"}${conn}${b?.lastError && b.state !== "closed" ? ` (${b.lastError})` : ""}`);
    const projects = Object.entries(health.projects || {});
    if (!projects.length) console.log("        no project ingested yet in this process");
    for (const [id, p] of projects) {
      const when = p.lastIngestAt ? new Date(p.lastIngestAt).toLocaleString() : "never";
      console.log(`        ${id}: last ingest ${when}${p.needsRebuild ? ", NEEDS REBUILD (relay graph rebuild)" : ""}${p.lastError ? `, error: ${p.lastError}` : ""}`);
    }
  }
  if (cfg.url) {
    try {
      const graphs = await probe(cfg.url);
      console.log(`db:     reachable, ${graphs.length} graph(s): ${graphs.slice(0, 8).join(", ")}${graphs.length > 8 ? ", …" : ""}`);
    } catch (err) {
      console.log(`db:     unreachable (${err.message || err}). Try \`relay graph up\`.`);
      process.exitCode = 1;
    }
  }
}

function rebuild(target) {
  const cfg = readConfig();
  if (!cfg.url) {
    console.error("No FalkorDB configured. Run `relay graph enable` first.");
    process.exitCode = 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "falkor-rebuild.js"), target || "all"], {
      stdio: "inherit",
      env: { ...process.env, RELAY_FALKOR_URL: cfg.url },
      windowsHide: true,
    });
    child.on("exit", (code) => {
      process.exitCode = code || 0;
      resolve();
    });
  });
}

async function stats(target) {
  const cfg = readConfig();
  if (!cfg.url) {
    console.error("No FalkorDB configured. Run `relay graph enable` first.");
    process.exitCode = 1;
    return;
  }
  const { FalkorClient } = require("../backend/lib/falkor/client");
  const { loadRegistry } = require("../backend/lib/store");
  const client = new FalkorClient(cfg);
  try {
    const db = await client.connection();
    const regProjects = loadRegistry().projects || [];
    let selected = target && target !== "all"
      ? regProjects.filter((p) => p.id === target || p.name === target)
      : [...regProjects];
    if (!selected.length && target && target !== "all") {
      selected = [{ id: target, name: target }];
    }
    if (!selected.length) {
      const prefix = cfg.prefix || "relay_";
      const allGraphs = (await db.list()).filter((g) => g.startsWith(prefix));
      selected = allGraphs.map((g) => ({ id: g.slice(prefix.length), name: g.slice(prefix.length) }));
    }
    if (!selected.length) {
      console.log("No matching registered projects or FalkorDB graphs.");
      return;
    }
    for (const p of selected) {
      const gName = client.graphName(p.id);
      console.log(`\n${p.name} (${p.id}) -> graph ${gName}`);
      try {
        const nodes = await client.read(p.id, "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC");
        const edges = await client.read(p.id, "MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY count DESC");
        const span = await client.read(
          p.id,
          "MATCH (t:Turn) RETURN min(t.ts) AS oldest, max(t.ts) AS newest, count(t.text) AS withText, count(t) AS total"
        );
        const meta = await client.read(
          p.id,
          "MATCH (m:Meta {key:'meta'}) RETURN m.schemaVersion AS s, m.ingestVersion AS i, coalesce(m.migrations, []) AS migs, m.lastIngestAt AS lastIngestAt"
        );
        let memBytes = null;
        try {
          const g = db.selectGraph(gName);
          if (typeof g.memoryUsage === "function") {
            const mem = await g.memoryUsage();
            memBytes = Array.isArray(mem) ? mem[1] : mem?.total_graph_sz_mb || mem;
          }
        } catch {
          /* GRAPH.MEMORY USAGE optional on some server builds */
        }
        const nodeStr = nodes.map((r) => `${r.label}:${r.count}`).join("  ") || "empty";
        const edgeStr = edges.map((r) => `${r.type}:${r.count}`).join("  ") || "none";
        console.log(`  nodes:      ${nodeStr}`);
        console.log(`  edges:      ${edgeStr}`);
        if (span[0]?.total) {
          const oldest = span[0].oldest ? new Date(Number(span[0].oldest)).toISOString() : "n/a";
          const newest = span[0].newest ? new Date(Number(span[0].newest)).toISOString() : "n/a";
          console.log(`  turns:      ${span[0].withText}/${span[0].total} with text (${oldest} .. ${newest})`);
        }
        if (meta[0]) {
          console.log(`  schema:     v${meta[0].s} (ingest v${meta[0].i}), migrations: ${(meta[0].migs || []).join(", ") || "none"}`);
        }
        if (memBytes != null) {
          console.log(`  memory:     ${typeof memBytes === "number" ? `${(memBytes / 1024).toFixed(1)} KB` : JSON.stringify(memBytes)}`);
        }
      } catch (err) {
        console.log(`  (no graph or unreachable: ${err.message || err})`);
      }
    }
  } catch (err) {
    console.error(`Cannot connect to FalkorDB at ${mask(cfg.url)}: ${err.message || err}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

function seed(target) {
  const cfg = readConfig();
  if (!cfg.url) {
    console.error("No FalkorDB configured. Run `relay graph enable` first.");
    process.exitCode = 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const args = [path.join(root, "scripts", "falkor-seed-demo.js")];
    if (target) args.push(target);
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env, RELAY_FALKOR_URL: cfg.url },
      windowsHide: true,
    });
    child.on("exit", (code) => {
      process.exitCode = code || 0;
      resolve();
    });
  });
}

async function graph(args) {
  const [sub, arg] = args;
  if (sub === "up") return up();
  if (sub === "enable") return enable(arg);
  if (sub === "disable") return disable();
  if (sub === "status") return status();
  if (sub === "stats") return stats(arg);
  if (sub === "rebuild") return rebuild(arg);
  if (sub === "seed") return seed(arg);
  help();
  if (sub && sub !== "help") process.exitCode = 1;
}

module.exports = { graph };
