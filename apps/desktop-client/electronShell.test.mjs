import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function read(fileName) {
  return fs.readFileSync(path.join(testDir, fileName), "utf8");
}

describe("Electron shell", () => {
  it("creates the BrowserWindow with isolated renderer settings", () => {
    const source = read("main.cjs");

    expect(source).toContain("createClientStaticServer");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("preload:");
    expect(source).toContain("icon: getAppIconPath()");
    expect(source).toContain("pdf-approval-client.png");
  });

  it("preload exposes only the desktop configuration bridge", () => {
    const source = read("preload.cjs");

    expect(source).toContain("contextBridge.exposeInMainWorld(\"pdfApprovalDesktop\"");
    expect(source).toContain("getServerUrl");
    expect(source).toContain("setServerUrl");
    expect(source).toContain("clearServerUrl");
    expect(source).not.toContain("require(\"fs\")");
  });

  it("exposes a narrow native print bridge", () => {
    const mainSource = read("main.cjs");
    const preloadSource = read("preload.cjs");

    expect(preloadSource).toContain("listPrinters");
    expect(preloadSource).toContain("getPrintSettings");
    expect(preloadSource).toContain("setPrintSettings");
    expect(preloadSource).toContain("printSignedPdf");
    expect(mainSource).toContain("desktop:list-printers");
    expect(mainSource).toContain("desktop:get-print-settings");
    expect(mainSource).toContain("desktop:set-print-settings");
    expect(mainSource).toContain("desktop:print-signed-pdf");
    expect(mainSource).toContain("getPrintersAsync");
    expect(mainSource).toContain("webContents.print");
  });

  it("uses electron-updater with renderer-visible progress and manual installer launch", () => {
    const mainSource = read("main.cjs");
    const preloadSource = read("preload.cjs");

    expect(mainSource).toContain("electron-updater");
    expect(mainSource).toContain("desktop:update-status");
    expect(mainSource).toContain("desktop:check-for-updates");
    expect(mainSource).toContain("desktop:open-downloaded-update-installer");
    expect(mainSource).toContain("autoDownload = false");
    expect(mainSource).toContain("autoInstallOnAppQuit = false");
    expect(mainSource).toContain("download-progress");
    expect(mainSource).toContain("update-downloaded");
    expect(mainSource).toContain("setFeedURL");
    expect(mainSource).not.toContain("quitAndInstall");
    expect(preloadSource).toContain("onUpdateStatus");
    expect(preloadSource).toContain("checkForUpdates");
    expect(preloadSource).toContain("openDownloadedUpdateInstaller");
  });
});
