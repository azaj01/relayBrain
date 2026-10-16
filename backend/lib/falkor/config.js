function flag(value) {
  return value === "1" || value === "true" || value === "yes";
}

function readConfig(env = process.env) {
  const url = String(env.RELAY_FALKOR_URL || "").trim();
  const disabled = flag(String(env.RELAY_FALKOR_DISABLED || "").toLowerCase());
  return {
    url,
    enabled: Boolean(url) && !disabled,
    storeText: env.RELAY_FALKOR_TEXT !== "0",
    prefix: env.RELAY_FALKOR_GRAPH_PREFIX || "relay_",
    writeTimeoutMs: Number(env.RELAY_FALKOR_WRITE_TIMEOUT_MS) || 5000,
    readTimeoutMs: Number(env.RELAY_FALKOR_READ_TIMEOUT_MS) || 2000,
    breakerCooldownMs: 30_000,
  };
}

module.exports = { readConfig };
