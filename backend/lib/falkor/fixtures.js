// Synthetic events shaped like real unifyEvent output (no user data).
const WS = "C:\\Users\\dev\\demo";
const CLAUDE_SID = "52b29a54-d8fb-4091-ab60-463ac73c9d6c";
const CURSOR_SID = "3e62675d-9b0f-4d99-b17d-c1d875fe98dc";

let n = 0;
function ev(fields) {
  n += 1;
  return {
    id: `ev${String(n).padStart(4, "0")}`,
    ownerLogin: "alice",
    role: "assistant",
    kind: "message",
    text: "",
    file: null,
    path: null,
    diff: "",
    ...fields,
  };
}

function demoHistory() {
  n = 0;
  return [
    ev({ agent: "Claude Code", sessionId: CLAUDE_SID, ts: 1000, role: "user", text: "switch the login flow to JWT tokens" }),
    ev({ agent: "Cursor", sessionId: CURSOR_SID, ts: 1500.685, role: "user", text: "make the navbar sticky" }),
    ev({ agent: "Claude Code", sessionId: CLAUDE_SID, ts: 2000, role: "assistant", kind: "thinking", text: "hmm, issuer first" }),
    ev({ agent: "Claude Code", sessionId: CLAUDE_SID, ts: 2100, role: "assistant", text: "I'll update the token issuer first." }),
    ev({
      agent: "Claude Code",
      sessionId: CLAUDE_SID,
      ts: 3000,
      role: "tool",
      kind: "code_edit",
      text: "Edit auth.ts",
      file: "auth.ts",
      path: "C:/Users/dev/demo/src/Auth.ts",
      diff: "--- a/auth.ts\n+++ b/auth.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+newer\n",
    }),
    ev({
      agent: "Cursor",
      sessionId: CURSOR_SID,
      ts: 3500.685,
      role: "tool",
      kind: "code_edit",
      text: "Write navbar.css",
      file: "navbar.css",
      path: "C:\\Users\\dev\\demo\\styles\\navbar.css",
      diff: "+.nav{position:sticky}\n",
    }),
    ev({ agent: "Claude Code", sessionId: CLAUDE_SID, ts: 4000, role: "user", text: "also add refresh tokens, api_key=supersecretvalue123" }),
    ev({
      agent: "Claude Code",
      sessionId: CLAUDE_SID,
      ts: 5000,
      role: "tool",
      kind: "code_edit",
      text: "Edit auth.ts",
      file: "auth.ts",
      path: "C:\\Users\\dev\\demo\\src\\auth.ts",
      diff: "+refresh\n",
    }),
    ev({
      agent: "Claude Code",
      sessionId: CLAUDE_SID,
      ts: 5100,
      role: "tool",
      kind: "code_edit",
      text: "Write notes.md",
      file: "notes.md",
      path: "C:\\Users\\dev\\other-repo\\notes.md",
      diff: "+x\n",
    }),
    ev({ agent: "Antigravity", sessionId: "session", ts: 6000, role: "user", text: "what files do you see" }),
    ev({ agent: "Codex", sessionId: "codex-1", ts: 7000, role: "tool", kind: "code_edit", text: "apply_patch", file: null, path: null, diff: "" }),
  ];
}

module.exports = { demoHistory, WS, CLAUDE_SID, CURSOR_SID };
