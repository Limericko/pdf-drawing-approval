import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { BackupRunRepository } from "../repositories/backups.ts";
import { runDatabaseBackup } from "./backupService.ts";

describe("backup service", () => {
  it("copies SQLite database files and records a completed backup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-backup-"));
    const databasePath = path.join(root, "pdf-approval.sqlite");
    await fs.writeFile(databasePath, "main-db");
    await fs.writeFile(`${databasePath}-wal`, "wal");
    await fs.writeFile(`${databasePath}-shm`, "shm");
    const db = createDatabase(":memory:");
    const backups = new BackupRunRepository(db);

    const result = await runDatabaseBackup({
      backups,
      databasePath,
      backupRoot: path.join(root, "backups"),
      triggeredBy: "admin"
    });

    expect(result.status).toBe("completed");
    expect(result.backupPath).toContain("pdf-approval-");
    await expect(fs.readFile(path.join(result.backupPath!, "pdf-approval.sqlite"), "utf8")).resolves.toBe("main-db");
    await expect(fs.readFile(path.join(result.backupPath!, "pdf-approval.sqlite-wal"), "utf8")).resolves.toBe("wal");
    await expect(fs.readFile(path.join(result.backupPath!, "pdf-approval.sqlite-shm"), "utf8")).resolves.toBe("shm");
  });

  it("records a failed backup when the database file is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-backup-missing-"));
    const db = createDatabase(":memory:");
    const backups = new BackupRunRepository(db);

    const result = await runDatabaseBackup({
      backups,
      databasePath: path.join(root, "missing.sqlite"),
      backupRoot: path.join(root, "backups"),
      triggeredBy: "admin"
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Database file not found");
  });
});
