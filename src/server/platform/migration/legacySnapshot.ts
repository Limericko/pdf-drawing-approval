import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export async function createLegacySnapshot(input: {
  readonly sourcePath: string;
  readonly targetPath: string;
}) {
  const sourcePath = await existingRegularFile(input?.sourcePath, "sourcePath");
  const targetPath = validateTarget(input?.targetPath, sourcePath);
  await assertMissing(targetPath);
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(sourcePath, { readOnly: true, enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try {
    source.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    await backup(source, targetPath, { rate: 100 });
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    source.close();
  }
  try {
    const metadata = await lstat(targetPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) invalid("targetPath");
    if (process.platform !== "win32") await chmod(targetPath, 0o600);
    const snapshot = new DatabaseSync(targetPath, { readOnly: true, enableForeignKeyConstraints: false,
      enableDoubleQuotedStringLiterals: false, allowExtension: false });
    try {
      const rows = snapshot.prepare("PRAGMA quick_check").all() as { quick_check?: unknown }[];
      if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
        const error = new Error("LEGACY_SNAPSHOT_INTEGRITY_FAILED");
        Object.defineProperty(error, "code", { value: "LEGACY_SNAPSHOT_INTEGRITY_FAILED", enumerable: true });
        throw error;
      }
    } finally {
      snapshot.close();
    }
    return Object.freeze({ targetPath, sizeBytes: metadata.size, sha256: await hashFile(targetPath) });
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function existingRegularFile(value: unknown, field: string) {
  if (typeof value !== "string" || value !== value.trim() || !path.isAbsolute(value)) invalid(field);
  let metadata;
  try { metadata = await lstat(value); } catch { invalid(field); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) invalid(field);
  return path.normalize(value);
}

function validateTarget(value: unknown, sourcePath: string) {
  if (typeof value !== "string" || value !== value.trim() || !path.isAbsolute(value)) invalid("targetPath");
  const normalized = path.normalize(value);
  if (normalized === sourcePath || normalized === path.parse(normalized).root) invalid("targetPath");
  return normalized;
}

async function assertMissing(targetPath: string) {
  try {
    await lstat(targetPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  invalid("targetPath");
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function invalid(field: string): never {
  const error = new Error("LEGACY_SNAPSHOT_INPUT_INVALID");
  Object.defineProperty(error, "code", { value: "LEGACY_SNAPSHOT_INPUT_INVALID", enumerable: true });
  Object.defineProperty(error, "field", { value: field, enumerable: true });
  throw error;
}

