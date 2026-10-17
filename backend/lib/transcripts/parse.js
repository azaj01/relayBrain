const path = require("path");
const {
  readJsonl,
  extractText,
  isRedacted,
  clip,
  toTs,
  fileMtime,
  makeUnifiedDiff,
} = require("./util");

const { EDIT_TOOL_SETS } = require("../editMatchers");
const { sessionIdFromTranscript } = require("./sessionId");
const CURSOR_EDIT_TOOLS = EDIT_TOOL_SETS.cursor;
const CLAUDE_EDIT_TOOLS = EDIT_TOOL_SETS.claude;
const CODEX_EDIT_TOOLS = EDIT_TOOL_SETS.codex;

function userQuery(text) {
  const match = String(text || "").match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  return match ? match[1].trim() : text;
}

function userRequest(text) {
  const match = String(text || "").match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i)
    || String(text || "").match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/i);
  return match ? match[1].trim() : text;
}

function splitThinking(content) {
  const thinkingBits = [];
  const textBits = [];
  const parts = Array.isArray(content) ? content : content ? [{ type: "text", text: extractText(content) }] : [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "thinking" || part.type === "reasoning" || part.type === "thought") {
      const bit = part.thinking || part.text || part.content || "";
      if (bit) thinkingBits.push(String(bit));
      continue;
    }
    if (part.type === "text" && part.text) textBits.push(part.text);
  }
  let text = textBits.join("\n").trim();
  text = text.replace(/<(thinking|think)>[\s\S]*?<\/\1>/gi, (block, tag) => {
    thinkingBits.push(block.replace(new RegExp(`</?${tag}>`, "gi"), "").trim());
    return "";
  }).trim();
  return { text, thinking: thinkingBits.filter(Boolean).join("\n\n") };
}

function sessionIdFromFile(file) {
  return path.basename(file, ".jsonl");
}

// Claude Code replays slash commands and their output back through the user
// role (`/login`, its stdout, hook feedback). They are CLI plumbing, not
// something the human said, so they should not appear in a chat transcript.
const LOCAL_COMMAND_TAGS = /^<\/?(command-name|command-message|command-args|local-command-stdout|local-command-stderr|command-contents)>/i;

function isLocalCommandEcho(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith("<")) return false;
  return LOCAL_COMMAND_TAGS.test(trimmed);
}

function parseCursor(file) {
  const rows = readJsonl(file);
  const base = fileMtime(file);
  const sessionId = sessionIdFromFile(file);
  const events = [];
  rows.forEach((step, index) => {
    const ts = toTs(step.timestamp || step.ts, base + index * 1000);
    const role = step.role || step.message?.role;
    const content = step.message?.content;
    if (role === "user") {
      const text = userQuery(extractText(content));
      if (!isRedacted(text)) events.push({ ts, role: "user", kind: "message", text, sessionId, index });
      return;
    }
    if (role === "assistant") {
      const { text, thinking } = splitThinking(content);
      if (thinking && !isRedacted(thinking)) {
        events.push({ ts, role: "assistant", kind: "thinking", text: thinking, sessionId, index });
      }
      if (!isRedacted(text)) events.push({ ts, role: "assistant", kind: "message", text, sessionId, index });
      const tools = Array.isArray(content) ? content.filter((p) => p?.type === "tool_use") : [];
      for (const tool of tools) {
        if (!CURSOR_EDIT_TOOLS.has(tool.name)) continue;
        const input = tool.input || {};
        const filePath = input.path || input.file_path || input.target_notebook || input.target_file;
        if (!filePath) continue;
        let diff = "";
        if (input.old_string != null && input.new_string != null) {
          diff = makeUnifiedDiff(input.old_string, input.new_string, path.basename(filePath));
        } else if (input.contents != null) {
          diff = makeUnifiedDiff("", input.contents, path.basename(filePath));
        }
        events.push({
          ts,
          role: "tool",
          kind: "code_edit",
          text: `${tool.name} ${path.basename(filePath)}`,
          file: path.basename(filePath),
          path: filePath,
          diff,
          sessionId,
          index,
        });
      }
    }
  });
  return events;
}

