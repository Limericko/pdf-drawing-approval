import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import { parseDrawingFileName } from "./parseDrawingFileName.ts";
import { folders, isManagedStatusFile, projectNameFromWatchedFile, targetPath } from "./fileLocations.ts";
import { hasPdfHeader } from "./pdfValidation.ts";
import { waitForStableFile } from "./waitForStableFile.ts";

export type SubmissionHandlerDeps = {
  watchRoot: string;
  approvals: ApprovalRepository;
  operationLogs?: OperationLogRepository;
  notifyApprovalCreated?: (approvalId: number) => Promise<void>;
  waitForStable?: typeof waitForStableFile;
  scanIntervalMs?: number;
};

export async function processSubmittedFile(filePath: string, deps: SubmissionHandlerDeps) {
  if (isManagedStatusFile(deps.watchRoot, filePath)) {
    return { processed: false as const, reason: "managed_status_file" };
  }

  const stable = await (deps.waitForStable ?? waitForStableFile)(filePath);
  if (!stable.ok) return { processed: false as const, reason: stable.reason };
  if (deps.approvals.findByCurrentFilePath(filePath)) {
    return { processed: false as const, reason: "duplicate" };
  }

  const projectName = projectNameFromWatchedFile(deps.watchRoot, filePath);
  const parsed = parseDrawingFileName(filePath);
  const fileName = path.basename(filePath);

  if (!projectName || !parsed) {
    const invalid = deps.approvals.create({
      projectName: projectName ?? "未知项目",
      partName: parsed?.partName ?? fileName.replace(/\.pdf$/i, ""),
      version: parsed?.version ?? "invalid",
      minorVersion: parsed?.minorVersion ?? "invalid",
      majorVersion: parsed?.majorVersion ?? "invalid",
      originalFilePath: filePath,
      currentFilePath: filePath,
      status: "filename_invalid"
    });
    deps.operationLogs?.create({
      actorUsername: "system",
      action: "approval.created",
      targetType: "approval",
      targetId: invalid.id,
      message: "系统记录了文件名异常的图纸",
      metadata: { filePath, status: invalid.status }
    });
    return { processed: true as const, approval: invalid };
  }

  const existing = deps.approvals.findVersion(projectName, parsed.partName, parsed.version);
  if (existing) {
    return { processed: false as const, reason: "duplicate" };
  }

  if (!(await hasPdfHeader(filePath))) {
    const invalid = deps.approvals.create({
      projectName,
      partName: parsed.partName,
      version: parsed.version,
      minorVersion: parsed.minorVersion,
      majorVersion: parsed.majorVersion,
      originalFilePath: filePath,
      currentFilePath: filePath,
      status: "invalid_pdf"
    });
    deps.operationLogs?.create({
      actorUsername: "system",
      action: "approval.created",
      targetType: "approval",
      targetId: invalid.id,
      message: "系统记录了 PDF 内容无效的图纸",
      metadata: { filePath, status: invalid.status }
    });
    return { processed: true as const, approval: invalid };
  }

  const nextPath = targetPath(deps.watchRoot, folders.reviewing, projectName, fileName);
  await fs.mkdir(path.dirname(nextPath), { recursive: true });
  await fs.rename(filePath, nextPath);

  const approval = deps.approvals.create({
    projectName,
    partName: parsed.partName,
    version: parsed.version,
    minorVersion: parsed.minorVersion,
    majorVersion: parsed.majorVersion,
    originalFilePath: filePath,
    currentFilePath: nextPath,
    source: "folder_watch",
    signatureStatus: "placement_required"
  });

  deps.operationLogs?.create({
    actorUsername: "system",
    action: "approval.created",
    targetType: "approval",
    targetId: approval.id,
    message: "系统从监听目录创建了审批单",
    metadata: { originalFilePath: filePath, currentFilePath: nextPath }
  });
  await deps.notifyApprovalCreated?.(approval.id);
  return { processed: true as const, approval };
}

export function processDeletedFile(filePath: string, deps: SubmissionHandlerDeps) {
  const approval = deps.approvals.findByCurrentFilePath(filePath);
  if (!approval || approval.status !== "pending") {
    return { processed: false as const, reason: "not_pending_current_file" };
  }

  const updated = deps.approvals.markFileMissing(approval.id);
  if (!updated) {
    return { processed: false as const, reason: "stale_or_not_pending" };
  }
  deps.operationLogs?.create({
    actorUsername: "system",
    action: "approval.file_missing",
    targetType: "approval",
    targetId: updated.id,
    message: "系统检测到待审图纸文件丢失",
    metadata: { filePath }
  });
  return { processed: true as const, approvalId: updated.id };
}

export async function scanSubmittedFiles(deps: SubmissionHandlerDeps) {
  const files = await collectPdfFiles(deps.watchRoot);
  let processed = 0;
  let invalid = 0;

  for (const filePath of files) {
    const result = await processSubmittedFile(filePath, deps);
    if (result.processed) {
      processed += 1;
      if ("approval" in result && result.approval.status === "invalid_pdf") {
        invalid += 1;
      }
    }
  }

  return { processed, invalid };
}

export async function scanMissingApprovalFiles(deps: SubmissionHandlerDeps) {
  const pendingApprovals = deps.approvals.list({ status: "pending" });
  let markedMissing = 0;

  for (const approval of pendingApprovals) {
    if (await fileExists(approval.currentFilePath)) continue;
    const updated = deps.approvals.markFileMissing(approval.id);
    if (!updated) continue;
    deps.operationLogs?.create({
      actorUsername: "system",
      action: "approval.file_missing",
      targetType: "approval",
      targetId: updated.id,
      message: "系统扫描到待审图纸文件丢失",
      metadata: { filePath: approval.currentFilePath }
    });
    markedMissing += 1;
  }

  return { markedMissing };
}

export function watchSubmissions(deps: SubmissionHandlerDeps) {
  const watcher = chokidar.watch(deps.watchRoot, {
    ignoreInitial: false,
    ignored: (filePath) => isManagedStatusFile(deps.watchRoot, filePath)
  });
  watcher.on("add", (filePath) => {
    if (path.extname(filePath).toLowerCase() !== ".pdf") return;
    processSubmittedFile(filePath, deps)
      .then((result) => {
        if (result.processed) {
          console.log(`Processed submitted PDF: ${filePath}`);
        }
      })
      .catch((error) => {
        console.error("Failed to process submitted PDF", filePath, error);
      });
  });
  watcher.on("unlink", (filePath) => {
    const result = processDeletedFile(filePath, deps);
    if (result.processed) {
      console.warn(`Submitted PDF was deleted before review completed: ${filePath}`);
    }
  });
  const scanTimer = setInterval(() => {
    Promise.all([scanSubmittedFiles(deps), scanMissingApprovalFiles(deps)])
      .then(([submitted, missing]) => {
        if (submitted.processed > 0) console.log(`PDF submission fallback scan processed ${submitted.processed} file(s)`);
        if (missing.markedMissing > 0) console.warn(`PDF submission fallback scan marked ${missing.markedMissing} missing file(s)`);
      })
      .catch((error) => {
        console.error("Failed to scan submitted PDFs", error);
      });
  }, deps.scanIntervalMs ?? 10_000);
  const originalClose = watcher.close.bind(watcher);
  watcher.close = async () => {
    clearInterval(scanTimer);
    return originalClose();
  };
  return watcher;
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectPdfFiles(root: string): Promise<string[]> {
  const result: string[] = [];

  async function visit(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".pdf") {
        result.push(entryPath);
      }
    }
  }

  await visit(root);
  return result;
}
