import fs from "node:fs/promises";
import path from "node:path";

export type BackupValidationResult = {
  ok: boolean;
  files: string[];
  message: string;
};

const requiredDatabaseFile = "pdf-approval.sqlite";

export async function validateBackupDirectory(root: string): Promise<BackupValidationResult> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));

    if (!files.includes(requiredDatabaseFile)) {
      return {
        ok: false,
        files,
        message: "备份目录缺少 pdf-approval.sqlite。"
      };
    }

    const databasePath = path.join(root, requiredDatabaseFile);
    await fs.access(databasePath);
    return {
      ok: true,
      files,
      message: "备份目录可读取。"
    };
  } catch {
    return {
      ok: false,
      files: [],
      message: "备份目录不可读取。"
    };
  }
}
