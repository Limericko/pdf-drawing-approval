import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseConnection } from "../db.ts";
import { folders } from "../files/fileLocations.ts";
import type { BackupRunRepository, BackupRun } from "../repositories/backups.ts";
import type { ScanRunRepository, ScanRun } from "../repositories/scanRuns.ts";
import type { SettingsRepository } from "../repositories/settings.ts";

export type SystemDiagnostics = {
  overallStatus: "ok" | "warn";
  database: { ok: boolean; error: string | null };
  watchRoot: { path: string | null; configured: boolean; exists: boolean };
  standardFolders: Array<{ name: string; path: string | null; exists: boolean }>;
  writePermissions: Array<{ name: string; path: string; writable: boolean; error: string | null }>;
  latestScan: ScanRun | null;
  latestBackup: BackupRun | null;
  logs: Array<{ name: string; path: string; readable: boolean; error: string | null }>;
  service: { startedAt: string; uptimeSeconds: number };
};

const standardFolderNames = Object.values(folders);
const defaultServiceStartedAt = new Date().toISOString();

export async function getSystemDiagnostics(input: {
  db: DatabaseConnection;
  settings: SettingsRepository;
  scanRuns: ScanRunRepository;
  backups: BackupRunRepository;
  logRoot?: string;
  serviceStartedAt?: string;
}): Promise<SystemDiagnostics> {
  const database = checkDatabase(input.db);
  const watchRootPath = input.settings.get("watch_root");
  const watchRootExists = watchRootPath ? await directoryExists(watchRootPath) : false;
  const standardFolders = await Promise.all(
    standardFolderNames.map(async (name) => {
      const folderPath = watchRootPath ? path.join(watchRootPath, name) : null;
      return {
        name,
        path: folderPath,
        exists: folderPath ? await directoryExists(folderPath) : false
      };
    })
  );
  const writableFolders = standardFolders.flatMap((folder) =>
    folder.path && folder.exists ? [{ name: folder.name, path: folder.path }] : []
  );
  const writePermissions = await Promise.all(writableFolders.map((folder) => checkWritePermission(folder.name, folder.path)));
  const latestScan = input.scanRuns.listRecent(1)[0] ?? null;
  const latestBackup = input.backups.listRecent(1)[0] ?? null;
  const logs = await checkServiceLogs(input.logRoot ?? process.cwd());
  const serviceStartedAt = input.serviceStartedAt ?? defaultServiceStartedAt;
  const overallStatus =
    database.ok &&
    Boolean(watchRootPath) &&
    watchRootExists &&
    standardFolders.every((folder) => folder.exists) &&
    writePermissions.every((permission) => permission.writable)
      ? "ok"
      : "warn";

  return {
    overallStatus,
    database,
    watchRoot: {
      path: watchRootPath,
      configured: Boolean(watchRootPath),
      exists: watchRootExists
    },
    standardFolders,
    writePermissions,
    latestScan,
    latestBackup,
    logs,
    service: {
      startedAt: serviceStartedAt,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(serviceStartedAt)) / 1000))
    }
  };
}

function checkDatabase(db: DatabaseConnection): { ok: boolean; error: string | null } {
  try {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS diagnostics_probe (id INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO diagnostics_probe DEFAULT VALUES").run();
    db.prepare("DELETE FROM diagnostics_probe").run();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "DATABASE_CHECK_FAILED" };
  }
}

async function directoryExists(directoryPath: string) {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function checkWritePermission(name: string, directoryPath: string) {
  const probePath = path.join(directoryPath, `.pdf-approval-write-test-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(probePath, "ok");
    await fs.unlink(probePath);
    return { name, path: directoryPath, writable: true, error: null };
  } catch (error) {
    await fs.unlink(probePath).catch(() => undefined);
    return {
      name,
      path: directoryPath,
      writable: false,
      error: error instanceof Error ? error.message : "WRITE_CHECK_FAILED"
    };
  }
}

async function checkServiceLogs(logRoot: string) {
  return Promise.all(
    ["server.log", "server.err.log"].map(async (name) => {
      const filePath = path.join(logRoot, name);
      try {
        await fs.access(filePath);
        return { name, path: filePath, readable: true, error: null };
      } catch (error) {
        return {
          name,
          path: filePath,
          readable: false,
          error: error instanceof Error ? error.message : "LOG_NOT_READABLE"
        };
      }
    })
  );
}