// A Claude Code `Edit`/`Write`/`MultiEdit` tool_use carries its change in one of
// three shapes. Flatten them into one diff per touched file so the timeline does
// not silently drop MultiEdit (an `edits` array) or Write (`content`, not
// `contents` — the key the Cursor payload uses).
function claudeEditDiffs(name, input) {
  const filePath = input.file_path || input.path || input.target_file;
  if (!filePath) return [];
  const label = path.basename(filePath);
  if (Array.isArray(input.edits) && input.edits.length) {
    const diff = input.edits
      .map((edit) => makeUnifiedDiff(edit.old_string ?? "", edit.new_string ?? "", label))
      .join("\n");
    return [{ filePath, label, diff }];
  }
  if (input.old_string != null || input.new_string != null) {
    return [{ filePath, label, diff: makeUnifiedDiff(input.old_string ?? "", input.new_string ?? "", label) }];
  }
  const written = input.content ?? input.contents;
  if (written != null) {
    return [{ filePath, label, diff: makeUnifiedDiff("", written, label) }];
  }
  return [{ filePath, label, diff: "" }];
}

// Claude Code writes one JSONL row per transcript entry, but only `user` and
// `assistant` rows are conversation. The rest (`attachment`, `system`, `mode`,
// `file-history-snapshot`, `ai-title`, …) are UI bookkeeping, and `isMeta` user
// rows are the local-command caveat the CLI injects — none of it belongs in a
// chat view. Tool output also arrives as a `user` row whose content is a
// `tool_result` block; without the filter below it renders as if the human
// typed the contents of stdout.
function parseClaude(file) {
  const rows = readJsonl(file);
  const fallbackSession = sessionIdFromFile(file);
  const events = [];
  rows.forEach((step, index) => {
    if (step.type !== "user" && step.type !== "assistant") return;
    if (step.isMeta) return;
    const sessionId = step.sessionId || fallbackSession;
    const ts = toTs(step.timestamp, fileMtime(file) + index * 1000);
    const content = step.message?.content;
    const parts = Array.isArray(content) ? content : [];

    if (step.type === "user") {
      if (parts.some((part) => part?.type === "tool_result")) return;
      const text = extractText(content);
      if (isLocalCommandEcho(text)) return;
      if (!isRedacted(text)) events.push({ ts, role: "user", kind: "message", text, sessionId, index });
      return;
    }

    const { text, thinking } = splitThinking(content);
    if (thinking && !isRedacted(thinking)) {
      events.push({ ts, role: "assistant", kind: "thinking", text: thinking, sessionId, index });
    }
    if (!isRedacted(text)) events.push({ ts, role: "assistant", kind: "message", text, sessionId, index });
    for (const part of parts) {
      if (!part || part.type !== "tool_use" || !CLAUDE_EDIT_TOOLS.has(part.name)) continue;
      for (const edit of claudeEditDiffs(part.name, part.input || {})) {
        events.push({
          ts,
          role: "tool",
          kind: "code_edit",
          text: `${part.name} ${edit.label}`,
          file: edit.label,
          path: edit.filePath,
          diff: edit.diff,
          sessionId,
          index,
        });
      }
    }
  });
  return events;
}

function parseCodex(file) {
  const rows = readJsonl(file);
  // Hooks send the thread id as session_id; the rollout filename only ends with it.
  const meta = rows.find((r) => r?.type === "session_meta")?.payload?.id;
  const sessionId = typeof meta === "string" && meta ? meta : sessionIdFromTranscript("Codex", file);
  const events = [];
  rows.forEach((step, index) => {
    const ts = toTs(step.timestamp, fileMtime(file) + index * 1000);
    if (step.type === "event_msg") {
      const p = step.payload || {};
      if (p.type === "user_message" && !isRedacted(p.message)) {
        events.push({ ts, role: "user", kind: "message", text: p.message, sessionId, index });
      } else if (p.type === "agent_message" && !isRedacted(p.message)) {
        events.push({ ts, role: "assistant", kind: "message", text: p.message, sessionId, index });
      }
      return;
    }
    if (step.type === "response_item" && step.payload?.type === "function_call") {
      const name = step.payload.name || "";
      if (!CODEX_EDIT_TOOLS.has(name)) return;
      let args = {};
      try {
        args = JSON.parse(step.payload.arguments || "{}");
      } catch {
        args = {};
      }
      const filePath = args.path || args.file_path || args.file || null;
      events.push({
        ts,
        role: "tool",
        kind: "code_edit",
        text: `${name}${filePath ? ` ${path.basename(filePath)}` : ""}`,
        file: filePath ? path.basename(filePath) : null,
        path: filePath,
        diff: typeof args.patch === "string" ? args.patch : "",
        sessionId,
        index,
      });
    }
  });
  return events;
}

