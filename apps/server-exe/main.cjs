const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, shell, Tray } = require("electron");
const {
  defaultPort,
  getConfigPath,
  loadRuntimeConfig,
  resolveEffectivePort,
  saveRuntimeConfig
} = require("./serverRuntimeConfig.cjs");
const { renderConsoleHtml } = require("./serverConsoleView.cjs");
const { createLanUrl } = require("./lanAddress.cjs");

const serviceName = "PDF 图纸审批服务端";

let mainWindow = null;
let tray = null;
let server = null;
let runtime = null;
let isQuitting = false;
let hasShownHideNotice = false;
let status = {
  state: "starting",
  message: "服务正在启动...",
  effectivePort: defaultPort,
  savedPort: defaultPort,
  envPort: "",
  localUrl: "",
  lanUrl: "",
  dataDir: "",
  backupDir: "",
  logDir: "",
  releaseDir: "",
  configPath: "",
  lastConfigMessage: ""
};

app.setName(serviceName);

app.whenReady().then(async () => {
  runtime = createRuntimePaths();
  status = {
    ...status,
    ...loadStatusSettings(runtime)
  };
  registerIpcHandlers();
  createWindow();
  createTray();

  try {
    await startServer();
  } catch (error) {
    status = {
      ...status,
      state: "error",
      message: error instanceof Error ? error.message : "服务启动失败"
    };
    appendLog("error", status.message);
    refreshWindow();
  }
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  isQuitting = true;
  if (server) {
    server.close();
    server = null;
  }
});

async function startServer() {
  const paths = runtime ?? createRuntimePaths();

  for (const dir of [paths.dataDir, paths.backupDir, paths.logDir, paths.releaseDir, path.join(paths.releaseDir, "updates"), path.join(paths.releaseDir, "installers", "client"), path.join(paths.releaseDir, "installers", "server")]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const runtimeConfig = loadRuntimeConfig(paths.packageRoot);
  const effectivePort = resolveEffectivePort(runtimeConfig, process.env);
  process.env.PORT = String(effectivePort);
  process.env.PDF_APPROVAL_DATA_DIR = process.env.PDF_APPROVAL_DATA_DIR || paths.dataDir;
  process.env.PDF_APPROVAL_DB = process.env.PDF_APPROVAL_DB || path.join(paths.dataDir, "pdf-approval.sqlite");
  process.env.PDF_APPROVAL_RELEASE_DIR = process.env.PDF_APPROVAL_RELEASE_DIR || paths.releaseDir;
  process.chdir(paths.appRoot);
  installConsoleFileLogs(paths.logDir);

  status = {
    ...status,
    ...loadStatusSettings(paths),
    state: "starting",
    message: `正在监听端口 ${effectivePort}...`,
    localUrl: `http://127.0.0.1:${effectivePort}`,
    lanUrl: createLanUrl(String(effectivePort))
  };
  refreshWindow();

  const serverModule = require(path.join(paths.appRoot, "server", "index.js"));
  server = serverModule.startPdfApprovalServer({
    backupRoot: paths.backupDir,
    logRoot: paths.logDir,
    onError: (error) => {
      console.error("PDF approval server failed to start.", error);
      server = null;
      status = {
        ...status,
        state: "error",
        message: formatStartupError(error)
      };
      refreshWindow();
    },
    restart: relaunchApp,
    onListening: ({ port }) => {
      status = {
        ...status,
        state: "running",
        message: `服务已启动，端口 ${port}`,
        effectivePort: port,
        localUrl: `http://127.0.0.1:${port}`,
        lanUrl: createLanUrl(String(port))
      };
      refreshWindow();
    }
  });
}

function createWindow() {
  if (mainWindow) {
    showMainWindow();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 680,
    minHeight: 460,
    title: serviceName,
    icon: getAppIconPath("pdf-approval-server.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideMainWindow();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isHttpUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  refreshWindow();
}

function refreshWindow() {
  refreshTrayMenu();
  if (!mainWindow) return;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderConsoleHtml(status))}`);
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayImage());
  tray.setToolTip(serviceName);
  tray.on("double-click", showMainWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`${serviceName}${status.message ? `\n${status.message}` : ""}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示服务端窗口", click: showMainWindow },
      { label: "打开本机工作台", enabled: Boolean(status.localUrl), click: () => openUrlFromTray(status.localUrl) },
      { label: "打开日志目录", click: () => openDirectoryFromTray("logs") },
      { type: "separator" },
      { label: "退出服务端", click: quitFromTray }
    ])
  );
}

function createTrayImage() {
  const image = nativeImage.createFromPath(getAppIconPath("pdf-approval-server.png"));
  if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
  const executableImage = nativeImage.createFromPath(process.execPath);
  if (!executableImage.isEmpty()) return executableImage.resize({ width: 16, height: 16 });
  return nativeImage.createEmpty();
}

