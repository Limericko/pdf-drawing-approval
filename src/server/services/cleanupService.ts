import fs from "node:fs/promises";
import path from "node:path";
import { folders } from "../files/fileLocations.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { BatchSubmissionRepository } from "../repositories/batchSubmissions.ts";
import { cleanupTempUploads } from "../uploads/tempUploads.ts";

export type CleanupResult = {
  executed: boolean;
  tempUploads: { count: number };
  failedBatchSubmissions: { count: number };
  oldSignedPdfs: { count: number; files: string[] };
};

export type CleanupInput = {
  dataDir: string;
  watchRoot?: string | null;
  approvals: ApprovalRepository;
  batchSubmissions: BatchSubmissionRepository;
  now?: Date;
  tempUploadMaxAgeMs?: number;
  failedBatchMaxAgeMs?: number;
  signedPdfMaxAgeMs?: number;
};

const defaultTempUploadMaxAgeMs = 24 * 60 * 60 * 1000;
const defaultFailedBatchMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
const defaultSignedPdfMaxAgeMs = 30 * 24 * 60 * 60 * 1000;

export async function previewCleanup(input: CleanupInput): Promise<CleanupResult> {
  const options = normalizeCleanupInput(input);
  const oldSignedPdfs = await findOldSignedPdfs(options);
  return {
    executed: false,
    tempUploads: { count: await countOldTempUploads(options.dataDir, options.tempUploadMaxAgeMs, options.now) },
    failedBatchSubmissions: {
      count: options.batchSubmissions.countFailedOlderThan(cutoffDate(options.now, options.failedBatchMaxAgeMs))
    },
    oldSignedPdfs: { count: oldSignedPdfs.length, files: oldSignedPdfs }
  };
}

export async function executeCleanup(input: CleanupInput): Promise<CleanupResult> {
  const options = normalizeCleanupInput(input);
  const oldSignedPdfs = await findOldSignedPdfs(options);
  const tempUploadCount = await cleanupTempUploads(options.dataDir, options.tempUploadMaxAgeMs);
  const failedBatchCount = options.batchSubmissions.deleteFailedOlderThan(cutoffDate(options.now, options.failedBatchMaxAgeMs));

  let deletedSignedPdfs = 0;
  for (const filePath of oldSignedPdfs) {
    await fs.rm(filePath, { force: true });
    deletedSignedPdfs += 1;
  }

  return {
    executed: true,
    tempUploads: { count: tempUploadCount },
    failedBatchSubmissions: { count: failedBatchCount },
    oldSignedPdfs: { count: deletedSignedPdfs, files: oldSignedPdfs }
  };
}

function normalizeCleanupInput(input: CleanupInput) {
  return {
    ...input,
    now: input.now ?? new Date(),
    tempUploadMaxAgeMs: input.tempUploadMaxAgeMs ?? defaultTempUploadMaxAgeMs,
    failedBatchMaxAgeMs: input.failedBatchMaxAgeMs ?? defaultFailedBatchMaxAgeMs,
    signedPdfMaxAgeMs: input.signedPdfMaxAgeMs ?? defaultSignedPdfMaxAgeMs
  };
}

async function countOldTempUploads(rootDir: string, maxAgeMs: number, now: Date) {
  const tmpRoot = path.join(rootDir, "uploads", "tmp");
  const entries = await fs.readdir(tmpRoot, { withFileTypes: true }).catch(() => []);
  const cutoff = now.getTime() - maxAgeMs;
  let count = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stats = await fs.stat(path.join(tmpRoot, entry.name)).catch(() => null);
    if (stats && stats.mtimeMs < cutoff) count += 1;
  }

  return count;
}

async function findOldSignedPdfs(input: ReturnType<typeof normalizeCleanupInput>) {
  const watchRoot = input.watchRoot?.trim();
  if (!watchRoot) return [];

  const referenced = new Set(
    input.approvals
      .list()
      .map((approval) => approval.signedFilePath)
      .filter((filePath): filePath is string => Boolean(filePath))
      .map(normalizePath)
  );
  const roots = [
    path.join(watchRoot, folders.approvedForPrint),
    path.join(watchRoot, folders.printedArchive)
  ];
  const cutoff = input.now.getTime() - input.signedPdfMaxAgeMs;
  const candidates: string[] = [];

  for (const root of roots) {
    const files = await listFiles(root);
    for (const filePath of files) {
      if (!isSignedPdfDerivative(filePath)) continue;
      if (referenced.has(normalizePath(filePath))) continue;
      const stats = await fs.stat(filePath).catch(() => null);
      if (!stats || stats.mtimeMs >= cutoff) continue;
      candidates.push(filePath);
    }
  }

  return candidates.sort((a, b) => a.localeCompare(b));
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function isSignedPdfDerivative(filePath: string) {
  return path.extname(filePath).toLowerCase() === ".pdf" && path.basename(filePath).includes("签审");
}

function cutoffDate(now: Date, maxAgeMs: number) {
  return new Date(now.getTime() - maxAgeMs);
}

function normalizePath(filePath: string) {
  return path.resolve(filePath).toLowerCase();
}
