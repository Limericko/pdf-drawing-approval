import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadMigrationStorageConfig, loadPlatformConfig } from "../config/loadPlatformConfig.ts";
import { runMigrations } from "../database/migrationRunner.ts";
import { createStorage } from "../storage/createStorage.ts";
import { runLegacyMigration } from "./legacyMigration.ts";
import type { RootMapping } from "./legacyFilePreflight.ts";

export async function runLegacyMigrationCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const roots = await readJson<RootMapping[]>(options.rootsPath, 64 * 1024);
  const emails = await readJson<Record<string, string>>(options.emailsPath, 64 * 1024);
  const database = loadPlatformConfig(env, "migration").database;
  const storage = createStorage(loadMigrationStorageConfig(env));
  const pool = new Pool({ connectionString: database.connectionString, max: 1,
    connectionTimeoutMillis: database.connectTimeoutMs, statement_timeout: database.queryTimeoutMs });
  try {
    await runMigrations(pool);
    const report = await runLegacyMigration({ databasePath: options.databasePath, sourceId: options.sourceId,
      roots, emailOverrides: emails, mode: options.mode, executor: pool, storage });
    await mkdir(path.dirname(options.outputPath), { recursive: true, mode: 0o700 });
    await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600
    });
    process.stdout.write(`LEGACY_MIGRATION_COMPLETE mode=${report.mode} run=${report.runId} ` +
      `eligible=${report.verification.eligibleForCutover}\n`);
  } finally {
    await pool.end();
  }
}

function parseArguments(argv: readonly string[]) {
  const values = new Map<string, string>();
  const accepted = new Set(["--database", "--source-id", "--roots", "--emails", "--mode", "--output"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!name || !value || !accepted.has(name) || values.has(name)) invalid();
    values.set(name, value);
  }
  const databasePath = values.get("--database"); const sourceId = values.get("--source-id");
  const rootsPath = values.get("--roots"); const emailsPath = values.get("--emails");
  const mode = values.get("--mode"); const outputPath = values.get("--output");
  if (!databasePath || !sourceId || !rootsPath || !emailsPath || !outputPath ||
      (mode !== "import" && mode !== "delta") || !path.isAbsolute(databasePath) ||
      !path.isAbsolute(rootsPath) || !path.isAbsolute(emailsPath) || !path.isAbsolute(outputPath)) invalid();
  return { databasePath: path.normalize(databasePath), sourceId, rootsPath: path.normalize(rootsPath),
    emailsPath: path.normalize(emailsPath), mode, outputPath: path.normalize(outputPath) } as const;
}

async function readJson<T>(filePath: string, maximumBytes: number): Promise<T> {
  const metadata = await lstat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximumBytes) invalid();
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) invalid();
  try { return JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
}

function invalid(): never {
  const error = new Error("LEGACY_MIGRATION_ARGUMENTS_INVALID");
  Object.defineProperty(error, "code", { value: "LEGACY_MIGRATION_ARGUMENTS_INVALID", enumerable: true });
  throw error;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void runLegacyMigrationCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    const code = /^[A-Z0-9_:.-]{1,160}$/.test(message) ? message : "LEGACY_MIGRATION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
