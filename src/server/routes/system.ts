import { Router, type Request } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "../auth.ts";
import type { DatabaseConnection } from "../db.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { BackupRunRepository } from "../repositories/backups.ts";
import type { BatchSubmissionRepository } from "../repositories/batchSubmissions.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { ScanRunRepository } from "../repositories/scanRuns.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import type { UserPreferenceRepository } from "../repositories/userPreferences.ts";
import type { UserRepository } from "../repositories/users.ts";
import { scanMissingApprovalFiles, scanSubmittedFiles } from "../files/watchSubmissions.ts";
import { waitForStableFile } from "../files/waitForStableFile.ts";
import type { MailTransport } from "../notifications/email.ts";
import type { notifySystemRiskEvent as notifySystemRiskEventFn } from "../notifications/systemRiskNotifications.ts";
import { runDatabaseBackup } from "../services/backupService.ts";
import { validateBackupDirectory } from "../services/backupValidation.ts";
import { executeCleanup, previewCleanup } from "../services/cleanupService.ts";
import { getSystemDiagnostics } from "../services/diagnostics.ts";
import { isValidDailyTime, readMaintenanceSettings, type MaintenanceSettings } from "../services/maintenanceScheduler.ts";
import { getSystemRisks } from "../services/systemRisks.ts";
import { buildUpdateInfo, fetchUpdateManifestFromUrl, type UpdateManifest } from "../services/updateInfo.ts";
import { apiCompatVersion, appVersion } from "../../shared/appVersion.ts";

