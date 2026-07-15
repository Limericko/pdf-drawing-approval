import { describe, expect, it, vi } from "vitest";
import type { MigrationFile } from "./migrationFiles.ts";
import { assertExpectedSchema } from "./schemaVersion.ts";

const expected: MigrationFile[] = [
  { version: 1, fileName: "0001_first.sql", name: "first", checksum: "1".repeat(64), sql: "SELECT 1;" },
  { version: 2, fileName: "0002_second.sql", name: "second", checksum: "2".repeat(64), sql: "SELECT 2;" }
];

function historyRows(migrations: readonly MigrationFile[]) {
  return migrations.map((migration) => ({
    version: migration.version,
    file_name: migration.fileName,
    name: migration.name,
    checksum: migration.checksum
  }));
}

function executor(rows: Array<Record<string, unknown>> = historyRows(expected)) {
  return {
    query: vi.fn(async () => ({ command: "", rowCount: rows.length, oid: 0, fields: [], rows }))
  };
}

describe("assertExpectedSchema", () => {
  it("accepts the exact expected version, file names, names and checksums with one read-only query", async () => {
    const database = executor();

    await expect(assertExpectedSchema(database as never, expected)).resolves.toBeUndefined();

    expect(database.query).toHaveBeenCalledOnce();
    expect(database.query).toHaveBeenCalledWith(
      "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version"
    );
    expect(database.query.mock.calls.flat().join(" ")).not.toMatch(/create|alter|insert|update|delete|drop/i);
  });

  it("rejects a missing schema or metadata table without attempting DDL", async () => {
    const database = executor();
    database.query.mockRejectedValueOnce(Object.assign(new Error("relation does not exist"), { code: "42P01" }));

    await expect(assertExpectedSchema(database as never, expected)).rejects.toThrow("SCHEMA_VERSION_METADATA_MISSING");

    expect(database.query).toHaveBeenCalledOnce();
  });

  it("rejects missing records as behind", async () => {
    const database = executor(historyRows(expected.slice(0, 1)));

    await expect(assertExpectedSchema(database as never, expected)).rejects.toMatchObject({
      name: "SchemaVersionError",
      code: "SCHEMA_VERSION_BEHIND",
      message: "SCHEMA_VERSION_BEHIND:1:2"
    });
  });

  it("rejects a schema version ahead of the application", async () => {
    const ahead = [
      ...historyRows(expected),
      { version: 3, file_name: "0003_future.sql", name: "future", checksum: "3".repeat(64) }
    ];
    const database = executor(ahead);

    await expect(assertExpectedSchema(database as never, expected)).rejects.toThrow("SCHEMA_VERSION_AHEAD:3:2");
  });

  it.each([
    ["file_name", "0001_changed.sql"],
    ["name", "changed"],
    ["checksum", "f".repeat(64)]
  ] as const)("rejects %s mismatch at an applied version", async (field, value) => {
    const rows = expected.map((migration, index) =>
      index === 0
        ? { version: migration.version, file_name: migration.fileName, name: migration.name, checksum: migration.checksum, [field]: value }
        : { version: migration.version, file_name: migration.fileName, name: migration.name, checksum: migration.checksum }
    );
    const database = executor(rows);

    await expect(assertExpectedSchema(database as never, expected)).rejects.toThrow(`SCHEMA_VERSION_MISMATCH:1:${field}`);
  });

  it("rejects a missing middle record even when the maximum version matches", async () => {
    const database = executor([
      { version: 2, file_name: expected[1]!.fileName, name: expected[1]!.name, checksum: expected[1]!.checksum }
    ]);

    await expect(assertExpectedSchema(database as never, expected)).rejects.toThrow("SCHEMA_VERSION_BEHIND:1:2");
  });
});
