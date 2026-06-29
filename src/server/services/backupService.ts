import fs from "node:fs/promises";
import path from "node:path";
import type { BackupRun, BackupRunRepository } from "../repositories/backups.ts";

export async function runDatabaseBackup(input: {
  backups: BackupRunRepository;
  databasePath: string;
  backupRoot: string;
  triggeredBy: string;
}): Promise<BackupRun> {
  const run = input.backups.start(input.triggeredBy);

  try {
    await assertFileExists(input.databasePath);
    const backupPath = await createBackupDirectory(input.backupRoot);
    const sourceFiles = [input.databasePath, `${input.databasePath}-wal`, `${input.databasePath}-shm`];
    let copied = 0;

    for (const source of sourceFiles) {
      if (await fileExists(source)) {
        await fs.copyFile(source, path.join(backupPath, path.basename(source)));
        copied += 1;
      }
    }

    if (copied === 0) {
      return input.backups.fail(run.id, "No database files were copied.");
    }

    return input.backups.complete(run.id, backupPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "BACKUP_FAILED";
    return input.backups.fail(run.id, message);
  }
}

async function assertFileExists(filePath: string) {
  if (!(await fileExists(filePath))) {
    throw new Error(`Database file not found: ${filePath}`);
  }
}

async function fileExists(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function createBackupDirectory(backupRoot: string) {
  await fs.mkdir(backupRoot, { recursive: true });
  const timestamp = formatBackupTimestamp(new Date());
  const basePath = path.join(backupRoot, `pdf-approval-${timestamp}`);

  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? basePath : `${basePath}-${index}`;
    try {
      await fs.mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  throw new Error("Unable to create unique backup directory.");
}

function formatBackupTimestamp(date: Date) {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear().toString(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}
