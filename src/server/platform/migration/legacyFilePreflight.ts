import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PDFDocument } from "pdf-lib";

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;

type RootMapping = { readonly legacyRoot: string; readonly snapshotRoot: string };
type Reference = { readonly table: string; readonly rowId: number; readonly column: string;
  readonly sourcePath: string; readonly mediaType: "application/pdf" | "image/png" };

export type LegacyFilePreflightReport = {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly references: number;
  readonly uniquePaths: number;
  readonly verifiedFiles: number;
  readonly totalBytes: number;
  readonly files: readonly {
    readonly sourcePathSha256: string;
    readonly relativePath: string;
    readonly mediaType: "application/pdf" | "image/png";
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly pageCount?: number;
    readonly referenceCount: number;
  }[];
  readonly issues: readonly {
    readonly code: "FILE_PATH_OUTSIDE_ROOT" | "FILE_MISSING" | "FILE_NOT_REGULAR" | "FILE_TOO_LARGE" |
      "FILE_MEDIA_INVALID" | "FILE_REFERENCE_INVALID";
    readonly sourcePathSha256: string;
    readonly referenceCount: number;
  }[];
  readonly blockingIssueCount: number;
  readonly eligibleForImport: boolean;
};

export async function preflightLegacyFiles(input: {
  readonly databasePath: string;
  readonly roots: readonly RootMapping[];
  readonly now?: () => Date;
}): Promise<LegacyFilePreflightReport> {
  const databasePath = await regularFile(input?.databasePath, "databasePath");
  const roots = await validateRoots(input?.roots);
  const database = new DatabaseSync(databasePath, { readOnly: true, enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: false, allowExtension: false });
  let references: Reference[];
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    references = discoverReferences(database);
  } finally {
    database.close();
  }

  const groups = new Map<string, Reference[]>();
  for (const reference of references) {
    const key = reference.sourcePath.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), reference]);
  }
  const files: LegacyFilePreflightReport["files"][number][] = [];
  const issues: LegacyFilePreflightReport["issues"][number][] = [];
  for (const group of groups.values()) {
    const sourcePath = group[0]!.sourcePath;
    const sourcePathSha256 = createHash("sha256").update(sourcePath).digest("hex");
    const referenceCount = group.length;
    if (!sourcePath || sourcePath !== sourcePath.trim() ||
        group.some((reference) => reference.rowId <= 0 || reference.mediaType !== group[0]!.mediaType)) {
      issues.push({ code: "FILE_REFERENCE_INVALID", sourcePathSha256, referenceCount });
      continue;
    }
    const mapped = resolveMappedPath(sourcePath, roots);
    if (!mapped) {
      issues.push({ code: "FILE_PATH_OUTSIDE_ROOT", sourcePathSha256, referenceCount });
      continue;
    }
    let metadata;
    try { metadata = await lstat(mapped.absolutePath); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        issues.push({ code: "FILE_MISSING", sourcePathSha256, referenceCount });
        continue;
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      issues.push({ code: "FILE_NOT_REGULAR", sourcePathSha256, referenceCount });
      continue;
    }
    const mediaType = group[0]!.mediaType;
    const maximum = mediaType === "application/pdf" ? MAX_PDF_BYTES : MAX_PNG_BYTES;
    if (metadata.size <= 0 || metadata.size > maximum) {
      issues.push({ code: "FILE_TOO_LARGE", sourcePathSha256, referenceCount });
      continue;
    }
    const bytes = await readFile(mapped.absolutePath);
    const validated = await validateMedia(bytes, mediaType);
    if (!validated.ok) {
      issues.push({ code: "FILE_MEDIA_INVALID", sourcePathSha256, referenceCount });
      continue;
    }
    files.push({ sourcePathSha256, relativePath: mapped.relativePath, mediaType, sizeBytes: metadata.size,
      sha256: await hashFile(mapped.absolutePath), ...(validated.pageCount ? { pageCount: validated.pageCount } : {}),
      referenceCount });
  }
  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  return Object.freeze({ schemaVersion: 1, generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    references: references.length, uniquePaths: groups.size, verifiedFiles: files.length, totalBytes,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))), blockingIssueCount: issues.length,
    eligibleForImport: issues.length === 0 });
}

