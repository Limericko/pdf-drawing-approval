import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const migrationFilePattern = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export const PLATFORM_MIGRATIONS_DIRECTORY = new URL("../../../../migrations/postgres/", import.meta.url);

export type MigrationFile = {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly checksum: string;
  readonly sql: string;
};

export async function loadMigrationFiles(
  directory: string | URL = PLATFORM_MIGRATIONS_DIRECTORY
): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  const versions = new Set<number>();
  const migrations: MigrationFile[] = [];

  for (const fileName of sqlFiles) {
    const match = migrationFilePattern.exec(fileName);
    if (!match) throw new Error(`MIGRATION_FILE_NAME_INVALID:${fileName}`);
    const version = Number(match[1]);
    if (version === 0 || match[1] !== String(version).padStart(4, "0")) {
      throw new Error(`MIGRATION_FILE_NAME_INVALID:${fileName}`);
    }
    if (versions.has(version)) throw new Error(`MIGRATION_DUPLICATE_VERSION:${version}`);
    versions.add(version);

    const raw = await readFile(resolveMigrationPath(directory, fileName));
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new Error(`MIGRATION_SQL_ENCODING_INVALID:${fileName}`);
    }
    const sql = raw.toString("utf8");
    if (!sql.trim()) throw new Error(`MIGRATION_SQL_EMPTY:${fileName}`);
    migrations.push({
      version,
      name: match[2]!,
      fileName,
      checksum: createHash("sha256").update(raw).digest("hex"),
      sql
    });
  }

  return migrations;
}

function resolveMigrationPath(directory: string | URL, fileName: string) {
  if (directory instanceof URL) return new URL(fileName, ensureTrailingSlash(directory));
  return path.join(directory, fileName);
}

function ensureTrailingSlash(directory: URL) {
  return directory.href.endsWith("/") ? directory : new URL(`${directory.href}/`);
}
