import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { type PlatformTestDatabase, withPlatformTestDatabase } from "../testing/postgresHarness.ts";
import { loadMigrationFiles } from "./migrationFiles.ts";
import { runMigrations } from "./migrationRunner.ts";
import { assertExpectedSchema } from "./schemaVersion.ts";

const fixtureDirectory = new URL("./__fixtures__/migrations/", import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function createMigrationDirectory(files: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pdf-approval-migrations-integration-"));
  temporaryDirectories.push(directory);
  await Promise.all(Object.entries(files).map(([fileName, sql]) => writeFile(path.join(directory, fileName), sql)));
  return directory;
}

async function withMigrationPool(
  run: (database: PlatformTestDatabase, migrationPool: Pool) => Promise<void>
) {
  await withPlatformTestDatabase(async (database) => {
    const migrationPool = database.createPool("migration");
    const identity = await migrationPool.query<{ current_user: string }>("SELECT current_user");
    expect(identity.rows[0]?.current_user).toBe("platform_migration");
    await run(database, migrationPool);
  });
}

describe("PostgreSQL migrations", () => {
  it("applies on a fresh database, grants read-only startup checks, and is idempotent", async () => {
    await withMigrationPool(async (database, migrationPool) => {
      await expect(runMigrations(migrationPool, fixtureDirectory)).resolves.toEqual({ applied: 2, verified: 0, total: 2 });
      await expect(runMigrations(migrationPool, fixtureDirectory)).resolves.toEqual({ applied: 0, verified: 2, total: 2 });

      const history = await migrationPool.query<{
        version: number;
        file_name: string;
        checksum: string;
      }>("SELECT version, file_name, checksum FROM platform.schema_migrations ORDER BY version");
      expect(history.rows).toHaveLength(2);
      expect(history.rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum))).toBe(true);
      const misplaced = await migrationPool.query<{ relation: string | null }>(
        "SELECT to_regclass('public.schema_migrations')::text AS relation"
      );
      expect(misplaced.rows[0]?.relation).toBeNull();

      const expected = await loadMigrationFiles(fixtureDirectory);
      for (const role of ["web", "worker"] as const) {
        const restricted = database.createPool(role);
        await expect(assertExpectedSchema(restricted, expected)).resolves.toBeUndefined();
        await expect(
          restricted.query(
            "INSERT INTO platform.schema_migrations(version, file_name, name, checksum) VALUES (99, '0099_forbidden.sql', 'forbidden', $1)",
            ["f".repeat(64)]
          )
        ).rejects.toMatchObject({ code: "42501" });
      }
    });
  });

  it("rejects a modified historical file without changing recorded history", async () => {
    const directory = await createMigrationDirectory({ "0001_history.sql": "CREATE TABLE platform.history_guard(id integer);" });
    await withMigrationPool(async (_database, migrationPool) => {
      await runMigrations(migrationPool, directory);
      const before = await migrationPool.query<{ checksum: string }>(
        "SELECT checksum FROM platform.schema_migrations WHERE version = 1"
      );
      await writeFile(path.join(directory, "0001_history.sql"), "CREATE TABLE platform.history_guard(id bigint);");

      await expect(runMigrations(migrationPool, directory)).rejects.toThrow("MIGRATION_HISTORY_MISMATCH:1:checksum");

      const after = await migrationPool.query<{ checksum: string }>(
        "SELECT checksum FROM platform.schema_migrations WHERE version = 1"
      );
      expect(after.rows).toEqual(before.rows);
    });
  });

  it("rolls back a failed migration while preserving earlier successful versions", async () => {
    const directory = await createMigrationDirectory({
      "0001_kept.sql": "CREATE TABLE platform.kept_table(id integer);",
      "0002_failing.sql": "CREATE TABLE platform.rolled_back_table(id integer); SELECT 1 / 0;"
    });
    await withMigrationPool(async (_database, migrationPool) => {
      await expect(runMigrations(migrationPool, directory)).rejects.toMatchObject({ code: "22012" });

      const state = await migrationPool.query<{
        kept: string | null;
        rolled_back: string | null;
        versions: number[];
      }>(`SELECT
          to_regclass('platform.kept_table')::text AS kept,
          to_regclass('platform.rolled_back_table')::text AS rolled_back,
          ARRAY(SELECT version FROM platform.schema_migrations ORDER BY version) AS versions`);
      expect(state.rows[0]).toEqual({ kept: "platform.kept_table", rolled_back: null, versions: [1] });
    });
  });

  it("serializes concurrent runners on the same advisory lock", async () => {
    const directory = await createMigrationDirectory({
      "0001_serial.sql": "SELECT pg_sleep(0.1); CREATE TABLE platform.serialized_once(id integer);"
    });
    await withMigrationPool(async (_database, migrationPool) => {
      const summaries = await Promise.all([
        runMigrations(migrationPool, directory),
        runMigrations(migrationPool, directory)
      ]);

      expect(summaries).toEqual(
        expect.arrayContaining([
          { applied: 1, verified: 0, total: 1 },
          { applied: 0, verified: 1, total: 1 }
        ])
      );
      const count = await migrationPool.query<{ count: string }>("SELECT count(*) FROM platform.schema_migrations");
      expect(count.rows[0]?.count).toBe("1");
    });
  });
});