function discoverReferences(database: DatabaseSync) {
  const tables = new Set((database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all() as { name: string }[]).map((row) => row.name));
  const references: Reference[] = [];
  const specifications = [
    ["approvals", "original_file_path", "application/pdf"],
    ["approvals", "current_file_path", "application/pdf"],
    ["approvals", "signed_file_path", "application/pdf"],
    ["pdm_drawing_revisions", "original_file_path", "application/pdf"],
    ["pdm_drawing_revisions", "signed_file_path", "application/pdf"],
    ["pdm_drawing_revisions", "annotated_file_path", "application/pdf"],
    ["signature_assets", "file_path", "image/png"]
  ] as const;
  for (const [table, column, mediaType] of specifications) {
    if (!tables.has(table)) continue;
    const rows = database.prepare(
      `SELECT id,${identifier(column)} AS source_path FROM ${identifier(table)} WHERE ${identifier(column)} IS NOT NULL`
    ).all() as { id: unknown; source_path: unknown }[];
    for (const row of rows) {
      if (!Number.isSafeInteger(Number(row.id)) || typeof row.source_path !== "string" ||
          !row.source_path.trim() || row.source_path !== row.source_path.trim()) {
        references.push({ table, rowId: Number(row.id) || 0, column, sourcePath: String(row.source_path ?? ""), mediaType });
        continue;
      }
      references.push({ table, rowId: Number(row.id), column, sourcePath: row.source_path, mediaType });
    }
  }
  return references;
}

async function validateRoots(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) invalid("roots");
  const roots: { legacyRoot: string; snapshotRoot: string; flavor: typeof path.win32 | typeof path.posix }[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(",") !== "legacyRoot,snapshotRoot") invalid("roots");
    const { legacyRoot, snapshotRoot } = candidate as Record<string, unknown>;
    if (typeof legacyRoot !== "string" || legacyRoot !== legacyRoot.trim() ||
        typeof snapshotRoot !== "string" || snapshotRoot !== snapshotRoot.trim() || !path.isAbsolute(snapshotRoot)) invalid("roots");
    const flavor = path.win32.isAbsolute(legacyRoot) ? path.win32 : path.posix.isAbsolute(legacyRoot) ? path.posix : null;
    if (!flavor) invalid("roots");
    const metadata = await lstat(snapshotRoot).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) invalid("roots");
    roots.push({ legacyRoot: flavor.normalize(legacyRoot), snapshotRoot: path.normalize(snapshotRoot), flavor });
  }
  return roots.sort((left, right) => right.legacyRoot.length - left.legacyRoot.length);
}

function resolveMappedPath(sourcePath: string, roots: Awaited<ReturnType<typeof validateRoots>>) {
  for (const root of roots) {
    if (!root.flavor.isAbsolute(sourcePath)) continue;
    const normalized = root.flavor.normalize(sourcePath);
    const relative = root.flavor.relative(root.legacyRoot, normalized);
    if (!relative || relative.startsWith(`..${root.flavor.sep}`) || relative === ".." || root.flavor.isAbsolute(relative)) continue;
    const segments = relative.split(/[\\/]+/);
    const absolutePath = path.resolve(root.snapshotRoot, ...segments);
    const hostRelative = path.relative(root.snapshotRoot, absolutePath);
    if (!hostRelative || hostRelative === ".." || hostRelative.startsWith(`..${path.sep}`) || path.isAbsolute(hostRelative)) continue;
    return { absolutePath, relativePath: segments.join("/") };
  }
  return null;
}

async function validateMedia(bytes: Buffer, mediaType: "application/pdf" | "image/png") {
  try {
    if (mediaType === "application/pdf") {
      if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return { ok: false as const };
      const document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
      const pageCount = document.getPageCount();
      return pageCount > 0 ? { ok: true as const, pageCount } : { ok: false as const };
    }
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ok: false as const };
    const document = await PDFDocument.create();
    await document.embedPng(bytes);
    return { ok: true as const };
  } catch {
    return { ok: false as const };
  }
}

async function regularFile(value: unknown, field: string) {
  if (typeof value !== "string" || value !== value.trim() || !path.isAbsolute(value)) invalid(field);
  const metadata = await lstat(value).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) invalid(field);
  return path.normalize(value);
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("LEGACY_FILE_IDENTIFIER_INVALID");
  return `"${value}"`;
}

function invalid(field: string): never {
  const error = new Error("LEGACY_FILE_PREFLIGHT_INPUT_INVALID");
  Object.defineProperty(error, "code", { value: "LEGACY_FILE_PREFLIGHT_INPUT_INVALID", enumerable: true });
  Object.defineProperty(error, "field", { value: field, enumerable: true });
  throw error;
}