function getAppIconPath(fileName) {
  const candidates = [
    path.join(__dirname, "assets", "icons", fileName),
    path.resolve(__dirname, "../../assets/icons", fileName)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function showMainWindow() {
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow() {
  if (!mainWindow) return { ok: true };
  mainWindow.hide();
  if (!hasShownHideNotice) {
    hasShownHideNotice = true;
    appendLog("log", "Server console hidden to tray. Service keeps running.");
    if (tray && typeof tray.displayBalloon === "function") {
      tray.displayBalloon({
        title: serviceName,
        content: "服务端已隐藏到系统托盘，审批服务仍在后台运行。"
      });
    }
  }
  return { ok: true };
}

function quitFromTray() {
  isQuitting = true;
  app.quit();
}

async function openDirectoryFromTray(key) {
  const paths = runtime ?? createRuntimePaths();
  const directoryMap = {
    data: paths.dataDir,
    backups: paths.backupDir,
    logs: paths.logDir,
    releases: paths.releaseDir
  };
  const target = directoryMap[key];
  if (!target) return;
  fs.mkdirSync(target, { recursive: true });
  const error = await shell.openPath(target);
  if (error) console.error(`Failed to open directory ${target}: ${error}`);
}

async function openUrlFromTray(url) {
  if (typeof url === "string" && isHttpUrl(url)) {
    await shell.openExternal(url);
  }
}

function relaunchApp() {
  appendLog("log", "Restart requested from admin console.");
  app.relaunch();
  app.exit(42);
}

function formatStartupError(error) {
  if (error && error.code === "EADDRINUSE") {
    return `端口 ${process.env.PORT || defaultPort} 已被占用，请关闭占用该端口的程序，或修改端口后重新启动。`;
  }
  return error instanceof Error ? error.message : "服务启动失败";
}

function createRuntimePaths() {
  const packageRoot = path.dirname(process.execPath);
  return {
    packageRoot,
    appRoot: path.join(process.resourcesPath, "app"),
    dataDir: path.join(packageRoot, "data"),
    backupDir: path.join(packageRoot, "backups"),
    logDir: path.join(packageRoot, "logs"),
    releaseDir: path.join(packageRoot, "releases"),
    configPath: getConfigPath(packageRoot)
  };
}

function loadStatusSettings(paths) {
  const runtimeConfig = loadRuntimeConfig(paths.packageRoot);
  const effectivePort = resolveEffectivePort(runtimeConfig, process.env);
  return {
    effectivePort,
    savedPort: runtimeConfig.port,
    envPort: process.env.PORT && String(process.env.PORT) !== String(runtimeConfig.port) ? String(process.env.PORT) : "",
    localUrl: `http://127.0.0.1:${effectivePort}`,
    lanUrl: createLanUrl(String(effectivePort)),
    dataDir: paths.dataDir,
    backupDir: paths.backupDir,
    logDir: paths.logDir,
    releaseDir: paths.releaseDir,
    configPath: paths.configPath
  };
}

function registerIpcHandlers() {
  ipcMain.handle("server-console:save-port", async (_event, input) => {
    const paths = runtime ?? createRuntimePaths();
    const config = saveRuntimeConfig(paths.packageRoot, { port: input?.port });
    status = {
      ...status,
      ...loadStatusSettings(paths),
      savedPort: config.port,
      lastConfigMessage: input?.restart ? "端口已保存，正在重启服务端..." : "端口已保存，重启服务端后生效。"
    };
    refreshWindow();
    if (input?.restart) {
      setTimeout(relaunchApp, 200);
    }
    return { ok: true, message: status.lastConfigMessage };
  });

  ipcMain.handle("server-console:open-url", async (_event, url) => {
    if (typeof url === "string" && isHttpUrl(url)) {
      await shell.openExternal(url);
    }
    return { ok: true };
  });

  ipcMain.handle("server-console:open-directory", async (_event, key) => {
    const paths = runtime ?? createRuntimePaths();
    const directoryMap = {
      data: paths.dataDir,
      backups: paths.backupDir,
      logs: paths.logDir,
      releases: paths.releaseDir
    };
    const target = directoryMap[key];
    if (target) {
      fs.mkdirSync(target, { recursive: true });
      const error = await shell.openPath(target);
      if (error) console.error(`Failed to open directory ${target}: ${error}`);
    }
    return { ok: true };
  });

  ipcMain.handle("server-console:copy-text", async (_event, text) => {
    if (typeof text === "string" && text.length <= 500) {
      clipboard.writeText(text);
    }
    return { ok: true };
  });

  ipcMain.handle("server-console:hide-window", async () => hideMainWindow());

  ipcMain.handle("server-console:restart", async () => {
    relaunchApp();
    return { ok: true };
  });
}

function installConsoleFileLogs(logDir) {
  if (console.__pdfApprovalFileLogsInstalled) return;
  console.__pdfApprovalFileLogsInstalled = true;

  const stdoutPath = path.join(logDir, "server.log");
  const stderrPath = path.join(logDir, "server.err.log");
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.log = (...args) => {
    appendLine(stdoutPath, args);
    originalLog(...args);
  };
  console.warn = (...args) => {
    appendLine(stderrPath, args);
    originalWarn(...args);
  };
  console.error = (...args) => {
    appendLine(stderrPath, args);
    originalError(...args);
  };
}

function appendLog(level, message) {
  const packageRoot = path.dirname(process.execPath);
  const logDir = path.join(packageRoot, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  appendLine(path.join(logDir, level === "error" ? "server.err.log" : "server.log"), [message]);
}

function appendLine(filePath, args) {
  const line = `[${new Date().toISOString()}] ${args.map(formatLogValue).join(" ")}\r\n`;
  fs.appendFileSync(filePath, line, "utf8");
}

function formatLogValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isHttpUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}
