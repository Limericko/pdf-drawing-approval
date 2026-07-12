import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMigrationFiles, PLATFORM_MIGRATIONS_DIRECTORY } from "./migrationFiles.ts";
import { MIGRATION_LOCK_ID, runMigrations } from "./migrationRunner.ts";

const fixtureDirectory = new URL("./__fixtures__/migrations/", import.meta.url);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function queryResult<T extends Record<string, unknown>>(rows: T[] = []) {
  return { command: "", rowCount: rows.length, oid: 0, fields: [], rows };
}

function historyRows(migrations: Array<{ version: number; fileName: string; name: string; checksum: string }>) {
  return migrations.map((migration) => ({
    version: migration.version,
    file_name: migration.fileName,
    name: migration.name,
    checksum: migration.checksum
  }));
}

function migrationPool(existingRows: Array<Record<string, unknown>> = []) {
  const client = {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text === "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version") {
        return queryResult(existingRows);
      }
      if (text === "SELECT pg_advisory_unlock($1) AS unlocked") return queryResult([{ unlocked: true }]);
      return queryResult();
    }),
    release: vi.fn()
  };
  const pool = { connect: vi.fn(async () => client) };
  return { client, pool };
}

async function createMigrationDirectory(files: Record<string, string | Buffer>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pdf-approval-migrations-"));
  temporaryDirectories.push(directory);
  await Promise.all(Object.entries(files).map(([fileName, contents]) => writeFile(path.join(directory, fileName), contents)));
  return directory;
}

describe("loadMigrationFiles", () => {
  it("resolves the production directory from the module URL instead of the working directory", () => {
    const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));

    expect(fileURLToPath(PLATFORM_MIGRATIONS_DIRECTORY)).toBe(
      path.join(projectRoot, "migrations", "postgres") + path.sep
    );
  });

  it("loads strict migration names in stable file-name order", async () => {
    const directory = await createMigrationDirectory({
      "0002_second.sql": "SELECT 2;",
      "0001_first.sql": "SELECT 1;"
    });

    const migrations = await loadMigrationFiles(directory);

    expect(migrations.map(({ version, name, fileName }) => ({ version, name, fileName }))).toEqual([
      { version: 1, name: "first", fileName: "0001_first.sql" },
      { version: 2, name: "second", fileName: "0002_second.sql" }
    ]);
  });

  it("rejects duplicate version numbers", async () => {
    const directory = await createMigrationDirectory({
      "0001_first.sql": "SELECT 1;",
      "0001_replacement.sql": "SELECT 2;"
    });

    await expect(loadMigrationFiles(directory)).rejects.toThrow("MIGRATION_DUPLICATE_VERSION:1");
  });

  it.each(["1_short.sql", "0000_zero.sql", "0001-Hyphen.sql", "0001_UPPER.sql", "0001_.sql"])(
    "rejects a non-canonical SQL file name: %s",
    async (fileName) => {
      const directory = await createMigrationDirectory({ [fileName]: "SELECT 1;" });

      await expect(loadMigrationFiles(directory)).rejects.toThrow(`MIGRATION_FILE_NAME_INVALID:${fileName}`);
    }
  );

  it("rejects empty SQL after decoding", async () => {
    const directory = await createMigrationDirectory({ "0001_empty.sql": Buffer.from([0xef, 0xbb, 0xbf, 0x20, 0x0d, 0x0a]) });

    await expect(loadMigrationFiles(directory)).rejects.toThrow("MIGRATION_SQL_EMPTY:0001_empty.sql");
  });

  it("rejects invalid UTF-8 SQL bytes", async () => {
    const directory = await createMigrationDirectory({ "0001_invalid.sql": Buffer.from([0xc3, 0x28]) });

    await expect(loadMigrationFiles(directory)).rejects.toThrow("MIGRATION_SQL_ENCODING_INVALID:0001_invalid.sql");
  });

  it("rejects a SQL symlink instead of silently ignoring it", async () => {
    const directory = await createMigrationDirectory({ "0001_link.sql": "SELECT 1;" });
    const open = vi.fn();
    const fileSystem = {
      readDirectory: vi.fn(async () => ["0001_link.sql"]),
      lstat: vi.fn(async () => ({
        dev: 1n,
        ino: 1n,
        size: 9n,
        mtimeNs: 1n,
        ctimeNs: 1n,
        isFile: () => false,
        isSymbolicLink: () => true
      })),
      open
    };

    await expect(loadMigrationFiles(directory, fileSystem)).rejects.toThrow("MIGRATION_FILE_TYPE_INVALID:0001_link.sql");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a migration path replaced between lstat and opening the file", async () => {
    const directory = await createMigrationDirectory({ "0001_changed.sql": "SELECT 1;" });
    const close = vi.fn(async () => undefined);
    const identity = (ino: bigint) => ({
      dev: 1n,
      ino,
      size: 9n,
      mtimeNs: 1n,
      ctimeNs: 1n,
      isFile: () => true
    });
    const fileSystem = {
      readDirectory: vi.fn(async () => ["0001_changed.sql"]),
      lstat: vi.fn(async () => identity(1n)),
      open: vi.fn(async () => ({
        readFile: vi.fn(async () => Buffer.from("SELECT 2;")),
        stat: vi.fn(async () => identity(2n)),
        close
      }))
    };

    await expect(loadMigrationFiles(directory, fileSystem)).rejects.toThrow(
      "MIGRATION_FILE_CHANGED_DURING_READ:0001_changed.sql"
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("hashes the exact raw bytes before UTF-8 decoding", async () => {
    const raw = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("SELECT 1;\r\n")]);
    const directory = await createMigrationDirectory({ "0001_bytes.sql": raw });

    const [migration] = await loadMigrationFiles(directory);

    expect(migration?.checksum).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(migration?.sql).toBe(raw.toString("utf8"));
  });

  it.each([
    "BEGIN; SELECT 1;",
    "START TRANSACTION; SELECT 1;",
    "COMMIT; SELECT 1;",
    "END; SELECT 1;",
    "ROLLBACK; SELECT 1;",
    "ABORT; SELECT 1;",
    "SAVEPOINT before_change; SELECT 1;",
    "RELEASE SAVEPOINT before_change; SELECT 1;",
    "PREPARE TRANSACTION 'migration'; SELECT 1;"
  ])("rejects top-level transaction control before execution: %s", async (sql) => {
    const directory = await createMigrationDirectory({ "0001_control.sql": sql });

    await expect(loadMigrationFiles(directory)).rejects.toThrow(
      "MIGRATION_TRANSACTION_CONTROL_FORBIDDEN:0001_control.sql"
    );
  });

  it("allows transaction words inside comments, quoted values, identifiers and dollar-quoted bodies", async () => {
    const sql = `-- COMMIT;
/* ROLLBACK; /* nested BEGIN; */ END; */
DO $migration$
BEGIN
  PERFORM 'COMMIT;';
END
$migration$;
SELECT 'ROLLBACK;', "commit" FROM (SELECT 1 AS "commit") AS values;
SELECT $$BEGIN; COMMIT; END;$$;`;
    const directory = await createMigrationDirectory({ "0001_allowed.sql": sql });

    await expect(loadMigrationFiles(directory)).resolves.toMatchObject([{ sql }]);
  });
});

