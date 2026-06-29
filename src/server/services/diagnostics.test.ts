import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { BackupRunRepository } from "../repositories/backups.ts";
import { ScanRunRepository } from "../repositories/scanRuns.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { getSystemDiagnostics } from "./diagnostics.ts";

describe("system diagnostics", () => {
  it("reports database, watch root, standard folders, write permissions, latest scan and backup", async () => {
    const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-diagnostics-"));
    for (const folder of ["01-待提交", "02-审批中", "03-已驳回", "04-已通过待打印", "05-已打印归档"]) {
      await fs.mkdir(path.join(watchRoot, folder), { recursive: true });
    }

    const db = createDatabase(":memory:");
    const settings = new SettingsRepository(db);
    const scanRuns = new ScanRunRepository(db);
    const backups = new BackupRunRepository(db);
    settings.set("watch_root", watchRoot);
    const scan = scanRuns.start("admin");
    scanRuns.complete(scan.id, { processedCount: 2, missingCount: 1, invalidCount: 0 });
    const backup = backups.start("admin");
    backups.complete(backup.id, path.join(os.tmpdir(), "backup"));
    const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-logs-"));
    await fs.writeFile(path.join(logRoot, "server.log"), "server started\n");
    await fs.writeFile(path.join(logRoot, "server.err.log"), "");

    const diagnostics = await getSystemDiagnostics({
      db,
      settings,
      scanRuns,
      backups,
      logRoot,
      serviceStartedAt: "2026-06-16T00:00:00.000Z"
    });

    expect(diagnostics.overallStatus).toBe("ok");
    expect(diagnostics.database.ok).toBe(true);
    expect(diagnostics.watchRoot.exists).toBe(true);
    expect(diagnostics.standardFolders.every((folder) => folder.exists)).toBe(true);
    expect(diagnostics.writePermissions.every((item) => item.writable)).toBe(true);
    expect(diagnostics.latestScan?.id).toBe(scan.id);
    expect(diagnostics.latestBackup?.id).toBe(backup.id);
    expect(diagnostics.logs.every((log) => log.readable)).toBe(true);
    expect(diagnostics.service.startedAt).toBe("2026-06-16T00:00:00.000Z");
  });

  it("reports warnings when watch root is missing", async () => {
    const db = createDatabase(":memory:");
    const settings = new SettingsRepository(db);
    const scanRuns = new ScanRunRepository(db);
    const backups = new BackupRunRepository(db);
    settings.set("watch_root", path.join(os.tmpdir(), "missing-pdf-approval-root"));

    const diagnostics = await getSystemDiagnostics({ db, settings, scanRuns, backups });

    expect(diagnostics.overallStatus).toBe("warn");
    expect(diagnostics.watchRoot.exists).toBe(false);
    expect(diagnostics.standardFolders.every((folder) => !folder.exists)).toBe(true);
  });
});
