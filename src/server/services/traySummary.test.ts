import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { BackupRunRepository } from "../repositories/backups.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { getTraySummary } from "./traySummary.ts";

function context() {
  const db = createDatabase(":memory:");
  return {
    approvals: new ApprovalRepository(db),
    backups: new BackupRunRepository(db),
    settings: new SettingsRepository(db),
    signatureAssets: new SignatureAssetRepository(db)
  };
}

describe("getTraySummary", () => {
  it("returns only process pending tasks for process users", async () => {
    const deps = context();
    const first = deps.approvals.create({
      projectName: "300A",
      partName: "固定支持支架",
      version: "a0A0",
      minorVersion: "0",
      majorVersion: "A0",
      originalFilePath: "a.pdf",
      currentFilePath: "a.pdf",
      submittedBy: "designer"
    });
    deps.approvals.create({
      projectName: "300A",
      partName: "已审件",
      version: "a1A0",
      minorVersion: "1",
      majorVersion: "A0",
      originalFilePath: "b.pdf",
      currentFilePath: "b.pdf",
      submittedBy: "designer"
    });
    deps.approvals.review(first.id, { role: "supervisor", decision: "approved" });

    const summary = await getTraySummary({
      ...deps,
      user: { id: 2, username: "process", displayName: "工艺", role: "process" }
    });

    expect(summary.tasks.pendingCount).toBe(2);
    expect(summary.tasks.latestIds).toHaveLength(2);
    expect(summary.tasks.latest[0]).toMatchObject({ projectName: "300A", href: expect.stringMatching(/^#\/approvals\//) });
  });

  it("returns no reviewer tasks for designers", async () => {
    const deps = context();
    deps.approvals.create({
      projectName: "300A",
      partName: "固定支持支架",
      version: "a0A0",
      minorVersion: "0",
      majorVersion: "A0",
      originalFilePath: "a.pdf",
      currentFilePath: "a.pdf",
      submittedBy: "designer"
    });

    const summary = await getTraySummary({
      ...deps,
      user: { id: 3, username: "designer", displayName: "设计师", role: "designer" }
    });

    expect(summary.tasks.pendingCount).toBe(0);
    expect(summary.tasks.latestIds).toEqual([]);
  });

  it("includes admin risk summary for admins", async () => {
    const deps = context();
    const summary = await getTraySummary({
      ...deps,
      user: { id: 1, username: "admin", displayName: "管理员", role: "admin" }
    });

    expect(summary.admin).toEqual(expect.objectContaining({ riskCount: expect.any(Number), overallStatus: expect.any(String) }));
  });
});
