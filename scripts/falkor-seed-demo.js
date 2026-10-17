#!/usr/bin/env node
// Seeds a rich, realistic multi-agent coordination history + FalkorDB graph for the live demo (#14, #15).
// Safe to run against a local or cloud FalkorDB instance; contains zero personal transcripts.
const path = require("path");
const falkor = require("../backend/lib/falkor");
const schema = require("../backend/lib/falkor/schema");
const { projectHistory, projectPeer } = require("../backend/lib/falkor/project");
const { writeProjection } = require("../backend/lib/falkor/write");
const coord = require("../backend/lib/falkor/coord");
const central = require("../backend/lib/falkor/central");
const analytics = require("../backend/lib/falkor/analytics");
const intents = require("../backend/lib/falkor/intents");
const { loadRegistry } = require("../backend/lib/store");

const WS = process.platform === "win32" ? "C:\\demo\\relay-app" : "/workspace/relay-app";
const wsFile = (...parts) => path.join(WS, ...parts);

const S_CLAUDE = "52b29a54-d8fb-4091-ab60-463ac73c9d6c";
const S_CURSOR = "3e62675d-9b0f-4d99-b17d-c1d875fe98dc";
const S_CODEX = "019e1fdf-e54d-70e2-ae26-d0d7103a404f";
const S_COPILOT = "fcc51653-804f-4e4f-9330-347a42abd57c";
const S_ANTI = "46d9adf1-1b25-4cf7-bd41-da8309d19f08";

