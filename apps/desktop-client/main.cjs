const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const {
  createClientStaticServer,
  readPrintSettings,
  readSettings,
  writePrintSettings,
  writeSettings
} = require("./desktopConfig.cjs");

let mainWindow = null;
let staticServer = null;
let updateCheckRunning = false;
let updateState = { status: "idle" };
let downloadedUpdateFile = null;

function getUserDataDir() {
  return app.getPath("userData");
}

function getClientDistDir() {
  const candidates = [
    path.resolve(__dirname, "../../dist/client"),
    path.join(process.resourcesPath ?? "", "client"),
    path.join(app.getAppPath(), "dist/client")
  ];
  const found = candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "index.html")));
  if (!found) {
    throw new Error(`找不到已构建的前端文件，请先执行 npm run build。检查路径：${candidates.join(" | ")}`);
  }
  return found;
}

function getAppIconPath() {
  const candidates = [
    path.join(__dirname, "assets", "icons", "pdf-approval-client.png"),
    path.resolve(__dirname, "../../assets/icons/pdf-approval-client.png")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function registerIpcHandlers() {
  ipcMain.handle("desktop:get-server-url", () => readSettings(getUserDataDir()).serverUrl);
  ipcMain.handle("desktop:set-server-url", (_event, serverUrl) => {
    const nextServerUrl = writeSettings(getUserDataDir(), { serverUrl }).serverUrl;
    scheduleUpdateCheckIfConfigured(600);
    return nextServerUrl;
  });
  ipcMain.handle("desktop:clear-server-url", () => writeSettings(getUserDataDir(), { serverUrl: null }).serverUrl);
  ipcMain.handle("desktop:get-app-version", () => app.getVersion());
  ipcMain.handle("desktop:list-printers", async () => {
    const printers = await mainWindow?.webContents.getPrintersAsync();
    return (printers ?? []).map((printer) => ({
      name: printer.name,
      displayName: printer.displayName || printer.name,
      description: printer.description || "",
      isDefault: isDefaultPrinter(printer)
    }));
  });
  ipcMain.handle("desktop:get-print-settings", () => readPrintSettings(getUserDataDir()));
  ipcMain.handle("desktop:set-print-settings", (_event, printSettings) => writePrintSettings(getUserDataDir(), printSettings));
  ipcMain.handle("desktop:print-signed-pdf", (_event, signedPdfUrl, printOptions) => printSignedPdf(signedPdfUrl, printOptions));
  ipcMain.handle("desktop:get-update-status", () => updateState);
  ipcMain.handle("desktop:check-for-updates", () => checkForUpdates());
  ipcMain.handle("desktop:open-downloaded-update-installer", () => openDownloadedUpdateInstaller());
}

function registerUpdateHandlers() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = false;
  autoUpdater.logger = {
    info: (message) => console.log(`[updater] ${message}`),
    warn: (message) => console.warn(`[updater] ${message}`),
    error: (message) => console.error(`[updater] ${message}`)
  };

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({ status: "checking", message: "正在检查客户端更新..." });
  });

  autoUpdater.on("update-not-available", (info) => {
    setUpdateState({ status: "not_available", latestVersion: info?.version ?? null, message: "当前已是最新客户端。" });
  });

  autoUpdater.on("update-available", (info) => {
    downloadedUpdateFile = null;
    setUpdateState({
      status: "downloading",
      latestVersion: info?.version ?? null,
      releaseDate: info?.releaseDate ?? null,
      releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      message: "发现新版本，正在下载客户端安装包..."
    });
    autoUpdater.downloadUpdate().catch((error) => {
      setUpdateState({ status: "error", message: errorMessage(error) });
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setUpdateState({
      status: "downloading",
      percent: Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0,
      transferred: progress?.transferred ?? 0,
      total: progress?.total ?? 0,
      bytesPerSecond: progress?.bytesPerSecond ?? 0,
      message: "正在下载客户端安装包..."
    });
  });

  autoUpdater.on("update-downloaded", (event) => {
    downloadedUpdateFile = event?.downloadedFile ?? null;
    setUpdateState({
      status: "downloaded",
      latestVersion: event?.version ?? updateState.latestVersion ?? null,
      releaseDate: event?.releaseDate ?? updateState.releaseDate ?? null,
      releaseNotes: normalizeReleaseNotes(event?.releaseNotes) ?? updateState.releaseNotes ?? [],
      downloadedFile: downloadedUpdateFile,
      percent: 100,
      message: "客户端安装包已下载完成。"
    });
  });

  autoUpdater.on("error", (error) => {
    setUpdateState({ status: "error", message: errorMessage(error) });
  });
}

async function checkForUpdates() {
  if (updateCheckRunning) return updateState;
  const serverUrl = readSettings(getUserDataDir()).serverUrl;
  if (!serverUrl) {
    setUpdateState({ status: "config_missing", message: "尚未配置审批服务器地址，暂时无法检查客户端更新。" });
    return updateState;
  }

  updateCheckRunning = true;
  try {
    downloadedUpdateFile = null;
    autoUpdater.setFeedURL({ provider: "generic", url: `${serverUrl.replace(/\/+$/, "")}/updates/` });
    const result = await autoUpdater.checkForUpdates();
    if (!result && updateState.status === "checking") {
      setUpdateState({ status: "not_available", message: "当前客户端未检测到可用更新。" });
    }
    return updateState;
  } catch (error) {
    setUpdateState({ status: "error", message: errorMessage(error) });
    return updateState;
  } finally {
    updateCheckRunning = false;
  }
}

async function openDownloadedUpdateInstaller() {
  if (!downloadedUpdateFile || !fs.existsSync(downloadedUpdateFile)) {
    return { success: false, error: "UPDATE_INSTALLER_NOT_READY" };
  }

  const result = await shell.openPath(downloadedUpdateFile);
  if (result) {
    return { success: false, error: result };
  }
  setUpdateState({ ...updateState, status: "installer_opened", downloadedFile: downloadedUpdateFile, message: "已打开客户端安装包。" });
  return { success: true, path: downloadedUpdateFile };
}

function scheduleUpdateCheck(delayMs) {
  setTimeout(() => {
    checkForUpdates().catch((error) => {
      setUpdateState({ status: "error", message: errorMessage(error) });
    });
  }, delayMs);
}

function scheduleUpdateCheckIfConfigured(delayMs) {
  if (!readSettings(getUserDataDir()).serverUrl) return;
  scheduleUpdateCheck(delayMs);
}

function setUpdateState(nextState) {
  updateState = {
    ...updateState,
    ...nextState,
    currentVersion: app.getVersion(),
    updatedAt: new Date().toISOString()
  };
  mainWindow?.webContents.send("desktop:update-status", updateState);
  return updateState;
}

function normalizeReleaseNotes(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : item?.note ?? item?.value ?? ""))
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "UPDATE_CHECK_FAILED");
}

