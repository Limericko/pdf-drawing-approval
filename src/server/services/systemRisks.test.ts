import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { BackupRunRepository } from "../repositories/backups.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { UserRepository } from "../repositories/users.ts";
import { getSystemRisks } from "./systemRisks.ts";

function repositories() {
  const db = createDatabase(":memory:");
  return {
    db,
    approvals: new ApprovalRepository(db),
    backups: new BackupRunRepository(db),
    settings: new SettingsRepository(db),
    signatureAssets: new SignatureAssetRepository(db),
    users: new UserRepository(db)
  };
}

describe("getSystemRisks", () => {
  it("reports missing watch root as an abnormal risk", async () => {
    const context = repositories();

    const risks = await getSystemRisks(context);

    expect(risks).toContainEqual(
      expect.objectContaining({
        key: "watch_root_missing",
        level: "error",
        title: "审批根目录未配置",
        href: "#/settings"
      })
    );
  });

  it("reports missing standard directories as an abnormal risk", async () => {
    const context = repositories();
    const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-risk-"));
    await fs.mkdir(path.join(watchRoot, "01-待提交"), { recursive: true });
    context.settings.set("watch_root", watchRoot);

    const risks = await getSystemRisks(context);

    expect(risks).toContainEqual(
      expect.objectContaining({
        key: "standard_folders_missing",
        level: "error",
        count: 4
      })
    );
  });

  it("warns when the latest completed backup is older than the threshold", async () => {
    const context = repositories();
    const backup = context.backups.complete(context.backups.start("admin").id, "G:\\backups\\old.sqlite");
    context.db
      .prepare("UPDATE backup_runs SET started_at = ?, finished_at = ? WHERE id = ?")
      .run("2026-05-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", backup.id);

    const risks = await getSystemRisks({ ...context, now: new Date("2026-06-18T00:00:00.000Z"), backupMaxAgeDays: 7 });

    expect(risks).toContainEqual(
      expect.objectContaining({
        key: "backup_overdue",
        level: "warning",
        href: "#/settings"
      })
    );
  });

  it("reports file missing and invalid PDF approvals with counts and links", async () => {
    const context = repositories();
    const filePath = "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a0A0.pdf";
    const missing = context.approvals.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: filePath,
      currentFilePath: filePath
    });
    context.approvals.markFileMissing(missing.id);
    context.approvals.create({
      projectName: "项目A",
      partName: "端盖",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: filePath,
      currentFilePath: filePath,
      status: "invalid_pdf"
    });

    const risks = await getSystemRisks(context);

    expect(risks).toContainEqual(
      expect.objectContaining({ key: "file_missing", level: "error", count: 1, href: "#/approvals?status=file_missing" })
    );
    expect(risks).toContainEqual(
      expect.objectContaining({ key: "invalid_pdf", level: "error", count: 1, href: "#/approvals?status=invalid_pdf" })
    );
  });

  it("reports failed signature generation approvals with a count", async () => {
    const context = repositories();
    const approval = context.approvals.create({
      projectName: "项目A",
      partName: "签名件",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "G:\\Nutstore\\04-已通过待打印\\项目A\\签名件-a0A0.pdf",
      currentFilePath: "G:\\Nutstore\\04-已通过待打印\\项目A\\签名件-a0A0.pdf",
      status: "approved_for_print",
      signatureStatus: "pending"
    });
    context.approvals.setSignatureStatus(approval.id, "failed", "MISSING_SIGNATURE");

    const risks = await getSystemRisks(context);

    expect(risks).toContainEqual(
      expect.objectContaining({ key: "signature_failed", level: "error", count: 1, href: "#/approvals?signatureStatus=failed" })
    );
  });

  it("warns when key role signatures are missing", async () => {
    const context = repositories();
    context.users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
    context.users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
    context.users.create({ username: "process", password: "123456", role: "process", displayName: "工艺" });

    const risks = await getSystemRisks(context);

    expect(risks).toContainEqual(
      expect.objectContaining({
        key: "key_signatures_missing",
        level: "warning",
        count: 3,
        href: "#/settings"
      })
    );
  });

  it("warns when the deployment is still using the default JWT secret", async () => {
    const context = repositories();

    const risks = await getSystemRisks({ ...context, jwtSecret: "change-this-before-production" });

    expect(risks).toContainEqual(
      expect.objectContaining({
        key: "default_jwt_secret",
        level: "warning",
        title: "登录密钥仍是默认值",
        href: "#/settings"
      })
    );
  });

  it("warns when active default accounts still use factory passwords", async () => {
    const context = repositories();
    context.users.ensureDefaultUsers();

    const risks = await getSystemRisks(context);

    expect(risks).toContainEqual(
      expect.objectContaining({
        key: "default_credentials_active",
        level: "warning",
        count: 3,
        href: "#/settings"
      })
    );
  });
});
