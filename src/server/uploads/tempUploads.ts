import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type TempUpload = {
  uploadId: string;
  originalName: string;
  filePath: string;
  createdAt: string;
};

type TempUploadMeta = Omit<TempUpload, "filePath">;

export async function saveTempUpload(input: { rootDir: string; originalName: string; buffer: Buffer }): Promise<TempUpload> {
  const uploadId = `upload-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const uploadDir = uploadDirectory(input.rootDir, uploadId);
  const safeName = safeFileName(input.originalName);
  const filePath = path.join(uploadDir, safeName);
  const createdAt = new Date().toISOString();

  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(filePath, input.buffer);
  await fs.writeFile(metaPath(uploadDir), JSON.stringify({ uploadId, originalName: input.originalName, createdAt }, null, 2), "utf8");

  return { uploadId, originalName: input.originalName, filePath, createdAt };
}

export async function getTempUpload(rootDir: string, uploadId: string): Promise<TempUpload> {
  const uploadDir = uploadDirectory(rootDir, uploadId);
  try {
    const meta = JSON.parse(await fs.readFile(metaPath(uploadDir), "utf8")) as TempUploadMeta;
    return {
      ...meta,
      filePath: path.join(uploadDir, safeFileName(meta.originalName))
    };
  } catch {
    throw new Error("UPLOAD_NOT_FOUND");
  }
}

export async function deleteTempUpload(rootDir: string, uploadId: string): Promise<void> {
  await fs.rm(uploadDirectory(rootDir, uploadId), { recursive: true, force: true });
}

export async function cleanupTempUploads(rootDir: string, maxAgeMs: number): Promise<number> {
  const tmpRoot = tempRoot(rootDir);
  const entries = await fs.readdir(tmpRoot, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(tmpRoot, entry.name);
    const stats = await fs.stat(entryPath);
    if (stats.mtimeMs >= cutoff) continue;
    await fs.rm(entryPath, { recursive: true, force: true });
    removed += 1;
  }

  return removed;
}

function tempRoot(rootDir: string) {
  return path.join(rootDir, "uploads", "tmp");
}

function uploadDirectory(rootDir: string, uploadId: string) {
  return path.join(tempRoot(rootDir), uploadId);
}

function metaPath(uploadDir: string) {
  return path.join(uploadDir, "upload.json");
}

function safeFileName(fileName: string) {
  return path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}