async function printSignedPdf(signedPdfUrl, printOptions) {
  const url = normalizePrintableUrl(signedPdfUrl);
  const options = normalizePrintOptions(printOptions);
  const printWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    parent: mainWindow ?? undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(() => reject(new Error("PRINT_LOAD_TIMEOUT"))), 30000);

    function finish(callback) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
      if (!printWindow.isDestroyed()) printWindow.close();
    }

    printWindow.webContents.once("did-fail-load", (_event, _errorCode, errorDescription) => {
      finish(() => reject(new Error(errorDescription || "PRINT_LOAD_FAILED")));
    });

    printWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        if (printWindow.isDestroyed()) {
          finish(() => reject(new Error("PRINT_WINDOW_CLOSED")));
          return;
        }
        printWindow.webContents.print(options, (success, failureReason) => {
          finish(() => resolve({ success, failureReason: success ? undefined : failureReason || "PRINT_CANCELLED" }));
        });
      }, 500);
    });

    printWindow.loadURL(url).catch((error) => {
      finish(() => reject(error));
    });
  });
}

function normalizePrintableUrl(value) {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("INVALID_PRINT_URL");
  }
  return url.toString();
}

function normalizePrintOptions(value) {
  const input = value && typeof value === "object" ? value : {};
  const output = {
    silent: true,
    printBackground: Boolean(input.printBackground),
    color: input.color !== false,
    landscape: Boolean(input.landscape),
    copies: clampInteger(input.copies, 1, 99, 1),
    scaleFactor: clampInteger(input.scaleFactor, 25, 200, 100),
    margins: { marginType: oneOf(input.margins?.marginType, ["default", "none", "printableArea"], "default") },
    duplexMode: oneOf(input.duplexMode, ["simplex", "shortEdge", "longEdge"], "simplex")
  };

  if (typeof input.deviceName === "string" && input.deviceName.trim()) {
    output.deviceName = input.deviceName.trim();
  }

  if (input.usePrinterDefaultPageSize === true) {
    output.usePrinterDefaultPageSize = true;
  } else if (typeof input.pageSize === "string") {
    output.pageSize = oneOf(input.pageSize, ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "Legal", "Letter", "Tabloid"], "A4");
    output.usePrinterDefaultPageSize = false;
  } else {
    output.usePrinterDefaultPageSize = true;
  }

  if (Array.isArray(input.pageRanges)) {
    const ranges = input.pageRanges
      .map((range) => ({
        from: clampInteger(range?.from, 0, 9999, 0),
        to: clampInteger(range?.to, 0, 9999, 0)
      }))
      .filter((range) => range.to >= range.from);
    if (ranges.length) output.pageRanges = ranges;
  }

  return output;
}

function isDefaultPrinter(printer) {
  const options = printer?.options ?? {};
  return options["printer-is-default"] === true || options["printer-is-default"] === "true" || options.isDefault === true;
}

function clampInteger(value, min, max, fallback) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

function oneOf(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

async function createMainWindow() {
  const clientServer = await createClientStaticServer(getClientDistDir());
  staticServer = clientServer.server;

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1080,
    minHeight: 720,
    title: "PDF 图纸审批",
    icon: getAppIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadURL(clientServer.url);
  scheduleUpdateCheckIfConfigured(800);
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  registerUpdateHandlers();
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  staticServer?.close();
});
