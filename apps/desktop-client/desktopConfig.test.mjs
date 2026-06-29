import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import desktopConfig from "./desktopConfig.cjs";

const {
  normalizeServerUrl,
  readSettings,
  writeSettings,
  readPrintSettings,
  writePrintSettings,
  resolveClientFile,
  contentTypeForPath
} = desktopConfig;

describe("desktopConfig", () => {
  it("normalizes http server URLs for LAN clients", () => {
    expect(normalizeServerUrl(" http://192.168.1.20:8080/ ")).toBe("http://192.168.1.20:8080");
    expect(normalizeServerUrl("https://approval.local:8443/app/")).toBe("https://approval.local:8443/app");
  });

  it("rejects non-http server URLs", () => {
    expect(() => normalizeServerUrl("192.168.1.20:8080")).toThrow("INVALID_SERVER_URL");
    expect(() => normalizeServerUrl("file:///C:/approval")).toThrow("INVALID_SERVER_URL");
  });

  it("reads and writes settings under the Electron userData directory", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-desktop-"));

    writeSettings(userDataDir, { serverUrl: "http://127.0.0.1:8080" });

    expect(readSettings(userDataDir)).toEqual({ serverUrl: "http://127.0.0.1:8080" });
  });

  it("persists print settings without discarding the server URL", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-desktop-"));

    writeSettings(userDataDir, { serverUrl: "http://127.0.0.1:8080" });
    writePrintSettings(userDataDir, { printerName: "HP", copies: 2, paperSize: "A3" });

    expect(readSettings(userDataDir)).toEqual({ serverUrl: "http://127.0.0.1:8080" });
    expect(readPrintSettings(userDataDir)).toMatchObject({ printerName: "HP", copies: 2, paperSize: "A3" });
  });

  it("resolves client assets without allowing path traversal", () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-client-"));
    fs.mkdirSync(path.join(distDir, "assets"));
    fs.writeFileSync(path.join(distDir, "index.html"), "<div>app</div>");
    fs.writeFileSync(path.join(distDir, "assets", "main.js"), "console.log('app');");

    expect(resolveClientFile(distDir, "/assets/main.js")).toBe(path.join(distDir, "assets", "main.js"));
    expect(resolveClientFile(distDir, "/../../secret.txt")).toBe(path.join(distDir, "index.html"));
    expect(resolveClientFile(distDir, "/#/approvals")).toBe(path.join(distDir, "index.html"));
  });

  it("maps common static file content types", () => {
    expect(contentTypeForPath("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeForPath("main.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeForPath("styles.css")).toBe("text/css; charset=utf-8");
  });
});
