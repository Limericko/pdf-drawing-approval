import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempUploads, deleteTempUpload, getTempUpload, saveTempUpload } from "./tempUploads.ts";

describe("tempUploads", () => {
  it("saves an uploaded PDF buffer and resolves the upload id", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-upload-"));

    const upload = await saveTempUpload({
      rootDir,
      originalName: "轴承座-a0A0.pdf",
      buffer: Buffer.from("%PDF-1.7\n")
    });

    expect(upload.uploadId).toMatch(/^upload-/);
    expect(upload.originalName).toBe("轴承座-a0A0.pdf");
    await expect(fs.readFile(upload.filePath, "utf8")).resolves.toContain("%PDF-1.7");
    await expect(getTempUpload(rootDir, upload.uploadId)).resolves.toEqual(upload);
  });

  it("rejects unknown upload ids", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-upload-"));

    await expect(getTempUpload(rootDir, "upload-missing")).rejects.toThrow("UPLOAD_NOT_FOUND");
  });

  it("deletes one temp upload", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-upload-"));
    const upload = await saveTempUpload({
      rootDir,
      originalName: "轴承座-a0A0.pdf",
      buffer: Buffer.from("%PDF-1.7\n")
    });

    await deleteTempUpload(rootDir, upload.uploadId);

    await expect(getTempUpload(rootDir, upload.uploadId)).rejects.toThrow("UPLOAD_NOT_FOUND");
  });

  it("cleans up old temp uploads", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-upload-"));
    const upload = await saveTempUpload({
      rootDir,
      originalName: "轴承座-a0A0.pdf",
      buffer: Buffer.from("%PDF-1.7\n")
    });
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(path.dirname(upload.filePath), old, old);

    const removed = await cleanupTempUploads(rootDir, 1_000);

    expect(removed).toBe(1);
    await expect(getTempUpload(rootDir, upload.uploadId)).rejects.toThrow("UPLOAD_NOT_FOUND");
  });
});
