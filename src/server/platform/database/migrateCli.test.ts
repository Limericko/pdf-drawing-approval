import { describe, expect, it, vi } from "vitest";
import type { MigrationRunSummary } from "./migrationRunner.ts";
import { PLATFORM_MIGRATIONS_DIRECTORY } from "./migrationFiles.ts";
import { runMigrationCli } from "./migrateCli.ts";

const databaseConfig = {
  connectionString: "postgresql://migration:secret@database.example/platform",
  poolMax: 1,
  connectTimeoutMs: 1_000,
  queryTimeoutMs: 2_000,
  lockTimeoutMs: 3_000,
  transactionTimeoutMs: 4_000
};

function cliDependencies(summary: MigrationRunSummary = { applied: 2, verified: 1, total: 3 }) {
  const pool = { connect: vi.fn(), end: vi.fn(async () => undefined) };
  const dependencies = {
    loadConfig: vi.fn(() => ({ target: "migration" as const, environment: "test" as const, database: databaseConfig })),
    createPool: vi.fn(() => pool),
    run: vi.fn(async () => summary),
    log: vi.fn()
  };
  return { dependencies, pool };
}

describe("runMigrationCli", () => {
  it("loads migration-only config, runs the module-relative directory and prints a non-sensitive summary", async () => {
    const env = { PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL: databaseConfig.connectionString };
    const { dependencies, pool } = cliDependencies();

    await runMigrationCli(env, dependencies);

    expect(dependencies.loadConfig).toHaveBeenCalledWith(env, "migration");
    expect(dependencies.createPool).toHaveBeenCalledWith(databaseConfig, "pdf-approval-migration");
    expect(dependencies.run).toHaveBeenCalledWith(pool, PLATFORM_MIGRATIONS_DIRECTORY);
    expect(dependencies.log).toHaveBeenCalledWith("Platform migrations complete: applied=2 verified=1 total=3");
    expect(dependencies.log.mock.calls.flat().join(" ")).not.toContain(databaseConfig.connectionString);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("always closes the pool and preserves migration failure", async () => {
    const { dependencies, pool } = cliDependencies();
    const migrationError = new Error("migration failed");
    dependencies.run.mockRejectedValueOnce(migrationError);

    await expect(runMigrationCli({}, dependencies)).rejects.toBe(migrationError);

    expect(dependencies.log).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
