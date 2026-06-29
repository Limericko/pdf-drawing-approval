import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = fs.readFileSync(path.resolve("apps/server-exe/main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.resolve("apps/server-exe/preload.cjs"), "utf8");

describe("server exe main window lifecycle", () => {
  it("exposes a hide-window IPC method to the sandboxed console page", () => {
    expect(preloadSource).toContain("hideWindow");
    expect(preloadSource).toContain('server-console:hide-window');
  });

  it("keeps the server running when the console window is closed or hidden to tray", () => {
    expect(mainSource).toContain("Tray");
    expect(mainSource).toContain("Menu");
    expect(mainSource).toContain("nativeImage");
    expect(mainSource).toContain("let tray");
    expect(mainSource).toContain("let isQuitting");
    expect(mainSource).toContain('icon: getAppIconPath("pdf-approval-server.png")');
    expect(mainSource).toContain("nativeImage.createFromPath(getAppIconPath");
    expect(mainSource).toContain("pdf-approval-server.png");
    expect(mainSource).not.toContain("createFromDataURL");
    expect(mainSource).toContain('mainWindow.on("close"');
    expect(mainSource).toContain("event.preventDefault()");
    expect(mainSource).toContain("mainWindow.hide()");
    expect(mainSource).toContain("hideMainWindow");
    expect(mainSource).toContain("showMainWindow");
    expect(mainSource).toContain("quitFromTray");
    expect(mainSource).toContain('server-console:hide-window');
  });

  it("provides tray actions to restore, open useful locations, and explicitly quit", () => {
    expect(mainSource).toContain("显示服务端窗口");
    expect(mainSource).toContain("打开本机工作台");
    expect(mainSource).toContain("打开日志目录");
    expect(mainSource).toContain("退出服务端");
    expect(mainSource).toContain("openDirectoryFromTray");
    expect(mainSource).toContain("isQuitting = true");
  });
});
