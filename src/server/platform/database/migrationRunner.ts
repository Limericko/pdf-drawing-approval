import type { QueryResult, QueryResultRow } from "pg";
import { loadMigrationFiles, type MigrationFile, PLATFORM_MIGRATIONS_DIRECTORY } from "./migrationFiles.ts";

export const MIGRATION_LOCK_ID = 1_347_668_033;

const selectMigrationHistorySql =
  "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version";
const insertMigrationHistorySql =
  "INSERT INTO platform.schema_migrations (version, file_name, name, checksum) VALUES ($1, $2, $3, $4)";

type MigrationClient = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>>;
  release(error?: Error | boolean): void;
};

type MigrationPool = {
  connect(): Promise<MigrationClient>;
};

type AppliedMigration = {
  readonly version: number;
  readonly file_name: string;
  readonly name: string;
  readonly checksum: string;
};

export type MigrationRunSummary = {
  readonly applied: number;
  readonly verified: number;
  readonly total: number;
};

class UnsafeMigrationSessionError extends AggregateError {
  constructor(
    readonly primaryError: unknown,
    readonly discardSignal: Error | true,
    cleanupError: unknown,
    message = "MIGRATION_TRANSACTION_CLEANUP_FAILED"
  ) {
    super([primaryError, cleanupError], message, { cause: primaryError });
  }
}

class MigrationCommitOutcomeUnknownError extends Error {
  constructor(fileName: string, cause: unknown) {
    super(`MIGRATION_COMMIT_OUTCOME_UNKNOWN:${fileName}`, { cause });
    this.name = "MigrationCommitOutcomeUnknownError";
  }
}

export async function runMigrations(
  pool: MigrationPool,
  directory: string | URL = PLATFORM_MIGRATIONS_DIRECTORY
): Promise<MigrationRunSummary> {
  const migrations = await loadMigrationFiles(directory);
  const client = await pool.connect();
  let lockHeld = false;
  let primaryError: unknown;
  let unsafeError: UnsafeMigrationSessionError | undefined;
  let unlockError: unknown;
  let releaseError: unknown;
  let summary: MigrationRunSummary | undefined;
  let lockAcquisitionUncertain = false;
  let unsafeSessionSignal: Error | true | undefined;

  try {
    lockAcquisitionUncertain = true;
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    lockAcquisitionUncertain = false;
    lockHeld = true;
    await ensureMigrationTable(client);
    const history = await client.query<AppliedMigration>(selectMigrationHistorySql);
    verifyCompleteHistory(history.rows, migrations);

    let applied = 0;
    let verified = 0;
    verified = history.rows.length;
    for (const migration of migrations.slice(history.rows.length)) {
      await applyMigration(client, migration);
      applied += 1;
    }
    summary = { applied, verified, total: migrations.length };
  } catch (error) {
    primaryError = error;
    if (error instanceof UnsafeMigrationSessionError) {
      unsafeError = error;
      unsafeSessionSignal = error.discardSignal;
    } else if (error instanceof MigrationCommitOutcomeUnknownError) {
      unsafeSessionSignal = error;
    }
  }

  if (lockHeld && unsafeSessionSignal === undefined) {
    try {
      const result = await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1) AS unlocked", [
        MIGRATION_LOCK_ID
      ]);
      if (result.rows[0]?.unlocked !== true) throw new Error("MIGRATION_ADVISORY_UNLOCK_FAILED");
      lockHeld = false;
    } catch (error) {
      unlockError = error;
    }
  }

  const discardSignal =
    unsafeSessionSignal ??
    errorReleaseSignal(unlockError) ??
    (lockAcquisitionUncertain ? errorReleaseSignal(primaryError) : undefined);
  try {
    if (discardSignal === undefined) client.release();
    else client.release(discardSignal);
  } catch (error) {
    releaseError = error;
  }

  if (unsafeError) {
    const errors = [...unsafeError.errors, ...(releaseError === undefined ? [] : [releaseError])];
    if (errors.length > unsafeError.errors.length) {
      throw new AggregateError(errors, "MIGRATION_SESSION_CLEANUP_FAILED", { cause: unsafeError.primaryError });
    }
    throw unsafeError;
  }
  if (primaryError !== undefined) {
    const cleanupErrors = [unlockError, releaseError].filter((error) => error !== undefined);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], "MIGRATION_SESSION_CLEANUP_FAILED", {
        cause: primaryError
      });
    }
    throw primaryError;
  }
  if (unlockError !== undefined) {
    if (releaseError !== undefined) {
      throw new AggregateError([unlockError, releaseError], "MIGRATION_SESSION_CLEANUP_FAILED", { cause: unlockError });
    }
    throw unlockError;
  }
  if (releaseError !== undefined) throw releaseError;
  return summary!;
}

