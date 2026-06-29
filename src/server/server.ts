import express from "express";
import path from "node:path";
import { networkInterfaces } from "node:os";
import { performance } from "node:perf_hooks";
import type { AppConfig } from "./config.ts";
import { createDatabase, type DatabaseConnection } from "./db.ts";
import { ApprovalCommentRepository } from "./repositories/approvalComments.ts";
import { ApprovalAnnotationRepository } from "./repositories/approvalAnnotations.ts";
import { ApprovalRepository } from "./repositories/approvals.ts";
import { BackupRunRepository } from "./repositories/backups.ts";
import { BatchSubmissionRepository } from "./repositories/batchSubmissions.ts";
import { OperationLogRepository } from "./repositories/operationLogs.ts";
import { PasswordResetTokenRepository } from "./repositories/passwordResetTokens.ts";
import { ScanRunRepository } from "./repositories/scanRuns.ts";
import { SignatureAssetRepository } from "./repositories/signatureAssets.ts";
import { SignaturePlacementRepository } from "./repositories/signaturePlacements.ts";
import { SignatureTemplateRepository } from "./repositories/signatureTemplates.ts";
import { UserPreferenceRepository } from "./repositories/userPreferences.ts";
import { UserRepository } from "./repositories/users.ts";
import { SettingsRepository } from "./repositories/settings.ts";
import { authRoutes } from "./routes/auth.ts";
import { approvalAnnotationRoutes } from "./routes/approvalAnnotations.ts";
import { approvalCommentRoutes } from "./routes/approvalComments.ts";
import { approvalRoutes } from "./routes/approvals.ts";
import { approvalOperationLogRoutes, operationLogRoutes } from "./routes/operationLogs.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { reportRoutes } from "./routes/reports.ts";
import { profileRoutes } from "./routes/profile.ts";
import { signatureTemplateRoutes } from "./routes/signatureTemplates.ts";
import { signatureRoutes } from "./routes/signatures.ts";
import { submissionRoutes } from "./routes/submissions.ts";
import { systemRoutes } from "./routes/system.ts";
import { trayRoutes } from "./routes/tray.ts";
import { userRoutes } from "./routes/users.ts";
import { watchSubmissions } from "./files/watchSubmissions.ts";
import { runDatabaseBackup } from "./services/backupService.ts";
import { executeCleanup } from "./services/cleanupService.ts";
import { createMaintenanceScheduler, readMaintenanceSettings } from "./services/maintenanceScheduler.ts";
import { buildPublicHealth } from "./services/publicHealth.ts";
import type { MailTransport } from "./notifications/email.ts";
import { notifyApprovalCreated } from "./notifications/notifyApprovalCreated.ts";
import { notifyApprovalEvent } from "./notifications/approvalNotifications.ts";
import { notifySystemRiskEvent } from "./notifications/systemRiskNotifications.ts";
import type { NotificationEventKey } from "./repositories/userPreferences.ts";
import type { UpdateManifest } from "./services/updateInfo.ts";

const corsAllowedMethods = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const corsAllowedHeaders = "Content-Type,Authorization";
const startedAt = new Date().toISOString();
type NetworkAddressInfo = { address?: string; family?: string | number; internal?: boolean };

export type ServerDeps = {
  db?: DatabaseConnection;
  approvals?: ApprovalRepository;
  approvalAnnotations?: ApprovalAnnotationRepository;
  approvalComments?: ApprovalCommentRepository;
  backups?: BackupRunRepository;
  batchSubmissions?: BatchSubmissionRepository;
  operationLogs?: OperationLogRepository;
  passwordResetTokens?: PasswordResetTokenRepository;
  scanRuns?: ScanRunRepository;
  signatureAssets?: SignatureAssetRepository;
  signaturePlacements?: SignaturePlacementRepository;
  signatureTemplates?: SignatureTemplateRepository;
  userPreferences?: UserPreferenceRepository;
  users?: UserRepository;
  settings?: SettingsRepository;
  mailTransport?: MailTransport | null;
  startFolderPicker?: () => Promise<{ pickerId: string }>;
  pollFolderPicker?: (pickerId: string) => Promise<
    | { status: "pending" }
    | { status: "selected"; path: string }
    | { status: "cancelled" }
    | { status: "error"; message: string }
  >;
  listDirectories?: (currentPath?: string) => Promise<{
    currentPath: string | null;
    parentPath: string | null;
    entries: Array<{ name: string; path: string }>;
    roots: Array<{ name: string; path: string }>;
  }>;
  logRoot?: string;
  backupRoot?: string;
  lanAddresses?: string[];
  fetchUpdateManifest?: (sourceUrl: string) => Promise<UpdateManifest>;
  restart?: () => void;
};

