import type { QueryExecutor } from "./queryExecutor.ts";
import type { MigrationFile } from "./migrationFiles.ts";

type AppliedMigration = {
  readonly version: number;
  readonly file_name: string;
  readonly name: string;
  readonly checksum: string;
};

export type SchemaVersionErrorCode =
  | "SCHEMA_VERSION_METADATA_MISSING"
  | "SCHEMA_VERSION_BEHIND"
  | "SCHEMA_VERSION_AHEAD"
  | "SCHEMA_VERSION_MISMATCH";

export class SchemaVersionError extends Error {
  constructor(
    readonly code: SchemaVersionErrorCode,
    ...details: Array<string | number>
  ) {
    super([code, ...details].join(":"));
    this.name = "SchemaVersionError";
  }
}

export async function assertExpectedSchema(
  executor: QueryExecutor,
  expected: readonly MigrationFile[]
): Promise<void> {
  let applied: readonly AppliedMigration[];
  try {
    const result = await executor.query<AppliedMigration>(
      "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version"
    );
    applied = result.rows;
  } catch (error) {
    if (hasPostgresCode(error, "42P01") || hasPostgresCode(error, "3F000")) {
      throw new SchemaVersionError("SCHEMA_VERSION_METADATA_MISSING");
    }
    throw error;
  }

  if (applied.length < expected.length) {
    throw new SchemaVersionError("SCHEMA_VERSION_BEHIND", applied.length, expected.length);
  }
  if (applied.length > expected.length) {
    throw new SchemaVersionError("SCHEMA_VERSION_AHEAD", highestVersion(applied), highestVersion(expected));
  }

  for (let index = 0; index < expected.length; index += 1) {
    const actual = applied[index]!;
    const wanted = expected[index]!;
    if (actual.version !== wanted.version) {
      const code = actual.version < wanted.version ? "SCHEMA_VERSION_BEHIND" : "SCHEMA_VERSION_AHEAD";
      throw new SchemaVersionError(code, actual.version, wanted.version);
    }
    assertField(actual, wanted, "file_name", wanted.fileName);
    assertField(actual, wanted, "name", wanted.name);
    assertField(actual, wanted, "checksum", wanted.checksum);
  }
}

function assertField(
  applied: AppliedMigration,
  expected: MigrationFile,
  field: "file_name" | "name" | "checksum",
  expectedValue: string
) {
  if (applied[field] !== expectedValue) {
    throw new SchemaVersionError("SCHEMA_VERSION_MISMATCH", expected.version, field);
  }
}

function highestVersion(migrations: readonly { version: number }[]) {
  return migrations.at(-1)?.version ?? 0;
}

function hasPostgresCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
