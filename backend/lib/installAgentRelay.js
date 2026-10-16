/**
 * Patch relay-os instructions + Relay MCP into every supported agent surface.
 * Cursor · Claude Code · Codex · Copilot CLI · Antigravity
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { relayOsBlock, agentBootstrap, RELAY_OS_BEGIN, RELAY_OS_END } = require("./relayOsBlock");

function repoRoot() {
  return path.join(__dirname, "..", "..");
}

function mcpServerScript() {
  return path.join(repoRoot(), "backend", "mcp", "server.js");
}

function relayMcpEnv(workspacePath, agentLabel) {
  const env = {};
  if (workspacePath) env.RELAY_WORKSPACE_PATH = path.resolve(workspacePath);
  // The stdio server can't otherwise tell which agent is calling it.
  if (agentLabel) env.RELAY_AGENT_LABEL = agentLabel;
  return env;
}

function relayStdioMcp(workspacePath, agentLabel) {
  const script = mcpServerScript();
  return {
    command: process.execPath,
    args: [script],
    env: relayMcpEnv(workspacePath, agentLabel),
  };
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function patchRelayOsBlock(filePath, block) {
  const existing = readText(filePath);
  const begin = existing.indexOf(RELAY_OS_BEGIN);
  const end = existing.indexOf(RELAY_OS_END);
  if (begin >= 0 && end > begin) {
    writeText(filePath, `${existing.slice(0, begin)}${block}${existing.slice(end + RELAY_OS_END.length)}`);
    return "updated";
  }
  const trimmed = existing.trimEnd();
  const sep = trimmed ? "\n\n" : "";
  writeText(filePath, `${trimmed}${sep}${block}\n`);
  return trimmed ? "appended" : "created";
}

function mergeJsonMcp(filePath, entry, { copilotType } = {}) {
  let data = {};
  try {
    data = JSON.parse(readText(filePath) || "{}");
  } catch {
    data = {};
  }
  data.mcpServers = data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {};
  const relay = copilotType
    ? { type: "local", ...entry, tools: ["*"] }
    : { ...entry };
  data.mcpServers.relay = relay;
  writeText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function mergeClaudeMcp(settingsPath, entry) {
  let data = {};
  try {
    data = JSON.parse(readText(settingsPath) || "{}");
  } catch {
    data = {};
  }
  data.mcpServers = data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {};
  data.mcpServers.relay = entry;
  writeText(settingsPath, `${JSON.stringify(data, null, 2)}\n`);
}

function mergeCodexMcp(configPath, workspacePath) {
  const node = process.execPath.replace(/\\/g, "/");
  const script = mcpServerScript().replace(/\\/g, "/");
  const ws = path.resolve(workspacePath).replace(/\\/g, "/");
  const envLines = [`RELAY_WORKSPACE_PATH = "${ws.replace(/"/g, '\\"')}"`, `RELAY_AGENT_LABEL = "Codex"`];
  const block = `[mcp_servers.relay]
command = "${node.replace(/"/g, '\\"')}"
args = ["${script.replace(/"/g, '\\"')}"]

[mcp_servers.relay.env]
${envLines.join("\n")}
`;
  let text = readText(configPath);
  const marker = "[mcp_servers.relay]";
  const idx = text.indexOf(marker);
  if (idx >= 0) {
    // Skip our own [mcp_servers.relay.env] table, or the old one survives and TOML sees it twice.
    const next = text.slice(idx + marker.length).search(/\n\[(?!mcp_servers\.relay(\.env)?\])/);
    text = next >= 0 ? `${text.slice(0, idx)}${block}${text.slice(idx + marker.length + next)}` : `${text.slice(0, idx)}${block}`;
  } else {
    text = `${text.trimEnd()}\n\n${block}`;
  }
  writeText(configPath, text.endsWith("\n") ? text : `${text}\n`);
}

function cursorMdc(block) {
  return `---
description: Relay coordination — room context, locks, /relay ask
alwaysApply: true
---

${block}
`;
}

function ensureRelayDir(workspacePath) {
  fs.mkdirSync(path.join(workspacePath, ".relay"), { recursive: true });
  writeText(path.join(workspacePath, ".relay", "AGENT_BOOTSTRAP.md"), agentBootstrap(workspacePath));
}

function installProjectRelay(workspacePath) {
  if (!workspacePath) return { ok: false, error: "workspace_required" };
  const resolved = path.resolve(workspacePath);
  const block = relayOsBlock();
  const mcpFor = (label) => relayStdioMcp(resolved, label);
  const results = { instructions: {}, mcp: {} };

  const instructionTargets = [
    path.join(resolved, "AGENTS.md"),
    path.join(resolved, "CLAUDE.md"),
    path.join(resolved, ".github", "copilot-instructions.md"),
    path.join(resolved, ".cursorrules"),
  ];
  for (const file of instructionTargets) {
    try {
      results.instructions[path.relative(resolved, file)] = patchRelayOsBlock(file, block);
    } catch (err) {
      results.instructions[path.relative(resolved, file)] = String(err.message || err);
    }
  }

  try {
    writeText(path.join(resolved, ".cursor", "rules", "relay.mdc"), cursorMdc(block));
    results.instructions[".cursor/rules/relay.mdc"] = "created";
  } catch (err) {
    results.instructions[".cursor/rules/relay.mdc"] = String(err.message || err);
  }

  ensureRelayDir(resolved);

  try {
    mergeJsonMcp(path.join(resolved, ".cursor", "mcp.json"), mcpFor("Cursor"));
    results.mcp[".cursor/mcp.json"] = "ok";
  } catch (err) {
    results.mcp[".cursor/mcp.json"] = String(err.message || err);
  }

  try {
    mergeClaudeMcp(path.join(resolved, ".claude", "settings.json"), mcpFor("Claude Code"));
    results.mcp[".claude/settings.json"] = "ok";
  } catch (err) {
    results.mcp[".claude/settings.json"] = String(err.message || err);
  }

  try {
    mergeCodexMcp(path.join(resolved, ".codex", "config.toml"), resolved);
    results.mcp[".codex/config.toml"] = "ok";
  } catch (err) {
    results.mcp[".codex/config.toml"] = String(err.message || err);
  }

  try {
    mergeJsonMcp(path.join(resolved, ".github", "mcp.json"), mcpFor("Copilot"), { copilotType: true });
    results.mcp[".github/mcp.json"] = "ok";
  } catch (err) {
    results.mcp[".github/mcp.json"] = String(err.message || err);
  }

  try {
    mergeJsonMcp(path.join(resolved, ".agents", "mcp_config.json"), mcpFor("Antigravity"));
    results.mcp[".agents/mcp_config.json"] = "ok";
  } catch (err) {
    results.mcp[".agents/mcp_config.json"] = String(err.message || err);
  }

  return { ok: true, workspace: resolved, results };
}

function installGlobalRelay() {
  const home = os.homedir();
  const mcpFor = (label) => relayStdioMcp(null, label);
  const results = {};
  try {
    mergeJsonMcp(path.join(home, ".cursor", "mcp.json"), mcpFor("Cursor"));
    results["~/.cursor/mcp.json"] = "ok";
  } catch (err) {
    results["~/.cursor/mcp.json"] = String(err.message || err);
  }
  try {
    mergeClaudeMcp(path.join(home, ".claude", "settings.json"), mcpFor("Claude Code"));
    results["~/.claude/settings.json"] = "ok";
  } catch (err) {
    results["~/.claude/settings.json"] = String(err.message || err);
  }
  try {
    mergeCodexMcp(path.join(home, ".codex", "config.toml"), home);
    results["~/.codex/config.toml"] = "ok";
  } catch (err) {
    results["~/.codex/config.toml"] = String(err.message || err);
  }
  try {
    const copilotPath = path.join(home, ".copilot", "mcp-config.json");
    mergeJsonMcp(copilotPath, mcpFor("Copilot"), { copilotType: true });
    results["~/.copilot/mcp-config.json"] = "ok";
  } catch (err) {
    results["~/.copilot/mcp-config.json"] = String(err.message || err);
  }
  return results;
}

module.exports = {
  installProjectRelay,
  installGlobalRelay,
  relayStdioMcp,
  patchRelayOsBlock,
  relayOsBlock,
};