async function ensureMigrationTable(client: MigrationClient) {
  await client.query("CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION current_user");
  await client.query("REVOKE ALL ON SCHEMA platform FROM PUBLIC");
  await client.query(`CREATE TABLE IF NOT EXISTS platform.schema_migrations (
    version integer PRIMARY KEY CHECK (version > 0),
    file_name text NOT NULL UNIQUE,
    name text NOT NULL,
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  await client.query("REVOKE ALL ON TABLE platform.schema_migrations FROM PUBLIC");
  await client.query("GRANT USAGE ON SCHEMA platform TO platform_web, platform_worker");
  await client.query("GRANT SELECT ON TABLE platform.schema_migrations TO platform_web, platform_worker");
}

function verifyCompleteHistory(applied: readonly AppliedMigration[], migrations: readonly MigrationFile[]) {
  const localByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const [index, actual] of applied.entries()) {
    const localMatch = localByVersion.get(actual.version);
    if (!localMatch) throw new Error(`MIGRATION_HISTORY_FILE_MISSING:${actual.version}`);
    const expected = migrations[index];
    if (!expected || actual.version !== expected.version) {
      throw new Error(`MIGRATION_HISTORY_SEQUENCE_INVALID:${index + 1}:${actual.version}`);
    }
    verifyHistoryField(actual, expected, "file_name", expected.fileName);
    verifyHistoryField(actual, expected, "name", expected.name);
    verifyHistoryField(actual, expected, "checksum", expected.checksum);
  }
}

function verifyHistoryField(
  actual: AppliedMigration,
  expected: MigrationFile,
  field: "file_name" | "name" | "checksum",
  expectedValue: string
) {
  if (actual[field] !== expectedValue) throw new Error(`MIGRATION_HISTORY_MISMATCH:${expected.version}:${field}`);
}

async function applyMigration(client: MigrationClient, migration: MigrationFile) {
  let primaryError: unknown;
  let stage: "begin" | "migration" | "metadata" | "commit" = "begin";
  try {
    await client.query("BEGIN");
    stage = "migration";
    await client.query(migration.sql);
    stage = "metadata";
    await client.query(insertMigrationHistorySql, [
      migration.version,
      migration.fileName,
      migration.name,
      migration.checksum
    ]);
    stage = "commit";
    await client.query("COMMIT");
    return;
  } catch (error) {
    primaryError = error;
  }

  const commitOutcomeError =
    stage === "commit" ? new MigrationCommitOutcomeUnknownError(migration.fileName, primaryError) : undefined;

  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    if (commitOutcomeError) {
      throw new UnsafeMigrationSessionError(
        primaryError,
        commitOutcomeError,
        rollbackError,
        commitOutcomeError.message
      );
    }
    throw new UnsafeMigrationSessionError(primaryError, errorReleaseSignal(rollbackError) ?? true, rollbackError);
  }
  if (commitOutcomeError) throw commitOutcomeError;
  throw primaryError;
}

function errorReleaseSignal(error: unknown): Error | true | undefined {
  if (error === undefined) return undefined;
  return error instanceof Error ? error : true;
}