// VS Code chatSessions .jsonl is a patch log: kind 0 = initial state, kind 1 = set the value
// at path k, kind 2 = append v's items to the array at path k. New requests (with their
// timestamp and message) and response parts arrive as kind 2, so it must not be skipped.
function foldChatSessionPatches(rows) {
  let state = null;
  for (const step of rows) {
    if (step.kind === 0) {
      state = step.v;
      continue;
    }
    if (!state || (step.kind !== 1 && step.kind !== 2) || !Array.isArray(step.k) || !step.k.length) continue;
    let current = state;
    for (let i = 0; i < step.k.length - 1; i += 1) {
      const key = step.k[i];
      if (current[key] === undefined || current[key] === null) current[key] = typeof step.k[i + 1] === "number" ? [] : {};
      current = current[key];
    }
    const last = step.k[step.k.length - 1];
    if (step.kind === 1) {
      current[last] = step.v;
      continue;
    }
    if (!Array.isArray(current[last])) current[last] = [];
    if (Array.isArray(step.v)) current[last].push(...step.v);
    else if (step.v !== undefined) current[last].push(step.v);
  }
  return state;
}

function parseCopilot(file) {
  const rows = readJsonl(file);
  if (!rows.length) return [];
  if (rows[0].kind === 0) {
    const state = foldChatSessionPatches(rows);
    if (!state) return [];
    const sessionId = state.sessionId || sessionIdFromFile(file);
    const start = toTs(state.creationDate, fileMtime(file));
    // VS Code also writes GitHub.copilot-chat/transcripts/<same id>.jsonl, with real timestamps
    // and tool calls, but it only starts partway through the session. This file then only
    // contributes what came before it, or every prompt would appear twice.
    const transcriptStart = copilotTranscriptStart(file);
    const events = [];
    (state.requests || []).forEach((request, index) => {
      const rendered = request?.result?.metadata?.renderedUserMessage;
      const text =
        String(request?.message?.text || "").trim() ||
        userRequest(extractText(rendered)) ||
        (index === 0 ? String(state.customTitle || "").trim() : "");
      // Requests carry their own time; creationDate + index is only a last resort.
      const ts = toTs(request?.timestamp, start + index * 1000);
      if (!isRedacted(text)) events.push({ ts, role: "user", kind: "message", text, sessionId, index });
      const assistant = extractText(request?.response || request?.result?.message);
      if (!isRedacted(assistant)) {
        events.push({ ts: toTs(request?.responseTimestamp, ts + 1), role: "assistant", kind: "message", text: assistant, sessionId, index });
      }
    });
    return transcriptStart ? events.filter((e) => e.ts < transcriptStart) : events;
  }
  const started = rows.find((r) => r?.type === "session.start")?.data?.sessionId;
  const sessionId = typeof started === "string" && started ? started : sessionIdFromFile(file);
  const events = [];
  rows.forEach((step, index) => {
    const ts = toTs(step.timestamp, fileMtime(file) + index * 1000);
    if (step.type === "user.message" && step.data?.content) {
      const text = extractText(step.data.content);
      // Copilot files terminal callbacks as user messages; nobody typed them.
      if (!isRedacted(text) && !COPILOT_INJECTED.test(text)) events.push({ ts, role: "user", kind: "message", text, sessionId, index });
    } else if (step.type === "assistant.message" && step.data?.content) {
      const text = extractText(step.data.content);
      if (!isRedacted(text)) events.push({ ts, role: "assistant", kind: "message", text, sessionId, index });
    } else if (step.type === "tool.execution_start" && COPILOT_EDIT_TOOLS.has(step.data?.toolName)) {
      for (const edit of copilotEditDiffs(step.data.toolName, toolArgs(step.data.arguments))) {
        events.push({
          ts,
          role: "tool",
          kind: "code_edit",
          text: `${step.data.toolName} ${path.basename(edit.filePath)}`,
          file: path.basename(edit.filePath),
          path: edit.filePath,
          diff: edit.diff,
          sessionId,
          index,
        });
      }
    }
  });
  return events;
}

