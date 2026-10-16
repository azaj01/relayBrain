const { bus } = require("./bus");
const cursor = require("./cursor");
const intents = require("./intents");
const { projectHistory, projectPatches, projectPeer } = require("./project");
const { writeProjection } = require("./write");

const DEBOUNCE_MS = 2000;
const pending = new Map();
const running = new Map();
let api = null;

function log(projectId, msg) {
  console.log(`[relay-falkor] ${projectId}: ${msg}`);
}

/** Projects + writes everything in `history` the cursor hasn't confirmed yet. */
async function ingestHistory(projectId, history, workspacePath, opts = {}) {
  const { client, state } = api;
  const stats = api.projectStats(projectId);
  await api.ensureProject(projectId);
  const cur = opts.full ? { ...cursor.load(projectId), seen: [] } : cursor.load(projectId);
  const seen = cursor.seenSet(cur);
  const projection = projectHistory(history, {
    workspacePath,
    isNew: (id) => !seen.has(id),
    storeText: state.cfg.storeText,
  });
  for (const info of projection.intents.values()) intents.remember(info);
  if (!projection.sessions.length && !projection.turns.length && !projection.edits.length) return { skipped: true };

  const t = Date.now();
  const result = await writeProjection(client, projectId, projection);
  cursor.commit(projectId, cur, (history || []).map((e) => e.id).filter(Boolean));
  stats.lastIngestAt = Date.now();
  stats.lastIngestCount = result.turnsCreated + result.editsCreated;
  stats.droppedRows += projection.dropped;
  stats.lastError = null;
  log(projectId, `+${result.turnsCreated} turns, +${result.editsCreated} edits, ${result.sessions} sessions (${Date.now() - t}ms)`);
  api.notify?.(projectId, result);
  return result;
}

function schedule(projectId, payload) {
  const entry = pending.get(projectId) || {};
  entry.payload = payload;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flush(projectId), DEBOUNCE_MS);
  if (entry.timer.unref) entry.timer.unref();
  pending.set(projectId, entry);
}

async function flush(projectId) {
  const entry = pending.get(projectId);
  if (!entry) return;
  if (running.get(projectId)) {
    schedule(projectId, entry.payload);
    return;
  }
  pending.delete(projectId);
  if (!api.client.available()) return;
  running.set(projectId, true);
  try {
    const { history, workspacePath } = entry.payload;
    await ingestHistory(projectId, history, workspacePath);
  } catch (err) {
    // Replayable: the cursor wasn't committed, so the next sync re-sends these events.
    api.projectStats(projectId).lastError = String(err.message || err);
    if (!err.breaker) log(projectId, `ingest failed: ${err.message || err}`);
  } finally {
    running.delete(projectId);
  }
}

// ---- patches: not replayable from history, so failed batches go back into a bounded buffer
const PATCH_BUFFER_MAX = 2000;
const patchQueues = new Map();

function queuePatch(projectId, patch) {
  const q = patchQueues.get(projectId) || { items: [], timer: null };
  q.items.push(patch);
  if (q.items.length > PATCH_BUFFER_MAX) {
    q.items.splice(0, q.items.length - PATCH_BUFFER_MAX);
    api.projectStats(projectId).bufferDrops += 1;
  }
  if (!q.timer) {
    q.timer = setTimeout(() => flushPatches(projectId), 1000);
    if (q.timer.unref) q.timer.unref();
  }
  patchQueues.set(projectId, q);
}

async function flushPatches(projectId) {
  const q = patchQueues.get(projectId);
  if (!q) return;
  q.timer = null;
  const items = q.items.splice(0);
  if (!items.length) return;
  const retry = () => {
    q.items.unshift(...items);
    q.timer = setTimeout(() => flushPatches(projectId), api.state.cfg.breakerCooldownMs);
    if (q.timer.unref) q.timer.unref();
  };
  if (!api.client.available()) return retry();
  try {
    await api.ensureProject(projectId);
    const result = await writeProjection(api.client, projectId, projectPatches(items, { storeText: api.state.cfg.storeText }));
    if (result.editsCreated) log(projectId, `+${result.editsCreated} patch edits`);
    api.notify?.(projectId, result);
  } catch (err) {
    api.projectStats(projectId).lastError = String(err.message || err);
    retry();
  }
}

// ---- room peers: debounced per (project, peer); content-addressed keys make re-pushes no-ops
const peerSeen = new Map();
const PEER_SEEN_MAX = 20000;

function seenFor(projectId) {
  if (!peerSeen.has(projectId)) peerSeen.set(projectId, new Set());
  return peerSeen.get(projectId);
}

async function ingestPeer(projectId, { snapshot, login, trustRowOwners }) {
  await api.ensureProject(projectId);
  const seen = seenFor(projectId);
  const projection = projectPeer(snapshot, {
    login,
    trustRowOwners,
    isNew: (id) => !seen.has(id),
    storeText: api.state.cfg.storeText,
  });
  for (const info of projection.intents.values()) intents.remember(info);
  if (!projection.turns.length && !projection.edits.length) return { skipped: true };
  const result = await writeProjection(api.client, projectId, projection);
  for (const t of projection.turns) seen.add(`peer_${t.turnKey}`);
  for (const e of projection.edits) seen.add(String(e.editKey).replace(/^e_/, ""));
  for (const e of projection.edits) seen.add(e.editKey);
  if (seen.size > PEER_SEEN_MAX) peerSeen.set(projectId, new Set([...seen].slice(-PEER_SEEN_MAX / 2)));
  log(projectId, `peer ${login}: +${result.turnsCreated} turns, +${result.editsCreated} edits`);
  api.notify?.(projectId, { peer: login, ...result });
  return result;
}

const peerTimers = new Map();
function schedulePeer(projectId, payload) {
  const key = `${projectId}|${payload.login}`;
  const entry = peerTimers.get(key) || {};
  entry.payload = payload;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    peerTimers.delete(key);
    if (!api.client.available()) return;
    try {
      await ingestPeer(projectId, entry.payload);
    } catch (err) {
      api.projectStats(projectId).lastError = String(err.message || err);
    }
  }, DEBOUNCE_MS);
  if (entry.timer.unref) entry.timer.unref();
  peerTimers.set(key, entry);
}

function start(falkor) {
  api = { ...falkor, client: falkor.state.client, state: falkor.state };
  bus.on("history", ({ project, workspacePath, memory }) => {
    if (!project?.id || !Array.isArray(memory?.history)) return;
    schedule(project.id, { history: memory.history, workspacePath: workspacePath || project.path });
  });
  bus.on("patch", ({ projectId, patch }) => {
    if (projectId && patch) queuePatch(projectId, patch);
  });
  bus.on("peer", ({ projectId, key, login, snapshot }) => {
    if (!projectId || !snapshot) return;
    // A guest's "host" bucket aggregates several people, so its row owners are meaningful;
    // a single peer's push is forced to that peer's authenticated login.
    const trustRowOwners = key === "host";
    schedulePeer(projectId, { snapshot, login: login || key, trustRowOwners });
  });
}

function configure(falkor) {
  api = { ...falkor, client: falkor.state.client, state: falkor.state };
}

module.exports = { start, configure, ingestHistory, ingestPeer, flush, flushPatches };
