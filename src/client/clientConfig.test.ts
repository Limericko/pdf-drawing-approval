import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiUrl,
  clearServerBaseUrl,
  getDesktopClientVersion,
  getDesktopUpdateStatus,
  getDesktopPrintSettings,
  getServerBaseUrl,
  isDesktopClient,
  listDesktopPrinters,
  normalizeServerBaseUrl,
  onDesktopUpdateStatus,
  openDownloadedUpdateInstaller,
  persistDesktopPrintSettings,
  persistServerBaseUrl,
  printSignedPdfWithDesktop,
  checkDesktopUpdates,
  setServerBaseUrl
} from "./clientConfig.ts";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
});

describe("clientConfig", () => {
  it("keeps API paths relative when no server base URL is configured", () => {
    expect(getServerBaseUrl()).toBeNull();
    expect(apiUrl("/api/approvals?mine=1")).toBe("/api/approvals?mine=1");
    expect(apiUrl("/health")).toBe("/health");
  });

  it("normalizes and stores LAN server base URLs", () => {
    expect(normalizeServerBaseUrl(" http://192.168.1.20:8080/ ")).toBe("http://192.168.1.20:8080");
    expect(setServerBaseUrl("http://192.168.1.20:8080/")).toBe("http://192.168.1.20:8080");

    expect(getServerBaseUrl()).toBe("http://192.168.1.20:8080");
    expect(apiUrl("/api/approvals/4/file?token=abc")).toBe("http://192.168.1.20:8080/api/approvals/4/file?token=abc");
  });

  it("rejects server URLs without http or https", () => {
    expect(() => normalizeServerBaseUrl("192.168.1.20:8080")).toThrow("INVALID_SERVER_URL");
    expect(() => normalizeServerBaseUrl("file:///tmp/app")).toThrow("INVALID_SERVER_URL");
  });

  it("detects Electron desktop mode from preload bridge", () => {
    vi.stubGlobal("window", { pdfApprovalDesktop: { getServerUrl: vi.fn() } });

    expect(isDesktopClient()).toBe(true);
  });

  it("reads the installed desktop client version from the preload bridge", async () => {
    vi.stubGlobal("window", { pdfApprovalDesktop: { getAppVersion: vi.fn(async () => "0.8.7") } });

    await expect(getDesktopClientVersion()).resolves.toBe("0.8.7");
  });

  it("bridges desktop updater status, checks, installer opening, and events", async () => {
    const unsubscribe = vi.fn();
    const onUpdateStatus = vi.fn(() => unsubscribe);
    const updateStatus = { status: "downloading", percent: 42, currentVersion: "0.9.0", latestVersion: "0.9.1" };
    const checkForUpdates = vi.fn(async () => updateStatus);
    const openInstallerBridge = vi.fn(async () => ({ success: true, path: "C:\\updates\\client.exe" }));
    vi.stubGlobal("window", {
      pdfApprovalDesktop: {
        getUpdateStatus: vi.fn(async () => updateStatus),
        checkForUpdates,
        openDownloadedUpdateInstaller: openInstallerBridge,
        onUpdateStatus
      }
    });
    const listener = vi.fn();

    await expect(getDesktopUpdateStatus()).resolves.toBe(updateStatus);
    await expect(checkDesktopUpdates()).resolves.toBe(updateStatus);
    await expect(openDownloadedUpdateInstaller()).resolves.toEqual({ success: true, path: "C:\\updates\\client.exe" });
    expect(onDesktopUpdateStatus(listener)).toBe(unsubscribe);
    expect(onUpdateStatus).toHaveBeenCalledWith(listener);
  });

  it("persists server URLs through the Electron preload bridge when available", async () => {
    const setServerUrl = vi.fn(async () => undefined);
    vi.stubGlobal("window", { pdfApprovalDesktop: { setServerUrl } });

    await expect(persistServerBaseUrl("http://127.0.0.1:8080/")).resolves.toBe("http://127.0.0.1:8080");

    expect(setServerUrl).toHaveBeenCalledWith("http://127.0.0.1:8080");
    expect(getServerBaseUrl()).toBe("http://127.0.0.1:8080");
  });

  it("reads printers and print settings through the Electron preload bridge", async () => {
    vi.stubGlobal("window", {
      pdfApprovalDesktop: {
        listPrinters: vi.fn(async () => [{ name: "HP", displayName: "HP LaserJet", description: "Office", isDefault: true }]),
        getPrintSettings: vi.fn(async () => ({ printerName: "HP", copies: 2 }))
      }
    });

    await expect(listDesktopPrinters()).resolves.toEqual([{ name: "HP", displayName: "HP LaserJet", description: "Office", isDefault: true }]);
    await expect(getDesktopPrintSettings()).resolves.toMatchObject({ printerName: "HP", copies: 2, paperSize: "printer-default" });
  });

  it("persists print settings and sends signed PDFs to the native print bridge", async () => {
    const setPrintSettings = vi.fn(async () => undefined);
    const printSignedPdf = vi.fn(async () => ({ success: true }));
    vi.stubGlobal("window", { pdfApprovalDesktop: { setPrintSettings, printSignedPdf } });

    await expect(persistDesktopPrintSettings({ printerName: "HP", copies: 2 })).resolves.toMatchObject({ printerName: "HP", copies: 2 });
    await expect(printSignedPdfWithDesktop("http://127.0.0.1:8080/api/approvals/1/signed-file", { copies: 2 })).resolves.toEqual({
      success: true
    });

    expect(setPrintSettings).toHaveBeenCalledWith(expect.objectContaining({ printerName: "HP", copies: 2 }));
    expect(printSignedPdf).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/api/approvals/1/signed-file",
      expect.objectContaining({ copies: 2 })
    );
  });

  it("clears local server URL state", () => {
    setServerBaseUrl("http://127.0.0.1:8080");
    clearServerBaseUrl();

    expect(getServerBaseUrl()).toBeNull();
    expect(apiUrl("/api/users")).toBe("/api/users");
  });
});