export function createServer(config: AppConfig, deps: ServerDeps = {}) {
  const db = deps.db ?? createDatabase(config.databasePath);
  const approvals = deps.approvals ?? new ApprovalRepository(db);
  const approvalAnnotations = deps.approvalAnnotations ?? new ApprovalAnnotationRepository(db);
  const approvalComments = deps.approvalComments ?? new ApprovalCommentRepository(db);
  const backups = deps.backups ?? new BackupRunRepository(db);
  const batchSubmissions = deps.batchSubmissions ?? new BatchSubmissionRepository(db);
  const operationLogs = deps.operationLogs ?? new OperationLogRepository(db);
  const passwordResetTokens = deps.passwordResetTokens ?? new PasswordResetTokenRepository(db);
  const scanRuns = deps.scanRuns ?? new ScanRunRepository(db);
  const signatureAssets = deps.signatureAssets ?? new SignatureAssetRepository(db);
  const signaturePlacements = deps.signaturePlacements ?? new SignaturePlacementRepository(db);
  const signatureTemplates = deps.signatureTemplates ?? new SignatureTemplateRepository(db);
  const userPreferences = deps.userPreferences ?? new UserPreferenceRepository(db);
  const users = deps.users ?? new UserRepository(db);
  const settings = deps.settings ?? new SettingsRepository(db);
  users.ensureDefaultUsers();

  const emitApprovalNotification = (
    event: NotificationEventKey,
    approvalId: number,
    actor?: { actorUserId?: number | null; actorUsername?: string | null }
  ) =>
    notifyApprovalEvent({
      event,
      approvalId,
      approvals,
      users,
      userPreferences,
      settings,
      operationLogs,
      transport: deps.mailTransport,
      actorUserId: actor?.actorUserId,
      actorUsername: actor?.actorUsername
    });

  const app = express();
  app.use(applyDesktopClientCors);
  app.use(logSlowApiRequests(resolveSlowRequestThresholdMs()));
  app.use(express.json({ limit: "8mb" }));

  app.get("/health", (_req, res) => {
    res.json(
      buildPublicHealth({
        port: config.port,
        lanAddresses: deps.lanAddresses ?? (process.env.NODE_ENV === "test" ? [] : getLanIPv4Addresses()),
        startedAt
      })
    );
  });

  app.use(
    "/api/auth",
    authRoutes({
      users,
      settings,
      operationLogs,
      passwordResetTokens,
      mailTransport: deps.mailTransport,
      jwtSecret: config.jwtSecret
    })
  );
  app.use(
    "/api/profile",
    profileRoutes({
      users,
      userPreferences,
      settings,
      operationLogs,
      mailTransport: deps.mailTransport,
      jwtSecret: config.jwtSecret
    })
  );
  app.use("/api/tray", trayRoutes({ approvals, backups, settings, signatureAssets, scanRuns, users, jwtSecret: config.jwtSecret }));
  app.use("/api/signatures", signatureRoutes({ signatureAssets, dataDir: config.dataDir, jwtSecret: config.jwtSecret }));
  app.use("/api/signature-templates", signatureTemplateRoutes({ signatureTemplates, jwtSecret: config.jwtSecret }));
  app.use(
    "/api/submissions",
    submissionRoutes({
      approvals,
      batchSubmissions,
      operationLogs,
      settings,
      signaturePlacements,
      notifyApprovalCreated: (approvalId, actor) =>
        emitApprovalNotification("reviewTaskCreated", approvalId, {
          actorUserId: actor?.id ?? null,
          actorUsername: actor?.username ?? null
        }),
      dataDir: config.dataDir,
      jwtSecret: config.jwtSecret
    })
  );
  app.use("/api/users", userRoutes({ users, operationLogs, jwtSecret: config.jwtSecret }));
  app.use(
    "/api/approvals",
    approvalRoutes({
      approvals,
      approvalAnnotations,
      settings,
      operationLogs,
      signatureAssets,
      signaturePlacements,
      signatureTemplates,
      users,
      notifyApprovalEvent: emitApprovalNotification,
      jwtSecret: config.jwtSecret
    })
  );
  app.use(
    "/api/approvals",
    approvalAnnotationRoutes({
      approvals,
      approvalAnnotations,
      operationLogs,
      jwtSecret: config.jwtSecret
    })
  );
  app.use(
    "/api/approvals",
    approvalCommentRoutes({
      approvals,
      approvalComments,
      operationLogs,
      jwtSecret: config.jwtSecret
    })
  );
  app.use("/api/approvals", approvalOperationLogRoutes({ approvals, operationLogs, jwtSecret: config.jwtSecret }));
  app.use("/api/operation-logs", operationLogRoutes({ operationLogs, jwtSecret: config.jwtSecret }));
  app.use("/api/reports", reportRoutes({ db, jwtSecret: config.jwtSecret }));
  app.use(
    "/api/settings",
    settingsRoutes({
      settings,
      operationLogs,
      mailTransport: deps.mailTransport,
      jwtSecret: config.jwtSecret,
      startFolderPicker: deps.startFolderPicker,
      pollFolderPicker: deps.pollFolderPicker,
      listDirectories: deps.listDirectories
    })
  );
  app.use(
    "/api/system",
    systemRoutes({
      approvals,
      backups,
      batchSubmissions,
      db,
      dataDir: config.dataDir,
      databasePath: config.databasePath,
      backupRoot: deps.backupRoot ?? path.resolve("backups"),
      settings,
      operationLogs,
      scanRuns,
      signatureAssets,
      users,
      userPreferences,
      mailTransport: deps.mailTransport,
      notifySystemRiskEvent,
      fetchUpdateManifest: deps.fetchUpdateManifest,
      jwtSecret: config.jwtSecret,
      logRoot: deps.logRoot,
      restart: deps.restart
    })
  );

  const releaseDir = path.resolve(config.releaseDir ?? process.env.PDF_APPROVAL_RELEASE_DIR ?? "dist");
  mountReleaseDirectory(app, "/updates", path.join(releaseDir, "updates"), "UPDATE_FILE_NOT_FOUND");
  mountReleaseDirectory(app, "/installers", path.join(releaseDir, "installers"), "INSTALLER_FILE_NOT_FOUND");

  const clientDist = path.resolve("dist/client");
  app.use(express.static(clientDist));
  app.get("*", (_req, res, next) => {
    res.sendFile(path.join(clientDist, "index.html"), (error) => {
      if (error) next();
    });
  });

  const watchRoot = settings.get("watch_root");
  if (watchRoot && process.env.NODE_ENV !== "test") {
    console.log(`PDF approval watcher active: ${watchRoot}`);
    watchSubmissions({
      watchRoot,
      approvals,
      operationLogs,
      notifyApprovalCreated: async (approvalId) => {
        await notifyApprovalCreated(approvalId, { approvals, users, settings, userPreferences, operationLogs, transport: deps.mailTransport });
      }
    });
  }

  if (process.env.NODE_ENV !== "test") {
    startAutomaticMaintenance({
      approvals,
      backups,
      batchSubmissions,
      backupRoot: deps.backupRoot ?? path.resolve("backups"),
      dataDir: config.dataDir,
      databasePath: config.databasePath,
      operationLogs,
      settings
    });
  }

  return app;
}