function buildDemoHistory(now = Date.now()) {
  const m = (minsAgo) => now - minsAgo * 60_000;
  return [
    // Session 1: Claude Code (@alice) switching login flow to JWT tokens
    { id: "d01", agent: "Claude Code", ownerLogin: "alice", sessionId: S_CLAUDE, ts: m(25), role: "user", kind: "message", text: "switch the login flow to short-lived JWT tokens with refresh rotation" },
    { id: "d02", agent: "Claude Code", ownerLogin: "alice", sessionId: S_CLAUDE, ts: m(24.5), role: "assistant", kind: "message", text: "I'll update src/auth.ts to issue 15-minute access JWTs and rotate refresh tokens in src/session.ts." },
    { id: "d03", agent: "Claude Code", ownerLogin: "alice", sessionId: S_CLAUDE, ts: m(24), role: "tool", kind: "code_edit", text: "Edit auth.ts", file: "auth.ts", path: wsFile("src", "auth.ts"), diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,4 +10,8 @@\n-export function loginWithCookie(user) {\n+export function issueJwtPair(user) {\n+  return signJwt(user, { expiresIn: '15m' });\n" },
    { id: "d04", agent: "Claude Code", ownerLogin: "alice", sessionId: S_CLAUDE, ts: m(23), role: "tool", kind: "code_edit", text: "Edit session.ts", file: "session.ts", path: wsFile("src", "session.ts"), diff: "--- a/src/session.ts\n+++ b/src/session.ts\n@@ -1,3 +1,6 @@\n+export function rotateRefreshToken(token) {\n+  return revokeAndMint(token);\n+}\n" },
    { id: "d05", agent: "Claude Code", ownerLogin: "alice", sessionId: S_CLAUDE, ts: m(22), role: "user", kind: "message", text: "continue" },
    { id: "d06", agent: "Claude Code", ownerLogin: "alice", sessionId: S_CLAUDE, ts: m(21.5), role: "tool", kind: "code_edit", text: "Edit middleware.ts", file: "middleware.ts", path: wsFile("src", "middleware.ts"), diff: "--- a/src/middleware.ts\n+++ b/src/middleware.ts\n@@ -4,2 +4,5 @@\n+export function verifyBearerJwt(req, res, next) {\n+  req.user = verifyJwt(req.headers.authorization);\n+}\n" },

    // Session 2: Codex (@alice) hardening rate limits on auth & api routes
    { id: "d07", agent: "Codex", ownerLogin: "alice", sessionId: S_CODEX, ts: m(18), role: "user", kind: "message", text: "add sliding-window rate limiting to login and token refresh endpoints" },
    { id: "d08", agent: "Codex", ownerLogin: "alice", sessionId: S_CODEX, ts: m(17.5), role: "assistant", kind: "message", text: "Applying rate limiter middleware to src/routes.ts and src/auth.ts." },
    { id: "d09", agent: "Codex", ownerLogin: "alice", sessionId: S_CODEX, ts: m(17), role: "tool", kind: "code_edit", text: "apply_patch auth.ts", file: "auth.ts", path: wsFile("src", "auth.ts"), diff: "+import { rateLimit } from './rateLimit';\n+export const authLimiter = rateLimit({ windowMs: 60000, max: 10 });\n" },
    { id: "d10", agent: "Codex", ownerLogin: "alice", sessionId: S_CODEX, ts: m(16.8), role: "tool", kind: "code_edit", text: "apply_patch routes.ts", file: "routes.ts", path: wsFile("src", "routes.ts"), diff: "+app.post('/api/token/refresh', authLimiter, rotateRefreshToken);\n" },

    // Session 3: Antigravity (@alice) updating UI auth client
    { id: "d11", agent: "Antigravity", ownerLogin: "alice", sessionId: S_ANTI, ts: m(12), role: "user", kind: "message", text: "wire automatic silent JWT refresh into the frontend API client" },
    { id: "d12", agent: "Antigravity", ownerLogin: "alice", sessionId: S_ANTI, ts: m(11.5), role: "assistant", kind: "message", text: "Updating src/client.ts and src/auth.ts types to retry 401 responses after refreshing the access token." },
    { id: "d13", agent: "Antigravity", ownerLogin: "alice", sessionId: S_ANTI, ts: m(11), role: "tool", kind: "code_edit", text: "replace_file_content client.ts", file: "client.ts", path: wsFile("src", "client.ts"), diff: "+if (res.status === 401) await refreshAccessToken();\n" },
    { id: "d14", agent: "Antigravity", ownerLogin: "alice", sessionId: S_ANTI, ts: m(10.5), role: "tool", kind: "code_edit", text: "replace_file_content auth.ts", file: "auth.ts", path: wsFile("src", "auth.ts"), diff: "+export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };\n" },
  ];
}

function buildPeerSnapshot(now = Date.now()) {
  const m = (minsAgo) => now - minsAgo * 60_000;
  return {
    login: "bob",
    chats: [
      {
        id: `chat_cursor_${S_CURSOR}`,
        agent: "Cursor",
        ownerLogin: "bob",
        sessionId: S_CURSOR,
        messages: [
          { role: "user", kind: "message", text: "add logout revocation endpoint and clear refresh token store", ts: m(20) },
          { role: "assistant", kind: "message", text: "Adding token revocation in src/auth.ts and src/session.ts.", ts: m(19.5) },
          { role: "tool", kind: "code_edit", text: "StrReplace auth.ts", file: "auth.ts", ts: m(19) },
          { role: "tool", kind: "code_edit", text: "StrReplace session.ts", file: "session.ts", ts: m(18.5) },
        ],
      },
      {
        id: `chat_copilot_${S_COPILOT}`,
        agent: "Copilot",
        ownerLogin: "bob",
        sessionId: S_COPILOT,
        messages: [
          { role: "user", kind: "message", text: "add integration tests for JWT expiry and refresh rotation", ts: m(8) },
          { role: "assistant", kind: "message", text: "Creating tests/auth.test.ts and exporting verify helpers from src/auth.ts.", ts: m(7.5) },
          { role: "tool", kind: "code_edit", text: "replace_string_in_file auth.ts", file: "auth.ts", ts: m(7) },
          { role: "tool", kind: "code_edit", text: "create_file auth.test.ts", file: "auth.test.ts", ts: m(6.5) },
        ],
      },
    ],
    edits: [
      { id: "e_bob01", agent: "Cursor", ownerLogin: "bob", file: "src/auth.ts", ts: m(19), diff: "+export async function revokeSession(jti: string) { await denylist.add(jti); }\n" },
      { id: "e_bob02", agent: "Cursor", ownerLogin: "bob", file: "src/session.ts", ts: m(18.5), diff: "+export const denylist = new Set<string>();\n" },
      { id: "e_bob03", agent: "Copilot", ownerLogin: "bob", file: "src/auth.ts", ts: m(7), diff: "+export { verifyJwt } from './jwt';\n" },
      { id: "e_bob04", agent: "Copilot", ownerLogin: "bob", file: "tests/auth.test.ts", ts: m(6.5), diff: "+test('rotates refresh token and rejects replay', async () => {});\n" },
    ],
  };
}

async function main() {
  const targetId = process.argv[2] || loadRegistry().projects?.[0]?.id || "proj_demo";
  const info = falkor.init({ get() {}, post() {} }, {});
  if (!info.enabled) {
    console.error("FalkorDB is not enabled. Run `relay graph enable` or set RELAY_FALKOR_URL first.");
    process.exit(1);
  }
  const { client } = falkor.state;
  const now = Date.now();
  await schema.ensure(client, targetId);

  const localProj = projectHistory(buildDemoHistory(now), { workspacePath: WS, storeText: true });
  for (const i of localProj.intents.values()) intents.remember(i);
  await writeProjection(client, targetId, localProj);

  const peerProj = projectPeer(buildPeerSnapshot(now), { login: "bob", trustRowOwners: false, storeText: true });
  for (const i of peerProj.intents.values()) intents.remember(i);
  await writeProjection(client, targetId, peerProj);

  // Record a realistic lock contention + active hold
  coord.configure(falkor);
  coord.recordHeld(targetId, `Claude Code:ALICE-DESK:${S_CLAUDE}`, "src/auth.ts", now - 2 * 60_000);
  coord.recordContention(targetId, {
    kind: "claim_blocked",
    file: "src/auth.ts",
    wanter: `Cursor:BOB-LAPTOP:${S_CURSOR}`,
    holder: `Claude Code:ALICE-DESK:${S_CLAUDE}`,
    reason: `File \`src/auth.ts\` is locked by Claude Code. They're working on: "switch the login flow to short-lived JWT tokens with refresh rotation" (2 min ago).`,
    ts: now - 20 * 60_000,
    holderIntentText: "switch the login flow to short-lived JWT tokens with refresh rotation",
  });
  await coord.flushAll();

  // Record architectural decisions & tasks
  central.configure(falkor);
  const decisions = [
    central.toRow({
      event_id: 101,
      kind: "decision",
      decision_id: "jwt-refresh-rotation",
      content: "Use 15-minute stateless JWT access tokens paired with single-use rotating refresh tokens in src/auth.ts and src/session.ts.",
      status: "accepted",
      user: "alice",
      agent_label: "Claude Code",
      files: ["src/auth.ts", "src/session.ts", "src/middleware.ts"],
      ts: new Date(now - 21 * 60_000).toISOString(),
    }),
    central.toRow({
      event_id: 102,
      kind: "decision",
      decision_id: "auth-rate-limit",
      content: "Enforce 10 req/min sliding-window rate limit on /api/token/refresh and login routes.",
      status: "accepted",
      user: "alice",
      agent_label: "Codex",
      files: ["src/auth.ts", "src/routes.ts"],
      ts: new Date(now - 16 * 60_000).toISOString(),
    }),
  ].filter(Boolean);
  await central.writeRows(targetId, decisions);

  const summary = await analytics.run(targetId, { full: true });
  console.log(`Seeded FalkorDB demo graph for project "${targetId}":`, JSON.stringify(summary));
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