describe("runMigrations", () => {
  it("destroys the client when advisory lock acquisition status is unknown", async () => {
    const { client, pool } = migrationPool();
    const lockError = new Error("connection lost while locking");
    client.query.mockRejectedValueOnce(lockError);

    await expect(runMigrations(pool as never, fixtureDirectory)).rejects.toBe(lockError);

    expect(client.query).not.toHaveBeenCalledWith("SELECT pg_advisory_unlock($1) AS unlocked", [MIGRATION_LOCK_ID]);
    expect(client.release).toHaveBeenCalledWith(lockError);
  });

  it("loads all files before connecting, locks one session, and applies each migration in its own transaction", async () => {
    const migrations = await loadMigrationFiles(fixtureDirectory);
    const fixtureSql = await Promise.all(
      migrations.map((migration) => readFile(new URL(migration.fileName, fixtureDirectory), "utf8"))
    );
    const { client, pool } = migrationPool();

    const summary = await runMigrations(pool as never, fixtureDirectory);

    expect(summary).toEqual({ applied: 2, verified: 0, total: 2 });
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    expect(client.query).toHaveBeenCalledWith("CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION current_user");
    expect(client.query).toHaveBeenCalledWith("REVOKE ALL ON SCHEMA platform FROM PUBLIC");
    expect(client.query).toHaveBeenCalledWith(
      "GRANT SELECT ON TABLE platform.schema_migrations TO platform_web, platform_worker, platform_bootstrap"
    );
    for (const [index, migration] of migrations.entries()) {
      expect(client.query).toHaveBeenCalledWith(fixtureSql[index]);
      expect(client.query).toHaveBeenCalledWith(
        "INSERT INTO platform.schema_migrations (version, file_name, name, checksum) VALUES ($1, $2, $3, $4)",
        [migration.version, migration.fileName, migration.name, migration.checksum]
      );
    }
    expect(client.query.mock.calls.filter(([text]) => text === "BEGIN")).toHaveLength(2);
    expect(client.query.mock.calls.filter(([text]) => text === "COMMIT")).toHaveLength(2);
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1) AS unlocked", [MIGRATION_LOCK_ID]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("does not connect if loading or validating the complete directory fails", async () => {
    const directory = await createMigrationDirectory({
      "0001_first.sql": "SELECT 1;",
      "0001_duplicate.sql": "SELECT 2;"
    });
    const { pool } = migrationPool();

    await expect(runMigrations(pool as never, directory)).rejects.toThrow("MIGRATION_DUPLICATE_VERSION:1");

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("does not connect when a migration contains top-level transaction control", async () => {
    const directory = await createMigrationDirectory({ "0001_commit.sql": "CREATE TABLE leaked(id int); COMMIT;" });
    const { pool } = migrationPool();

    await expect(runMigrations(pool as never, directory)).rejects.toThrow(
      "MIGRATION_TRANSACTION_CONTROL_FORBIDDEN:0001_commit.sql"
    );

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("verifies identical history without opening migration transactions", async () => {
    const migrations = await loadMigrationFiles(fixtureDirectory);
    const { client, pool } = migrationPool(historyRows(migrations));

    const summary = await runMigrations(pool as never, fixtureDirectory);

    expect(summary).toEqual({ applied: 0, verified: 2, total: 2 });
    expect(client.query).not.toHaveBeenCalledWith("BEGIN");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledWith();
  });

  it.each([
    ["file_name", "0001_changed.sql"],
    ["name", "changed"],
    ["checksum", "0".repeat(64)]
  ] as const)("rejects historical %s drift without applying anything", async (field, value) => {
    const migrations = await loadMigrationFiles(fixtureDirectory);
    const changed = historyRows(migrations).map((migration, index) =>
      index === 0 ? { ...migration, [field]: value } : migration
    );
    const { client, pool } = migrationPool(changed);

    await expect(runMigrations(pool as never, fixtureDirectory)).rejects.toThrow(`MIGRATION_HISTORY_MISMATCH:1:${field}`);

    expect(client.query).not.toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1) AS unlocked", [MIGRATION_LOCK_ID]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("rejects a recorded migration whose local file is missing", async () => {
    const migrations = await loadMigrationFiles(fixtureDirectory);
    const rows = historyRows(migrations);
    const missing = { ...rows[1]!, version: 3, file_name: "0003_missing.sql", name: "missing" };
    const { client, pool } = migrationPool([rows[0]!, missing]);

    await expect(runMigrations(pool as never, fixtureDirectory)).rejects.toThrow("MIGRATION_HISTORY_FILE_MISSING:3");

    expect(client.query).not.toHaveBeenCalledWith("BEGIN");
  });

  it("rejects migration history that is not a strict local prefix", async () => {
    const migrations = await loadMigrationFiles(fixtureDirectory);
    const secondOnly = historyRows(migrations).slice(1);
    const { client, pool } = migrationPool(secondOnly);

    await expect(runMigrations(pool as never, fixtureDirectory)).rejects.toThrow("MIGRATION_HISTORY_SEQUENCE_INVALID:1:2");

    expect(client.query).not.toHaveBeenCalledWith("BEGIN");
  });

  it("rolls back a failed raw migration and leaves no metadata insert", async () => {
    const directory = await createMigrationDirectory({ "0001_failing.sql": "SELECT broken;" });
    const { client, pool } = migrationPool();
    const migrationError = new Error("statement failed");
    client.query.mockImplementation(async (text: string) => {
      if (text === "SELECT broken;") throw migrationError;
      if (text === "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version") {
        return queryResult();
      }
      if (text === "SELECT pg_advisory_unlock($1) AS unlocked") return queryResult([{ unlocked: true }]);
      return queryResult();
    });

    await expect(runMigrations(pool as never, directory)).rejects.toBe(migrationError);

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO platform.schema_migrations"))).toBe(false);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("destroys the session when COMMIT outcome is unknown even if ROLLBACK resolves", async () => {
    const directory = await createMigrationDirectory({ "0001_commit.sql": "SELECT 1;" });
    const { client, pool } = migrationPool();
    const commitError = new Error("connection lost during commit");
    client.query.mockImplementation(async (text: string) => {
      if (text === "COMMIT") throw commitError;
      if (text === "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version") {
        return queryResult();
      }
      return queryResult();
    });

    const thrown = await captureError(() => runMigrations(pool as never, directory));

    expect(thrown).toMatchObject({
      name: "MigrationCommitOutcomeUnknownError",
      message: "MIGRATION_COMMIT_OUTCOME_UNKNOWN:0001_commit.sql",
      cause: commitError
    });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("SELECT pg_advisory_unlock($1) AS unlocked", [MIGRATION_LOCK_ID]);
    expect(client.release).toHaveBeenCalledWith(thrown);
  });

  it("preserves COMMIT and ROLLBACK failures while destroying the session", async () => {
    const directory = await createMigrationDirectory({ "0001_commit.sql": "SELECT 1;" });
    const { client, pool } = migrationPool();
    const commitError = new Error("connection lost during commit");
    const rollbackError = new Error("rollback failed");
    client.query.mockImplementation(async (text: string) => {
      if (text === "COMMIT") throw commitError;
      if (text === "ROLLBACK") throw rollbackError;
      if (text === "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version") {
        return queryResult();
      }
      return queryResult();
    });

    const thrown = await captureError(() => runMigrations(pool as never, directory));

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as Error).message).toBe("MIGRATION_COMMIT_OUTCOME_UNKNOWN:0001_commit.sql");
    expect([...(thrown as AggregateError).errors]).toEqual([commitError, rollbackError]);
    expect((thrown as Error).cause).toBe(commitError);
    expect(client.query).not.toHaveBeenCalledWith("SELECT pg_advisory_unlock($1) AS unlocked", [MIGRATION_LOCK_ID]);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("destroys a session and aggregates errors when rollback fails", async () => {
    const directory = await createMigrationDirectory({ "0001_failing.sql": "SELECT broken;" });
    const { client, pool } = migrationPool();
    const migrationError = new Error("statement failed");
    const rollbackError = new Error("rollback failed");
    client.query.mockImplementation(async (text: string) => {
      if (text === "SELECT broken;") throw migrationError;
      if (text === "ROLLBACK") throw rollbackError;
      if (text === "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version") {
        return queryResult();
      }
      return queryResult();
    });

    const thrown = await captureError(() => runMigrations(pool as never, directory));

    expect(thrown).toBeInstanceOf(AggregateError);
    expect([...(thrown as AggregateError).errors]).toEqual([migrationError, rollbackError]);
    expect((thrown as Error).cause).toBe(migrationError);
    expect(client.query).not.toHaveBeenCalledWith("SELECT pg_advisory_unlock($1) AS unlocked", [MIGRATION_LOCK_ID]);
    expect(client.release).toHaveBeenCalledWith(rollbackError);
  });

  it("destroys a session and preserves the primary error when advisory unlock fails", async () => {
    const { client, pool } = migrationPool();
    const primaryError = new Error("history invalid");
    const unlockError = new Error("unlock failed");
    client.query.mockImplementation(async (text: string) => {
      if (text === "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version") {
        throw primaryError;
      }
      if (text === "SELECT pg_advisory_unlock($1) AS unlocked") throw unlockError;
      return queryResult();
    });

    const thrown = await captureError(() => runMigrations(pool as never, fixtureDirectory));

    expect(thrown).toBeInstanceOf(AggregateError);
    expect([...(thrown as AggregateError).errors]).toEqual([primaryError, unlockError]);
    expect((thrown as Error).cause).toBe(primaryError);
    expect(client.release).toHaveBeenCalledWith(unlockError);
  });

  it("treats an advisory unlock false result as failure and destroys the session", async () => {
    const { client, pool } = migrationPool();
    client.query.mockImplementation(async (text: string) => {
      if (text === "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version") {
        return queryResult();
      }
      if (text === "SELECT pg_advisory_unlock($1) AS unlocked") return queryResult([{ unlocked: false }]);
      return queryResult();
    });

    const thrown = await captureError(() => runMigrations(pool as never, fixtureDirectory));

    expect((thrown as Error).message).toBe("MIGRATION_ADVISORY_UNLOCK_FAILED");
    expect(client.release).toHaveBeenCalledWith(thrown);
  });

  it("aggregates primary, unlock and release failures without losing the primary cause", async () => {
    const { client, pool } = migrationPool();
    const primaryError = new Error("history failed");
    const unlockError = new Error("unlock failed");
    const releaseError = new Error("release failed");
    client.query.mockImplementation(async (text: string) => {
      if (text === "SELECT version, file_name, name, checksum FROM platform.schema_migrations ORDER BY version") {
        throw primaryError;
      }
      if (text === "SELECT pg_advisory_unlock($1) AS unlocked") throw unlockError;
      return queryResult();
    });
    client.release.mockImplementation(() => {
      throw releaseError;
    });

    const thrown = await captureError(() => runMigrations(pool as never, fixtureDirectory));

    expect(thrown).toBeInstanceOf(AggregateError);
    expect([...(thrown as AggregateError).errors]).toEqual([primaryError, unlockError, releaseError]);
    expect((thrown as Error).cause).toBe(primaryError);
  });
});

async function captureError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("EXPECTED_PROMISE_TO_REJECT");
}
