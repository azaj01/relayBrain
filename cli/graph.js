// `relay graph …`: run, enable and inspect the FalkorDB memory graph without env vars.
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { readConfig, saveFileConfig, clearFileConfig, loadFileConfig, configPath, validUrl } = require("../backend/lib/falkor/config");

const root = path.join(__dirname, "..");
const compose = path.join(root, "docker-compose.falkor.yml");
const DEFAULT_URL = "falkor://localhost:6379";

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
  relay graph rebuild [id|all]   Rebuild a project's graph from its relay history (default: all)
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

async function graph(args) {
  const [sub, arg] = args;
  if (sub === "up") return up();
  if (sub === "enable") return enable(arg);
  if (sub === "disable") return disable();
  if (sub === "status") return status();
  if (sub === "rebuild") return rebuild(arg);
  help();
  if (sub && sub !== "help") process.exitCode = 1;
}

module.exports = { graph };