const COPILOT_INJECTED = /^\s*\[Terminal [0-9a-f-]+ notification:/i;

/** Start time of the transcript twin of a chatSessions file, or null when there is none. */
function copilotTranscriptStart(chatSessionFile) {
  const twin = path.join(path.dirname(path.dirname(chatSessionFile)), "GitHub.copilot-chat", "transcripts", `${sessionIdFromFile(chatSessionFile)}.jsonl`);
  const first = readJsonl(twin).find((r) => r?.type === "session.start");
  if (!first) return null;
  return toTs(first.data?.startTime || first.timestamp, null) || null;
}

// Copilot agent edit tools as named in GitHub.copilot-chat transcripts (VS Code), plus
// the CLI's edit/create. Reads (read_file, grep_search, …) are deliberately absent.
const COPILOT_EDIT_TOOLS = new Set([
  "create_file",
  "replace_string_in_file",
  "multi_replace_string_in_file",
  "insert_edit_into_file",
  "apply_patch",
  "edit_file",
  "edit",
  "create",
]);

function toolArgs(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}

/**
 * Splits an apply_patch payload ("*** Begin Patch / *** Update File: <path> / … / *** End Patch")
 * into one section per file. Shared by Copilot and Codex, which use the same format.
 */
function patchSections(input) {
  const sections = [];
  let current = null;
  for (const line of String(input || "").split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/);
    if (header) {
      current = { op: header[1].toLowerCase(), filePath: header[2], lines: [] };
      sections.push(current);
      continue;
    }
    if (/^\*\*\* (Begin|End) Patch/.test(line) || /^\*\*\* End of File/.test(line)) continue;
    if (current && !/^\*\*\* Move to:/.test(line)) current.lines.push(line);
  }
  return sections.map((s) => ({ op: s.op, filePath: s.filePath, diff: s.lines.join("\n") }));
}

function copilotEditDiffs(name, args) {
  if (name === "apply_patch") return patchSections(args.input || args.patch || "").map(({ filePath, diff }) => ({ filePath, diff }));
  if (name === "multi_replace_string_in_file") {
    const byFile = new Map();
    for (const r of Array.isArray(args.replacements) ? args.replacements : []) {
      const filePath = r?.filePath || r?.path;
      if (!filePath) continue;
      const diff = makeUnifiedDiff(r.oldString ?? "", r.newString ?? "", path.basename(filePath));
      byFile.set(filePath, byFile.has(filePath) ? `${byFile.get(filePath)}\n${diff}` : diff);
    }
    return [...byFile].map(([filePath, diff]) => ({ filePath, diff }));
  }
  const filePath = args.filePath || args.path || args.file_path;
  if (!filePath) return [];
  const label = path.basename(filePath);
  if (args.oldString != null || args.newString != null || args.old_string != null || args.new_string != null) {
    return [{ filePath, diff: makeUnifiedDiff(args.oldString ?? args.old_string ?? "", args.newString ?? args.new_string ?? "", label) }];
  }
  const written = args.content ?? args.code ?? args.file_text;
  return [{ filePath, diff: written != null ? makeUnifiedDiff("", written, label) : "" }];
}

const ANTIGRAVITY_EDIT_TOOLS = EDIT_TOOL_SETS.antigravity;

