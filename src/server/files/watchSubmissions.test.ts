import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { processDeletedFile, scanMissingApprovalFiles, scanSubmittedFiles, processSubmittedFile } from "./watchSubmissions.ts";

async function setup() {
  const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-watch-"));
  const projectDir = path.join(watchRoot, "01-待提交", "项目A");
  await fs.mkdir(projectDir, { recursive: true });
  const db = createDatabase(":memory:");
  return {
    watchRoot,
    projectDir,
    approvals: new ApprovalRepository(db),
    operationLogs: new OperationLogRepository(db)
  };
}

describe("processSubmittedFile", () => {
  it("creates an approval and moves a valid PDF to reviewing folder", async () => {
    const context = await setup();
    const file = path.join(context.projectDir, "轴承座-a0A0.pdf");
    await fs.writeFile(file, "%PDF-1.7\n");

    const result = await processSubmittedFile(file, {
      ...context,
      waitForStable: async () => ({ ok: true })
    });

    expect(result.processed).toBe(true);
    expect(context.approvals.list()).toHaveLength(1);
    expect(context.approvals.list()[0].projectName).toBe("项目A");
    expect(context.approvals.list()[0].source).toBe("folder_watch");
    expect(context.approvals.list()[0].signatureStatus).toBe("placement_required");
    expect(context.operationLogs.listRecent().map((log) => log.action)).toContain("approval.created");
    await expect(fs.stat(path.join(context.watchRoot, "02-审批中", "项目A", "轴承座-a0A0.pdf"))).resolves.toBeTruthy();
  });

  it("accepts PDFs placed directly in the watch root as default project", async () => {
    const context = await setup();
    const file = path.join(context.watchRoot, "301新光纤-a0A0.pdf");
    await fs.writeFile(file, "%PDF-1.7\n");

    const result = await processSubmittedFile(file, {
      ...context,
      waitForStable: async () => ({ ok: true })
    });

    expect(result.processed).toBe(true);
    expect(context.approvals.list()[0].projectName).toBe("默认项目");
    await expect(fs.stat(path.join(context.watchRoot, "02-审批中", "默认项目", "301新光纤-a0A0.pdf"))).resolves.toBeTruthy();
  });

  it("ignores files already inside managed status folders", async () => {
    const context = await setup();
    const approvedDir = path.join(context.watchRoot, "04-已通过待打印", "项目A");
    await fs.mkdir(approvedDir, { recursive: true });
    const file = path.join(approvedDir, "轴承座-a0A0.pdf");
    await fs.writeFile(file, "%PDF-1.7\n");

    const result = await processSubmittedFile(file, {
      ...context,
      waitForStable: async () => ({ ok: true })
    });

    expect(result).toEqual({ processed: false, reason: "managed_status_file" });
    expect(context.approvals.list()).toHaveLength(0);
  });

  it("records invalid file names without moving them to reviewing", async () => {
    const context = await setup();
    const file = path.join(context.projectDir, "轴承座-v1.pdf");
    await fs.writeFile(file, "%PDF-1.7\n");

    await processSubmittedFile(file, { ...context, waitForStable: async () => ({ ok: true }) });

    expect(context.approvals.list()[0].status).toBe("filename_invalid");
    await expect(fs.stat(file)).resolves.toBeTruthy();
  });

  it("does not repeatedly create invalid filename approvals during fallback scans", async () => {
    const context = await setup();
    const file = path.join(context.projectDir, "轴承座-v1.pdf");
    await fs.writeFile(file, "%PDF-1.7\n");

    const first = await processSubmittedFile(file, { ...context, waitForStable: async () => ({ ok: true }) });
    const second = await processSubmittedFile(file, { ...context, waitForStable: async () => ({ ok: true }) });

    expect(first.processed).toBe(true);
    expect(second).toEqual({ processed: false, reason: "duplicate" });
    expect(context.approvals.list({ status: "filename_invalid" as never })).toHaveLength(1);
  });

  it("ignores duplicate project part and version", async () => {
    const context = await setup();
    const first = path.join(context.projectDir, "轴承座-a0A0.pdf");
    const second = path.join(context.projectDir, "轴承座-a0A0.pdf");
    await fs.writeFile(first, "%PDF-1.7\n");

    await processSubmittedFile(first, { ...context, waitForStable: async () => ({ ok: true }) });
    await fs.writeFile(second, "pdf2");
    const result = await processSubmittedFile(second, { ...context, waitForStable: async () => ({ ok: true }) });

    expect(result).toEqual({ processed: false, reason: "duplicate" });
    expect(context.approvals.list()).toHaveLength(1);
  });

  it("marks a pending approval as file missing when its current file is deleted", async () => {
    const context = await setup();
    const file = path.join(context.projectDir, "轴承座-a0A0.pdf");
    await fs.writeFile(file, "%PDF-1.7\n");
    const created = await processSubmittedFile(file, { ...context, waitForStable: async () => ({ ok: true }) });
    if (!created.processed || !("approval" in created)) throw new Error("approval not created");

    const result = processDeletedFile(created.approval.currentFilePath, context);

    expect(result).toEqual({ processed: true, approvalId: created.approval.id });
    expect(context.approvals.getById(created.approval.id)?.status).toBe("file_missing");
    expect(context.operationLogs.listForTarget("approval", created.approval.id).map((log) => log.action)).toContain("approval.file_missing");
  });

  it("scans existing submitted PDFs as a fallback when file watcher misses add events", async () => {
    const context = await setup();
    const file = path.join(context.projectDir, "扫描补偿-a0A0.pdf");
    await fs.writeFile(file, "%PDF-1.7\n");

    const result = await scanSubmittedFiles({
      ...context,
      waitForStable: async () => ({ ok: true })
    });

    expect(result.processed).toBe(1);
    expect(context.approvals.list()[0].partName).toBe("扫描补偿");
  });

  it("marks missing pending files during fallback scans", async () => {
    const context = await setup();
    const file = path.join(context.projectDir, "离线删除-a0A0.pdf");
    await fs.writeFile(file, "%PDF-1.7\n");
    const created = await processSubmittedFile(file, { ...context, waitForStable: async () => ({ ok: true }) });
    if (!created.processed || !("approval" in created)) throw new Error("approval not created");
    await fs.rm(created.approval.currentFilePath);

    const result = await scanMissingApprovalFiles(context);

    expect(result.markedMissing).toBe(1);
    expect(context.approvals.getById(created.approval.id)?.status).toBe("file_missing");
  });

  it("does not count stale approvals deleted by admins during fallback scans", async () => {
    const context = await setup();
    const staleApproval = context.approvals.create({
      projectName: "项目A",
      partName: "管理员删除",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: path.join(context.projectDir, "管理员删除-a0A0.pdf"),
      currentFilePath: path.join(context.watchRoot, "02-审批中", "项目A", "管理员删除-a0A0.pdf")
    });
    const staleApprovals = {
      list: () => [staleApproval],
      markFileMissing: (id: number) => context.approvals.markFileMissing(id)
    };
    context.approvals.delete(staleApproval.id);

    const result = await scanMissingApprovalFiles({
      ...context,
      approvals: staleApprovals as never
    });

    expect(result.markedMissing).toBe(0);
    expect(context.operationLogs.listRecent()).toEqual([]);
  });

  it("records invalid PDFs without moving them into the review folder", async () => {
    const context = await setup();
    const file = path.join(context.projectDir, "无效内容-a0A0.pdf");
    await fs.writeFile(file, "not a real pdf");

    const result = await processSubmittedFile(file, {
      ...context,
      waitForStable: async () => ({ ok: true })
    });

    expect(result.processed).toBe(true);
    expect(context.approvals.list()).toHaveLength(1);
    expect(context.approvals.list()[0].status).toBe("invalid_pdf");
    expect(context.approvals.list({ reviewerRole: "supervisor" })).toEqual([]);
    expect(context.approvals.list({ reviewerRole: "process" })).toEqual([]);
    await expect(fs.stat(file)).resolves.toBeTruthy();
    await expect(fs.stat(path.join(context.watchRoot, "02-审批中", "项目A", "无效内容-a0A0.pdf"))).rejects.toBeTruthy();
  });
});