export function systemRoutes(deps: {
  approvals: ApprovalRepository;
  backups: BackupRunRepository;
  batchSubmissions: BatchSubmissionRepository;
  db: DatabaseConnection;
  dataDir: string;
  databasePath: string;
  backupRoot: string;
  settings: SettingsRepository;
  operationLogs?: OperationLogRepository;
  scanRuns: ScanRunRepository;
  signatureAssets?: SignatureAssetRepository;
  users?: UserRepository;
  userPreferences?: UserPreferenceRepository;
  mailTransport?: MailTransport | null;
  notifySystemRiskEvent?: typeof notifySystemRiskEventFn;
  fetchUpdateManifest?: (sourceUrl: string) => Promise<UpdateManifest>;
  jwtSecret: string;
  logRoot?: string;
  restart?: () => void;
}) {
  const router = Router();

  router.get("/logs", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const lines = clampLines(typeof req.query.lines === "string" ? Number(req.query.lines) : 200);
    const root = deps.logRoot ?? process.cwd();
    const logs = await Promise.all([
      readLogTail("server.log", [path.join(root, "server.log"), path.join(root, ".codex", "dev-server.out.log")], lines),
      readLogTail("server.err.log", [path.join(root, "server.err.log"), path.join(root, ".codex", "dev-server.err.log")], lines)
    ]);
    res.json({ lines, logs });
  });

  router.post("/restart", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "system.restart_requested",
      targetType: "system",
      targetId: null,
      message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}请求重启服务`
    });
    res.json({ restarting: true });
    setTimeout(() => {
      (deps.restart ?? defaultRestart)();
    }, 300);
  });

  router.get("/diagnostics", requireAuth(deps.jwtSecret, ["admin"]), async (_req, res) => {
    res.json(
      await getSystemDiagnostics({
        db: deps.db,
        settings: deps.settings,
        scanRuns: deps.scanRuns,
        backups: deps.backups,
        logRoot: deps.logRoot
      })
    );
  });

  router.get("/risks", requireAuth(deps.jwtSecret, ["admin"]), async (_req, res) => {
    res.json(
      await getSystemRisks({
        approvals: deps.approvals,
        backups: deps.backups,
        settings: deps.settings,
        scanRuns: deps.scanRuns,
        signatureAssets: deps.signatureAssets,
        users: deps.users,
        jwtSecret: deps.jwtSecret
      })
    );
  });

  router.get("/maintenance", requireAuth(deps.jwtSecret, ["admin"]), (_req, res) => {
    res.json(readMaintenanceSettings((key) => deps.settings.get(key)));
  });

  router.get("/client-update-info", requireAuth(deps.jwtSecret), async (req, res) => {
    const info = await buildUpdateInfo({
      currentVersion: resolveClientUpdateCurrentVersion(req),
      currentApiCompatVersion: apiCompatVersion,
      updateSourceUrl: resolveUpdateSourceUrl(req),
      fetchManifest: deps.fetchUpdateManifest ?? fetchUpdateManifestFromUrl
    });
    res.json(toClientUpdateInfo(info));
  });

  router.get("/update-info", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    res.json(
      await buildUpdateInfo({
        currentVersion: appVersion,
        currentApiCompatVersion: apiCompatVersion,
        updateSourceUrl: resolveUpdateSourceUrl(req),
        fetchManifest: deps.fetchUpdateManifest ?? fetchUpdateManifestFromUrl
      })
    );
  });

  router.put("/maintenance", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    const current = readMaintenanceSettings((key) => deps.settings.get(key));
    const next = mergeMaintenanceSettings(current, req.body);
    if (!next) {
      res.status(400).json({ error: "INVALID_MAINTENANCE_SETTINGS" });
      return;
    }

    deps.settings.set("maintenance_auto_backup_enabled", String(next.autoBackup.enabled));
    deps.settings.set("maintenance_auto_backup_time", next.autoBackup.time);
    deps.settings.set("maintenance_auto_cleanup_enabled", String(next.autoCleanup.enabled));
    deps.settings.set("maintenance_auto_cleanup_time", next.autoCleanup.time);
    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "system.maintenance_updated",
      targetType: "system",
      targetId: null,
      message: "管理员更新了自动维护计划",
      metadata: next
    });
    res.json(next);
  });

  router.post("/backups/validate", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const backupPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!backupPath) {
      res.status(400).json({ error: "BACKUP_PATH_REQUIRED" });
      return;
    }

    const result = await validateBackupDirectory(backupPath);
    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "system.backup_validated",
      targetType: "backup_directory",
      targetId: null,
      message: result.ok ? "管理员校验了可用备份目录" : "管理员校验备份目录未通过",
      metadata: { path: backupPath, result }
    });
    res.json(result);
  });

  router.post("/backup", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const backup = await runDatabaseBackup({
      backups: deps.backups,
      databasePath: deps.databasePath,
      backupRoot: deps.backupRoot,
      triggeredBy: req.user?.username ?? "admin"
    });

    if (backup.status === "completed") {
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "system.backup_completed",
        targetType: "backup_run",
        targetId: backup.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}创建了数据库备份`,
        metadata: { backupPath: backup.backupPath }
      });
      await notifyCurrentSystemRisks(deps, {
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        dedupeKey: `backup:${backup.id}:${backup.status}`
      });
      res.json(backup);
      return;
    }

    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: "system.backup_failed",
      targetType: "backup_run",
      targetId: backup.id,
      message: "数据库备份失败",
      metadata: { error: backup.errorMessage }
    });
    await notifyCurrentSystemRisks(deps, {
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      dedupeKey: `backup:${backup.id}:${backup.status}`
    });
    res.status(500).json(backup);
  });

  router.get("/backups", requireAuth(deps.jwtSecret, ["admin"]), (_req, res) => {
    res.json(deps.backups.listRecent());
  });

  router.post("/cleanup", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const execute = req.body?.execute === true;
    const watchRoot = deps.settings.get("watch_root");
    const input = {
      dataDir: deps.dataDir,
      watchRoot,
      approvals: deps.approvals,
      batchSubmissions: deps.batchSubmissions
    };
    const result = execute ? await executeCleanup(input) : await previewCleanup(input);

    deps.operationLogs?.create({
      actorUserId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      action: execute ? "system.cleanup_executed" : "system.cleanup_previewed",
      targetType: "system",
      targetId: null,
      message: execute ? "管理员执行了系统清理" : "管理员预览了系统清理候选项",
      metadata: result
    });

    res.json(result);
  });

  router.post("/scan-now", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const watchRoot = deps.settings.get("watch_root");
    if (!watchRoot) return res.status(400).json({ error: "WATCH_ROOT_NOT_CONFIGURED" });

    const run = deps.scanRuns.start(req.user?.username ?? "admin");
    try {
      const submitted = await scanSubmittedFiles({
        watchRoot,
        approvals: deps.approvals,
        operationLogs: deps.operationLogs,
        waitForStable: (filePath) => waitForStableFile(filePath, { intervalMs: 50, requiredStableChecks: 1, timeoutMs: 2000 })
      });
      const missing = await scanMissingApprovalFiles({
        watchRoot,
        approvals: deps.approvals,
        operationLogs: deps.operationLogs
      });
      const completed = deps.scanRuns.complete(run.id, {
        processedCount: submitted.processed,
        missingCount: missing.markedMissing,
        invalidCount: submitted.invalid
      });
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "system.scan_completed",
        targetType: "scan_run",
        targetId: completed.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}手动扫描了审批目录`,
        metadata: {
          processedCount: completed.processedCount,
          missingCount: completed.missingCount,
          invalidCount: completed.invalidCount
        }
      });
      await notifyCurrentSystemRisks(deps, {
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        dedupeKey: `scan:${completed.id}:${completed.status}`
      });
      res.json(completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "SCAN_FAILED";
      const failed = deps.scanRuns.fail(run.id, message);
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "system.scan_failed",
        targetType: "scan_run",
        targetId: failed.id,
        message: "手动扫描审批目录失败",
        metadata: { error: message }
      });
      await notifyCurrentSystemRisks(deps, {
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        dedupeKey: `scan:${failed.id}:${failed.status}`
      });
      res.status(500).json(failed);
    }
  });

  router.get("/scan-runs", requireAuth(deps.jwtSecret, ["admin"]), (_req, res) => {
    res.json(deps.scanRuns.listRecent());
  });

  return router;
}

async function notifyCurrentSystemRisks(
  deps: {
    approvals: ApprovalRepository;
    backups: BackupRunRepository;
    settings: SettingsRepository;
    scanRuns: ScanRunRepository;
    signatureAssets?: SignatureAssetRepository;
    users?: UserRepository;
    userPreferences?: UserPreferenceRepository;
    operationLogs?: OperationLogRepository;
    mailTransport?: MailTransport | null;
    notifySystemRiskEvent?: typeof notifySystemRiskEventFn;
    jwtSecret: string;
  },
  actor: { actorUserId?: number | null; actorUsername?: string | null; dedupeKey: string }
) {
  if (!deps.notifySystemRiskEvent || !deps.users || !deps.userPreferences) return;
  const risks = await getSystemRisks({
    approvals: deps.approvals,
    backups: deps.backups,
    settings: deps.settings,
    scanRuns: deps.scanRuns,
    signatureAssets: deps.signatureAssets,
    users: deps.users,
    jwtSecret: deps.jwtSecret
  });
  await deps.notifySystemRiskEvent({
    risks,
    users: deps.users,
    userPreferences: deps.userPreferences,
    settings: deps.settings,
    operationLogs: deps.operationLogs,
    transport: deps.mailTransport,
    actorUserId: actor.actorUserId,
    actorUsername: actor.actorUsername,
    dedupeKey: actor.dedupeKey
  });
}

function defaultRestart() {
  process.exit(42);
}

function clampLines(lines: number) {
  if (!Number.isFinite(lines)) return 200;
  return Math.max(20, Math.min(1000, Math.trunc(lines)));
}

function resolveUpdateSourceUrl(req: Request) {
  return process.env.PDF_APPROVAL_UPDATE_MANIFEST_URL?.trim() || defaultUpdateManifestUrl(req);
}

function defaultUpdateManifestUrl(req: Request) {
  const host = req.get("host");
  if (!host) return null;
  return `${req.protocol}://${host}/updates/latest.json`;
}