// Antigravity quotes every tool argument, so `args.TargetFile` arrives as the
// literal string `"c:\\Users\\me\\app.ts"` — surrounding quotes included.
function antigravityArg(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^"(.*)"$/s, "$1");
  return trimmed || null;
}

// A CODE_ACTION names the file it touched in one of two shapes:
//   Created file file:///c:/Users/me%20x/app.ts with requested content.
//   The following changes were made by the write_to_file tool to: c:\Users\me\app.ts.
function antigravityEditPath(content) {
  const text = String(content || "");
  const url = text.match(/file:\/\/\/[^\s\n`"']+/);
  if (url) {
    try {
      return decodeURIComponent(url[0].replace(/^file:\/+/, "")).replace(/\//g, path.sep);
    } catch {
      return url[0];
    }
  }
  const named = text.match(/\btool to:\s*(.+?)\.\s*(?:If relevant|[\r\n]|$)/);
  if (named) return named[1].trim();
  return null;
}

function antigravityDiff(content) {
  const match = String(content || "").match(/\[diff_block_start\]\r?\n([\s\S]*?)\r?\n\[diff_block_end\]/);
  return match ? match[1] : "";
}

function antigravitySummary(content) {
  // The first two lines are always `Created At:` / `Completed At:` bookkeeping.
  const lines = String(content || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(Created|Completed) At:/.test(line));
  return (lines[0] || "code action").slice(0, 240);
}

function parseAntigravity(file) {
  const rows = readJsonl(file);
  const sessionId = sessionIdFromTranscript("Antigravity", file) || sessionIdFromFile(file);
  const events = [];
  // CODE_ACTION carries the diff but sometimes not a resolvable path; the
  // PLANNER_RESPONSE that requested it always carries `TargetFile`. Remembering
  // the last requested target lets the two halves be stitched back together.
  let pendingTarget = null;
  rows.forEach((step, index) => {
    const ts = toTs(step.created_at || step.timestamp, fileMtime(file) + index * 1000);
    if (step.type === "USER_INPUT" && step.content) {
      const text = userRequest(step.content);
      if (!isRedacted(text)) events.push({ ts, role: "user", kind: "message", text, sessionId, index });
      return;
    }
    if (step.type === "PLANNER_RESPONSE") {
      if (step.thinking && !isRedacted(step.thinking)) {
        events.push({ ts, role: "assistant", kind: "thinking", text: String(step.thinking), sessionId, index });
      }
      if (step.content && !isRedacted(step.content)) {
        events.push({ ts, role: "assistant", kind: "message", text: String(step.content), sessionId, index });
      }
      for (const call of step.tool_calls || []) {
        if (!ANTIGRAVITY_EDIT_TOOLS.has(call?.name)) continue;
        const target = antigravityArg(call.args?.TargetFile);
        if (target) pendingTarget = target;
      }
      return;
    }
    if (step.type === "CODE_ACTION") {
      const filePath = antigravityEditPath(step.content) || pendingTarget;
      pendingTarget = null;
      events.push({
        ts,
        role: "tool",
        kind: "code_edit",
        text: antigravitySummary(step.content),
        file: filePath ? path.basename(filePath) : null,
        path: filePath,
        diff: antigravityDiff(step.content),
        sessionId,
        index,
      });
    }
    // VIEW_FILE / LIST_DIRECTORY / EPHEMERAL_MESSAGE are reads and status
    // chatter. Filing them as code_edit is what put files the agent merely
    // looked at into the Code Edits panel.
  });
  return events;
}

function parseFile(agent, file) {
  let events = [];
  if (agent === "Cursor") events = parseCursor(file);
  else if (agent === "Claude Code") events = parseClaude(file);
  else if (agent === "Codex") events = parseCodex(file);
  else if (agent === "Copilot") events = parseCopilot(file);
  else if (agent === "Antigravity") events = parseAntigravity(file);
  return events.map((event) => ({
    ...event,
    text: clip(event.text),
    diff: event.diff ? clip(event.diff, 4000) : event.diff,
    transcriptPath: file,
  }));
}

module.exports = { parseFile, patchSections };
