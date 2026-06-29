import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { folders } from "../files/fileLocations.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { BatchSubmissionRepository } from "../repositories/batchSubmissions.ts";
import { UserRepository } from "../repositories/users.ts";
import { saveTempUpload } from "../uploads/tempUploads.ts";
import { executeCleanup, previewCleanup } from "./cleanupService.ts";

describe("cleanupService", () => {
  it("previews and executes conservative cleanup candidates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-cleanup-"));
    const dataDir = path.join(root, "data");
    const watchRoot = path.join(root, "watch");
    const approvedDir = path.join(watchRoot, folders.approvedForPrint, "项目A");
    await fs.mkdir(approvedDir, { recursive: true });
    const db = createDatabase(":memory:");
    const approvals = new ApprovalRepository(db);
    const batchSubmissions = new BatchSubmissionRepository(db);
    const users = new UserRepository(db);
    const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
    const approval = approvals.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: path.join(watchRoot, folders.reviewing, "项目A", "轴承座-a0A0.pdf"),
      currentFilePath: path.join(watchRoot, folders.reviewing, "项目A", "轴承座-a0A0.pdf")
    });
    const referencedSigned = path.join(approvedDir, "轴承座-a0A0-签审.pdf");
    const staleSigned = path.join(approvedDir, "轴承座-a0A0-旧-签审.pdf");
    await fs.writeFile(referencedSigned, "%PDF-1.7\n");
    await fs.writeFile(staleSigned, "%PDF-1.7\n");
    approvals.setSignedFile(approval.id, referencedSigned, "hash");

    const upload = await saveTempUpload({ rootDir: dataDir, originalName: "临时-a0A0.pdf", buffer: Buffer.from("%PDF-1.7\n") });
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(path.dirname(upload.filePath), oldDate, oldDate);
    await fs.utimes(staleSigned, oldDate, oldDate);
    await fs.utimes(referencedSigned, oldDate, oldDate);

    const oldBatch = batchSubmissions.start({ projectName: "项目A", totalCount: 1, createdByUserId: designer.id });
    batchSubmissions.fail(oldBatch.id, "INVALID_PDF_FILE");
    db.prepare("UPDATE batch_submissions SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", oldBatch.id);

    const input = {
      dataDir,
      watchRoot,
      approvals,
      batchSubmissions,
      now: new Date("2026-03-01T00:00:00.000Z"),
      tempUploadMaxAgeMs: 24 * 60 * 60 * 1000,
      failedBatchMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
      signedPdfMaxAgeMs: 30 * 24 * 60 * 60 * 1000
    };

    const preview = await previewCleanup(input);
    expect(preview.executed).toBe(false);
    expect(preview.tempUploads.count).toBe(1);
    expect(preview.failedBatchSubmissions.count).toBe(1);
    expect(preview.oldSignedPdfs.files).toEqual([staleSigned]);
    await expect(fs.stat(staleSigned)).resolves.toBeTruthy();
    await expect(fs.stat(referencedSigned)).resolves.toBeTruthy();

    const executed = await executeCleanup(input);
    expect(executed.executed).toBe(true);
    expect(executed.tempUploads.count).toBe(1);
    expect(executed.failedBatchSubmissions.count).toBe(1);
    expect(executed.oldSignedPdfs.files).toEqual([staleSigned]);
    await expect(fs.stat(staleSigned)).rejects.toThrow();
    await expect(fs.stat(referencedSigned)).resolves.toBeTruthy();
    expect(batchSubmissions.listRecent()).toEqual([]);
  });
});
