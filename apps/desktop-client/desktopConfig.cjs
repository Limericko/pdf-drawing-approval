const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const settingsFileName = "settings.json";

function normalizeServerUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("INVALID_SERVER_URL");

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("INVALID_SERVER_URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("INVALID_SERVER_URL");
  }

  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function settingsPath(userDataDir) {
  return path.join(userDataDir, settingsFileName);
}

function readSettings(userDataDir) {
  try {
    const parsed = readRawSettings(userDataDir);
    return {
      serverUrl: typeof parsed.serverUrl === "string" ? normalizeServerUrl(parsed.serverUrl) : null
    };
  } catch {
    return { serverUrl: null };
  }
}

function writeSettings(userDataDir, settings) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const current = readRawSettings(userDataDir);
  const normalized = {
    ...current,
    serverUrl: settings.serverUrl ? normalizeServerUrl(settings.serverUrl) : null
  };
  fs.writeFileSync(settingsPath(userDataDir), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return { serverUrl: normalized.serverUrl };
}

function readPrintSettings(userDataDir) {
  const parsed = readRawSettings(userDataDir);
  return isPlainObject(parsed.printSettings) ? parsed.printSettings : null;
}

function writePrintSettings(userDataDir, printSettings) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const current = readRawSettings(userDataDir);
  const normalized = {
    ...current,
    printSettings: isPlainObject(printSettings) ? printSettings : {}
  };
  fs.writeFileSync(settingsPath(userDataDir), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized.printSettings;
}

function readRawSettings(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(userDataDir), "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveClientFile(distDir, requestUrl) {
  const root = path.resolve(distDir);
  const indexFile = path.join(root, "index.html");
  const url = new URL(requestUrl, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || requestUrl.startsWith("/#")) return indexFile;

  const relativePath = pathname.replace(/^\/+/, "");
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return indexFile;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return indexFile;
  return candidate;
}

function contentTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2"
    }[extension] ?? "application/octet-stream"
  );
}

function createClientStaticServer(distDir) {
  const server = http.createServer((req, res) => {
    const filePath = resolveClientFile(distDir, req.url ?? "/");
    res.setHeader("Content-Type", contentTypeForPath(filePath));
    fs.createReadStream(filePath)
      .on("error", () => {
        res.statusCode = 500;
        res.end("Failed to read client asset");
      })
      .pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("INVALID_STATIC_SERVER_ADDRESS"));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

module.exports = {
  normalizeServerUrl,
  readSettings,
  writeSettings,
  readPrintSettings,
  writePrintSettings,
  resolveClientFile,
  contentTypeForPath,
  createClientStaticServer
};