function resolveClientUpdateCurrentVersion(req: Request) {
  const reportedVersion = firstString(req.query.currentVersion) ?? req.get("x-pdf-approval-client-version");
  const normalizedVersion = normalizeClientVersion(reportedVersion);
  if (normalizedVersion) return normalizedVersion;

  return isElectronClientRequest(req) ? "0.0.0" : appVersion;
}

function firstString(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string") ?? null;
  return null;
}

function normalizeClientVersion(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return null;
  return /^\d+(?:[.-]\d+){0,4}(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : null;
}

function isElectronClientRequest(req: Request) {
  return /\bElectron\/\d/i.test(req.get("user-agent") ?? "");
}

function toClientUpdateInfo(info: Awaited<ReturnType<typeof buildUpdateInfo>>) {
  if (!info.latest) return info;
  const clientInstaller = info.latest.downloads?.clientInstaller;
  return {
    ...info,
    latest: {
      ...info.latest,
      downloads: clientInstaller ? { clientInstaller } : undefined
    }
  };
}

async function readLogTail(name: string, filePaths: string[], lines: number) {
  for (const filePath of filePaths) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      return {
        name,
        exists: true,
        content: content.split(/\r?\n/).slice(-lines).join("\n")
      };
    } catch {
      // Try the next compatible log location.
    }
  }

  return {
    name,
    exists: false,
    content: ""
  };
}

function mergeMaintenanceSettings(current: MaintenanceSettings, input: unknown): MaintenanceSettings | null {
  if (!input || typeof input !== "object") return null;
  const body = input as Partial<Record<"autoBackup" | "autoCleanup", unknown>>;
  const autoBackup = normalizeScheduleInput(body.autoBackup, current.autoBackup);
  const autoCleanup = normalizeScheduleInput(body.autoCleanup, current.autoCleanup);
  if (!autoBackup || !autoCleanup) return null;
  return { autoBackup, autoCleanup };
}

function normalizeScheduleInput(input: unknown, current: MaintenanceSettings["autoBackup"]) {
  if (input === undefined) return current;
  if (!input || typeof input !== "object") return null;
  const schedule = input as Partial<MaintenanceSettings["autoBackup"]>;
  const enabled = typeof schedule.enabled === "boolean" ? schedule.enabled : current.enabled;
  const time = typeof schedule.time === "string" ? schedule.time.trim() : current.time;
  if (!isValidDailyTime(time)) return null;
  return { enabled, time };
}
