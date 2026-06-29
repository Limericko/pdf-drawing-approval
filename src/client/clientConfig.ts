import { defaultPrintSettings, sanitizePrintSettings } from "./printSettings.ts";
import type { DesktopPrintOptions, DesktopPrinter, DesktopPrintResult, PrintSettings } from "./printSettings.ts";

const serverBaseUrlKey = "pdf_approval_server_base_url";

export type DesktopBridge = {
  getServerUrl?: () => Promise<string | null>;
  setServerUrl?: (serverUrl: string) => Promise<void>;
  clearServerUrl?: () => Promise<void>;
  getAppVersion?: () => Promise<string>;
  getUpdateStatus?: () => Promise<DesktopUpdateStatus>;
  checkForUpdates?: () => Promise<DesktopUpdateStatus>;
  openDownloadedUpdateInstaller?: () => Promise<{ success: boolean; error?: string; path?: string }>;
  onUpdateStatus?: (callback: (status: DesktopUpdateStatus) => void) => () => void;
  listPrinters?: () => Promise<DesktopPrinter[]>;
  getPrintSettings?: () => Promise<Partial<PrintSettings> | null>;
  setPrintSettings?: (printSettings: PrintSettings) => Promise<void>;
  printSignedPdf?: (signedPdfUrl: string, printOptions: Partial<DesktopPrintOptions>) => Promise<DesktopPrintResult>;
};

export type DesktopUpdateStatus = {
  status:
    | "idle"
    | "config_missing"
    | "checking"
    | "not_available"
    | "downloading"
    | "downloaded"
    | "installer_opened"
    | "error";
  currentVersion?: string;
  latestVersion?: string | null;
  releaseDate?: string | null;
  releaseNotes?: string[];
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  downloadedFile?: string | null;
  message?: string;
  updatedAt?: string;
};

declare global {
  interface Window {
    pdfApprovalDesktop?: DesktopBridge;
  }
}

export function isDesktopClient() {
  return Boolean(getDesktopBridge());
}

export async function getDesktopClientVersion() {
  const bridge = getDesktopBridge();
  if (!bridge?.getAppVersion) return null;

  try {
    const version = await bridge.getAppVersion();
    return normalizeDesktopClientVersion(version);
  } catch {
    return null;
  }
}

export async function getDesktopUpdateStatus() {
  return getDesktopBridge()?.getUpdateStatus?.() ?? null;
}

export async function checkDesktopUpdates() {
  return getDesktopBridge()?.checkForUpdates?.() ?? null;
}

export async function openDownloadedUpdateInstaller() {
  const bridge = getDesktopBridge();
  if (!bridge?.openDownloadedUpdateInstaller) return { success: false, error: "DESKTOP_UPDATE_UNAVAILABLE" };
  return bridge.openDownloadedUpdateInstaller();
}

export function onDesktopUpdateStatus(callback: (status: DesktopUpdateStatus) => void) {
  return getDesktopBridge()?.onUpdateStatus?.(callback) ?? (() => undefined);
}

export async function listDesktopPrinters() {
  const bridge = getDesktopBridge();
  if (!bridge?.listPrinters) return [];

  try {
    const printers = await bridge.listPrinters();
    return Array.isArray(printers) ? printers : [];
  } catch {
    return [];
  }
}

export async function getDesktopPrintSettings() {
  const bridge = getDesktopBridge();
  if (!bridge?.getPrintSettings) return defaultPrintSettings();

  try {
    return sanitizePrintSettings(await bridge.getPrintSettings());
  } catch {
    return defaultPrintSettings();
  }
}

export async function persistDesktopPrintSettings(settings: Partial<PrintSettings>) {
  const sanitized = sanitizePrintSettings(settings);
  await getDesktopBridge()?.setPrintSettings?.(sanitized);
  return sanitized;
}

export async function printSignedPdfWithDesktop(signedPdfUrl: string, printOptions: Partial<DesktopPrintOptions>) {
  const bridge = getDesktopBridge();
  if (!bridge?.printSignedPdf) {
    return { success: false, failureReason: "DESKTOP_PRINT_UNAVAILABLE" };
  }
  return bridge.printSignedPdf(signedPdfUrl, printOptions);
}

export function normalizeServerBaseUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("INVALID_SERVER_URL");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("INVALID_SERVER_URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("INVALID_SERVER_URL");
  }

  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export function getServerBaseUrl() {
  const value = getStorage()?.getItem(serverBaseUrlKey);
  if (!value) return null;

  try {
    return normalizeServerBaseUrl(value);
  } catch {
    clearServerBaseUrl();
    return null;
  }
}

export function setServerBaseUrl(value: string) {
  const normalized = normalizeServerBaseUrl(value);
  getStorage()?.setItem(serverBaseUrlKey, normalized);
  return normalized;
}

export function clearServerBaseUrl() {
  getStorage()?.removeItem(serverBaseUrlKey);
}

export async function initializeServerBaseUrl() {
  const bridge = getDesktopBridge();
  const serverUrl = bridge?.getServerUrl ? await bridge.getServerUrl() : null;
  if (serverUrl) return setServerBaseUrl(serverUrl);
  return getServerBaseUrl();
}

export async function persistServerBaseUrl(value: string) {
  const normalized = setServerBaseUrl(value);
  await getDesktopBridge()?.setServerUrl?.(normalized);
  return normalized;
}

export async function clearConfiguredServerBaseUrl() {
  clearServerBaseUrl();
  await getDesktopBridge()?.clearServerUrl?.();
}

export function apiUrl(pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const baseUrl = getServerBaseUrl();
  if (!baseUrl) return pathOrUrl;
  return new URL(pathOrUrl, `${baseUrl}/`).toString();
}

export async function checkServerHealth(serverBaseUrl: string) {
  const response = await fetch(new URL("/health", `${normalizeServerBaseUrl(serverBaseUrl)}/`), {
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
}

function getDesktopBridge() {
  if (typeof window === "undefined") return null;
  return window.pdfApprovalDesktop ?? null;
}

function normalizeDesktopClientVersion(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
