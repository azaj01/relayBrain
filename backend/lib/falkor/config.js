const fs = require("fs");
const path = require("path");

function flag(value) {
  return value === "1" || value === "true" || value === "yes";
}

// ~/.relay/falkor.json, written by `relay graph enable`. Resolved per call so tests and
// isolated runs that point USERPROFILE/HOME elsewhere get their own file.
function configPath() {
  return path.join(require("os").homedir(), ".relay", "falkor.json");
}

function loadFileConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function saveFileConfig(cfg) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The URL can carry a password: keep the file private where the OS supports modes.
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function clearFileConfig() {
  try {
    fs.unlinkSync(configPath());
    return true;
  } catch {
    return false;
  }
}

function validUrl(url) {
  return /^(falkors?|rediss?):\/\/[^\s]+$/i.test(String(url || "").trim());
}

/**
 * Env wins over the saved file, so a one-off `RELAY_FALKOR_URL=…` still works.
 * Only the real process env reads the file; tests pass their own env object.
 */
function readConfig(env = process.env, file = env === process.env ? loadFileConfig() : null) {
  const envUrl = String(env.RELAY_FALKOR_URL || "").trim();
  const url = envUrl || String(file?.url || "").trim();
  const disabled = flag(String(env.RELAY_FALKOR_DISABLED || "").toLowerCase()) || file?.disabled === true;
  const storeText = env.RELAY_FALKOR_TEXT != null ? env.RELAY_FALKOR_TEXT !== "0" : file?.storeText !== false;
  return {
    url,
    source: envUrl ? "env" : url ? "file" : null,
    enabled: Boolean(url) && !disabled,
    storeText,
    prefix: env.RELAY_FALKOR_GRAPH_PREFIX || file?.prefix || "relay_",
    writeTimeoutMs: Number(env.RELAY_FALKOR_WRITE_TIMEOUT_MS) || 5000,
    readTimeoutMs: Number(env.RELAY_FALKOR_READ_TIMEOUT_MS) || 2000,
    breakerCooldownMs: 30_000,
  };
}

module.exports = { readConfig, loadFileConfig, saveFileConfig, clearFileConfig, configPath, validUrl };