function mountReleaseDirectory(app: express.Express, route: string, directory: string, notFoundCode: string) {
  app.use(
    route,
    express.static(directory, {
      fallthrough: true,
      index: false,
      maxAge: "5m"
    })
  );
  app.use(route, (_req, res) => {
    res.status(404).json({ error: notFoundCode });
  });
}

function resolveSlowRequestThresholdMs() {
  const raw = process.env.PDF_APPROVAL_SLOW_REQUEST_MS;
  if (raw === undefined || raw.trim() === "") return 750;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 750;
}

function logSlowApiRequests(thresholdMs: number): express.RequestHandler {
  return (req, res, next) => {
    if (!req.path.startsWith("/api/")) {
      next();
      return;
    }

    const startedAtMs = performance.now();
    const pathLabel = req.originalUrl.split("?")[0];
    res.on("finish", () => {
      const durationMs = Math.round(performance.now() - startedAtMs);
      if (durationMs < thresholdMs) return;
      console.warn(`Slow API request method=${req.method} path=${pathLabel} status=${res.statusCode} durationMs=${durationMs}`);
    });
    next();
  };
}

export function getLanIPv4Addresses(interfaces: Record<string, NetworkAddressInfo[] | undefined> = networkInterfaces()) {
  const addresses = new Set<string>();

  Object.values(interfaces).forEach((entries) => {
    entries?.forEach((entry) => {
      const family = entry.family;
      if (entry.internal || (family !== "IPv4" && family !== 4) || !entry.address) return;
      addresses.add(entry.address);
    });
  });

  return Array.from(addresses).sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function startAutomaticMaintenance(input: {
  approvals: ApprovalRepository;
  backups: BackupRunRepository;
  batchSubmissions: BatchSubmissionRepository;
  backupRoot: string;
  dataDir: string;
  databasePath: string;
  operationLogs: OperationLogRepository;
  settings: SettingsRepository;
}) {
  const scheduler = createMaintenanceScheduler();
  const tick = async () => {
    const maintenance = readMaintenanceSettings((key) => input.settings.get(key));
    const backupResult = await scheduler.runDue("auto_backup", maintenance.autoBackup, async () => {
      const backup = await runDatabaseBackup({
        backups: input.backups,
        databasePath: input.databasePath,
        backupRoot: input.backupRoot,
        triggeredBy: "system"
      });
      input.operationLogs.create({
        actorUserId: null,
        actorUsername: "system",
        action: backup.status === "completed" ? "system.backup_completed" : "system.backup_failed",
        targetType: "backup_run",
        targetId: backup.id,
        message: backup.status === "completed" ? "系统自动创建了数据库备份" : "系统自动备份数据库失败",
        metadata: backup
      });
      if (backup.status !== "completed") throw new Error(backup.errorMessage ?? "AUTO_BACKUP_FAILED");
    });

    if (backupResult.status === "failed") {
      input.operationLogs.create({
        actorUserId: null,
        actorUsername: "system",
        action: "system.backup_failed",
        targetType: "system",
        targetId: null,
        message: "系统自动备份调度失败",
        metadata: backupResult
      });
    }

    const cleanupResult = await scheduler.runDue("auto_cleanup", maintenance.autoCleanup, async () => {
      const cleanup = await executeCleanup({
        dataDir: input.dataDir,
        watchRoot: input.settings.get("watch_root"),
        approvals: input.approvals,
        batchSubmissions: input.batchSubmissions
      });
      input.operationLogs.create({
        actorUserId: null,
        actorUsername: "system",
        action: "system.cleanup_executed",
        targetType: "system",
        targetId: null,
        message: "系统自动执行了清理维护",
        metadata: cleanup
      });
    });

    if (cleanupResult.status === "failed") {
      input.operationLogs.create({
        actorUserId: null,
        actorUsername: "system",
        action: "system.cleanup_failed",
        targetType: "system",
        targetId: null,
        message: "系统自动清理调度失败",
        metadata: cleanupResult
      });
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, 60_000);
  timer.unref?.();
  void tick();
}

function applyDesktopClientCors(req: express.Request, res: express.Response, next: express.NextFunction) {
  const origin = req.get("origin");
  if (origin && isAllowedDesktopClientOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", corsAllowedMethods);
    res.setHeader("Access-Control-Allow-Headers", corsAllowedHeaders);
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
}

function isAllowedDesktopClientOrigin(origin: string) {
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost") return true;

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return false;
  }
}
