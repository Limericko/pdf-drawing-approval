import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MigrationPlatformConfig, PlatformDatabaseConfig } from "../config/types.ts";
import { loadPlatformConfig } from "../config/loadPlatformConfig.ts";
import { PLATFORM_MIGRATIONS_DIRECTORY } from "./migrationFiles.ts";
import { runMigrations, type MigrationRunSummary } from "./migrationRunner.ts";
import { createPlatformPool } from "./pool.ts";

type MigrationCliPool = Parameters<typeof runMigrations>[0] & {
  end(): Promise<void>;
};

type MigrationCliDependencies = {
  loadConfig(env: NodeJS.ProcessEnv, target: "migration"): MigrationPlatformConfig;
  createPool(config: PlatformDatabaseConfig, applicationName: string): MigrationCliPool;
  run(pool: Parameters<typeof runMigrations>[0], directory: string | URL): Promise<MigrationRunSummary>;
  log(message: string): void;
};

const defaultDependencies: MigrationCliDependencies = {
  loadConfig: loadPlatformConfig,
  createPool: createPlatformPool,
  run: runMigrations,
  log: console.log
};

export async function runMigrationCli(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: MigrationCliDependencies = defaultDependencies
): Promise<void> {
  const config = dependencies.loadConfig(env, "migration");
  const pool = dependencies.createPool(config.database, "pdf-approval-migration");
  let summary: MigrationRunSummary | undefined;
  let primaryError: unknown;

  try {
    summary = await dependencies.run(pool, PLATFORM_MIGRATIONS_DIRECTORY);
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  try {
    await pool.end();
  } catch (error) {
    closeError = error;
  }

  if (primaryError !== undefined) {
    if (closeError !== undefined) {
      throw new AggregateError([primaryError, closeError], "MIGRATION_CLI_CLEANUP_FAILED", { cause: primaryError });
    }
    throw primaryError;
  }
  if (closeError !== undefined) throw closeError;
  dependencies.log(
    `Platform migrations complete: applied=${summary!.applied} verified=${summary!.verified} total=${summary!.total}`
  );
}

function isDirectRun() {
  const entryPoint = process.argv[1];
  return Boolean(entryPoint && pathToFileURL(path.resolve(entryPoint)).href === import.meta.url);
}

if (isDirectRun()) {
  void runMigrationCli().catch(() => {
    console.error("Platform migration failed");
    process.exitCode = 1;
  });
}
