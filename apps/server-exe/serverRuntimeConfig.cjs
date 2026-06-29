const fs = require("node:fs");
const path = require("node:path");

const defaultPort = 8080;
const configFileName = "server-config.json";

function getConfigPath(packageRoot) {
  return path.join(packageRoot, configFileName);
}

function loadRuntimeConfig(packageRoot) {
  const configPath = getConfigPath(packageRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return { port: normalizePort(parsed.port) ?? defaultPort };
  } catch {
    return { port: defaultPort };
  }
}

function saveRuntimeConfig(packageRoot, input) {
  const port = normalizePort(input?.port);
  if (!port) {
    const error = new Error("INVALID_PORT");
    error.code = "INVALID_PORT";
    throw error;
  }

  const config = { port };
  fs.writeFileSync(getConfigPath(packageRoot), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

function resolveEffectivePort(config, env = process.env) {
  return normalizePort(env.PORT) ?? normalizePort(config?.port) ?? defaultPort;
}

function normalizePort(value) {
  if (typeof value === "string" && value.trim() === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

module.exports = {
  defaultPort,
  getConfigPath,
  loadRuntimeConfig,
  normalizePort,
  resolveEffectivePort,
  saveRuntimeConfig
};
