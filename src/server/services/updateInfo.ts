import { releaseNotes, type ReleaseNote } from "../../shared/releaseNotes.ts";

export type UpdateManifest = {
  version: string;
  releaseDate?: string;
  channel?: string;
  notes?: string[];
  changelogUrl?: string;
  minimumApiCompatVersion?: number;
  downloads?: {
    clientInstaller?: string;
    serverInstaller?: string;
  };
};

export type UpdateInfo = {
  currentVersion: string;
  currentApiCompatVersion: number;
  updateSourceUrl: string | null;
  latest: UpdateManifest | null;
  updateAvailable: boolean;
  checkedAt: string;
  error: string | null;
  releaseNotes: ReleaseNote[];
};

type ManifestDownloads = NonNullable<UpdateManifest["downloads"]>;

export async function buildUpdateInfo(input: {
  currentVersion: string;
  currentApiCompatVersion: number;
  updateSourceUrl?: string | null;
  fetchManifest?: (sourceUrl: string) => Promise<UpdateManifest>;
  now?: () => Date;
}): Promise<UpdateInfo> {
  const sourceUrl = input.updateSourceUrl?.trim() || null;
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  if (!sourceUrl) {
    return {
      currentVersion: input.currentVersion,
      currentApiCompatVersion: input.currentApiCompatVersion,
      updateSourceUrl: null,
      latest: null,
      updateAvailable: false,
      checkedAt,
      error: null,
      releaseNotes
    };
  }

  try {
    const manifest = normalizeManifest(await (input.fetchManifest ?? fetchUpdateManifestFromUrl)(sourceUrl), sourceUrl);
    return {
      currentVersion: input.currentVersion,
      currentApiCompatVersion: input.currentApiCompatVersion,
      updateSourceUrl: sourceUrl,
      latest: manifest,
      updateAvailable: compareVersions(manifest.version, input.currentVersion) > 0,
      checkedAt,
      error: null,
      releaseNotes
    };
  } catch (error) {
    return {
      currentVersion: input.currentVersion,
      currentApiCompatVersion: input.currentApiCompatVersion,
      updateSourceUrl: sourceUrl,
      latest: null,
      updateAvailable: false,
      checkedAt,
      error: error instanceof Error ? error.message : "UPDATE_CHECK_FAILED",
      releaseNotes
    };
  }
}

export function compareVersions(left: string, right: string) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function fetchUpdateManifestFromUrl(sourceUrl: string): Promise<UpdateManifest> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return (await response.json()) as UpdateManifest;
  } finally {
    clearTimeout(timeout);
  }
}

function parseVersion(value: string) {
  return value
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function normalizeManifest(manifest: UpdateManifest, sourceUrl: string): UpdateManifest {
  if (!manifest || typeof manifest !== "object") throw new Error("INVALID_UPDATE_MANIFEST");
  if (typeof manifest.version !== "string" || !manifest.version.trim()) throw new Error("INVALID_UPDATE_VERSION");

  const normalized: UpdateManifest = {
    version: manifest.version.trim(),
    notes: Array.isArray(manifest.notes) ? manifest.notes.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : []
  };
  const releaseDate = stringOrUndefined(manifest.releaseDate);
  const channel = stringOrUndefined(manifest.channel);
  const changelogUrl = resolveManifestUrl(manifest.changelogUrl, sourceUrl);
  const downloads = normalizeDownloads(manifest.downloads, sourceUrl);
  if (releaseDate) normalized.releaseDate = releaseDate;
  if (channel) normalized.channel = channel;
  if (changelogUrl) normalized.changelogUrl = changelogUrl;
  if (Number.isFinite(manifest.minimumApiCompatVersion)) normalized.minimumApiCompatVersion = manifest.minimumApiCompatVersion;
  if (downloads.clientInstaller || downloads.serverInstaller) normalized.downloads = downloads;
  return normalized;
}

function normalizeDownloads(downloads: UpdateManifest["downloads"], sourceUrl: string): ManifestDownloads {
  if (!downloads || typeof downloads !== "object") return {};
  return {
    clientInstaller: resolveManifestUrl(downloads.clientInstaller, sourceUrl),
    serverInstaller: resolveManifestUrl(downloads.serverInstaller, sourceUrl)
  };
}

function resolveManifestUrl(value: unknown, sourceUrl: string) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, sourceUrl).toString();
  } catch {
    return trimmed;
  }
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
