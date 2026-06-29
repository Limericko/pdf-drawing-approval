import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { BackupRunRepository } from "./backups.ts";

describe("backup run repository", () => {
  it("records completed and failed backup runs", () => {
    const db = createDatabase(":memory:");
    const backups = new BackupRunRepository(db);

    const completed = backups.complete(backups.start("admin").id, "backups/pdf-approval-20260616-120000");
    const failed = backups.fail(backups.start("system").id, "Database file not found");

    expect(completed.status).toBe("completed");
    expect(completed.backupPath).toContain("pdf-approval");
    expect(completed.finishedAt).toBeTruthy();
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("Database file not found");
    expect(backups.listRecent().map((run) => run.status)).toEqual(["failed", "completed"]);
  });
});
