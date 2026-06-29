import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBackupDirectory } from "./backupValidation.ts";

describe("validateBackupDirectory", () => {
  it("accepts a backup with a readable sqlite file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-backup-valid-"));
    await fs.writeFile(path.join(root, "pdf-approval.sqlite"), "SQLite format 3\u0000");

    await expect(validateBackupDirectory(root)).resolves.toEqual({
      ok: true,
      files: ["pdf-approval.sqlite"],
      message: "备份目录可读取。"
    });
  });

  it("rejects incomplete backup directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-backup-incomplete-"));
    await fs.writeFile(path.join(root, "note.txt"), "not a database");

    await expect(validateBackupDirectory(root)).resolves.toEqual({
      ok: false,
      files: ["note.txt"],
      message: "备份目录缺少 pdf-approval.sqlite。"
    });
  });

  it("handles unreadable or missing backup directories", async () => {
    const root = path.join(os.tmpdir(), `pdf-approval-backup-missing-${Date.now()}`);

    await expect(validateBackupDirectory(root)).resolves.toEqual({
      ok: false,
      files: [],
      message: "备份目录不可读取。"
    });
  });
});
