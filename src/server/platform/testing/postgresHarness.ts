import { randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";

export type PlatformDatabaseRole = "migration" | "web" | "worker" | "bootstrap";

export type PlatformTestDatabase = {
  readonly databaseName: string;
  readonly urls: Record<PlatformDatabaseRole | "admin", string>;
  createPool(role: PlatformDatabaseRole): Pool;
  dispose(): Promise<void>;
};

type PoolFactory = (config: PoolConfig) => Pool;

type HarnessOptions = {
  poolFactory?: PoolFactory;
  createId?: () => string;
};

type ParsedDatabaseUrl = {
  readonly key: string;
  readonly value: string;
  readonly url: URL;
};

export async function createPlatformTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
  options: HarnessOptions = {}
): Promise<PlatformTestDatabase> {
  const parsed = parseHarnessUrls(env);
  const databaseName = `pdf_approval_test_${(options.createId?.() ?? randomUUID()).replaceAll("-", "")}`;
  const urls = {
    admin: replaceDatabase(parsed.admin.value, databaseName),
    migration: replaceDatabase(parsed.migration.value, databaseName),
    web: replaceDatabase(parsed.web.value, databaseName),
    worker: replaceDatabase(parsed.worker.value, databaseName),
    bootstrap: replaceDatabase(parsed.bootstrap.value, databaseName)
  };
  const poolFactory = options.poolFactory ?? ((config: PoolConfig) => new Pool(config));
  const adminPool = poolFactory({ connectionString: parsed.admin.value, max: 1 });
  let databaseCreated = false;

  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER platform_migration`);
    databaseCreated = true;
    await adminPool.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`);
    await adminPool.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO platform_migration, platform_web, platform_worker, platform_bootstrap`
    );
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (databaseCreated) {
      try {
        await adminPool.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      } catch (cleanupError) {
        cleanupErrors.push(new Error(`DROP_DATABASE_FAILED:${databaseName}:${errorMessage(cleanupError)}`, { cause: cleanupError }));
      }
    }
    try {
      await adminPool.end();
    } catch (cleanupError) {
      cleanupErrors.push(new Error(`ADMIN_POOL_CLOSE_FAILED:${databaseName}:${errorMessage(cleanupError)}`, { cause: cleanupError }));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], `PLATFORM_TEST_DATABASE_SETUP_CLEANUP_FAILED:${databaseName}`);
    }
    throw error;
  }

  const pools = new Set<Pool>();
  let acceptingPools = true;
  let databaseDropped = false;
  let adminPoolClosed = false;
  let disposeInFlight: Promise<void> | undefined;

  async function performDispose() {
    acceptingPools = false;
    const errors: unknown[] = [];
    for (const pool of pools) {
      try {
        await pool.end();
      } catch (error) {
        errors.push(new Error(`ROLE_POOL_CLOSE_FAILED:${databaseName}:${errorMessage(error)}`, { cause: error }));
      }
    }
    pools.clear();

    const cleanupAdmin = adminPoolClosed ? poolFactory({ connectionString: parsed.admin.value, max: 1 }) : adminPool;
    try {
      await cleanupAdmin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      databaseDropped = true;
    } catch (error) {
      errors.push(new Error(`DROP_DATABASE_FAILED:${databaseName}:${errorMessage(error)}`, { cause: error }));
    }
    try {
      await cleanupAdmin.end();
    } catch (error) {
      errors.push(new Error(`ADMIN_POOL_CLOSE_FAILED:${databaseName}:${errorMessage(error)}`, { cause: error }));
    }
    adminPoolClosed = true;

    if (errors.length > 0) {
      throw new AggregateError(errors, `PLATFORM_TEST_DATABASE_CLEANUP_FAILED:${databaseName}`);
    }
  }

  return {
    databaseName,
    urls,
    createPool(role) {
      if (!acceptingPools || databaseDropped) throw new Error("PLATFORM_TEST_DATABASE_DISPOSED");
      const pool = poolFactory({ connectionString: urls[role] });
      pools.add(pool);
      return pool;
    },
    async dispose() {
      if (databaseDropped) return;
      if (!disposeInFlight) {
        disposeInFlight = performDispose().finally(() => {
          disposeInFlight = undefined;
        });
      }
      await disposeInFlight;
    }
  };
}

export async function withPlatformTestDatabase<T>(
  run: (database: PlatformTestDatabase) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<T> {
  const database = await createPlatformTestDatabase(env);
  let result: T | undefined;
  let runError: unknown;
  try {
    result = await run(database);
  } catch (error) {
    runError = error;
  }

  try {
    await database.dispose();
  } catch (cleanupError) {
    if (runError) {
      throw new AggregateError(
        [runError, cleanupError],
        `PLATFORM_TEST_CALLBACK_AND_CLEANUP_FAILED:${database.databaseName}`
      );
    }
    throw cleanupError;
  }
  if (runError) throw runError;
  return result as T;
}

function parseHarnessUrls(env: NodeJS.ProcessEnv) {
  const migrationKey = env.PDF_APPROVAL_PLATFORM_TEST_DATABASE_URL?.trim()
    ? "PDF_APPROVAL_PLATFORM_TEST_DATABASE_URL"
    : "PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL";
  const parsed = {
    admin: parseDatabaseUrl(env, "PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL"),
    migration: parseDatabaseUrl(env, migrationKey),
    web: parseDatabaseUrl(env, "PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL"),
    worker: parseDatabaseUrl(env, "PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL"),
    bootstrap: parseDatabaseUrl(env, "PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL")
  };
  const adminHost = parsed.admin.url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(adminHost)) {
    throw new Error("PLATFORM_TEST_ADMIN_MUST_BE_LOCAL");
  }
  if (databaseFromUrl(parsed.admin.url) !== "postgres") {
    throw new Error("PLATFORM_TEST_ADMIN_DATABASE_MUST_BE_POSTGRES");
  }
  return parsed;
}

function parseDatabaseUrl(env: NodeJS.ProcessEnv, key: string): ParsedDatabaseUrl {
  const value = requiredEnv(env, key);
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !databaseFromUrl(url)) throw new Error();
    return { key, value, url };
  } catch {
    throw new Error(`PLATFORM_TEST_DATABASE_URL_INVALID:${key}`);
  }
}

function databaseFromUrl(url: URL) {
  return decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ""));
}

function replaceDatabase(connectionString: string, databaseName: string) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`PLATFORM_TEST_CONFIG_MISSING:${key}`);
  return value;
}

function quoteIdentifier(value: string) {
  if (!/^[a-z][a-z0-9_]+$/.test(value)) throw new Error("INVALID_TEST_DATABASE_NAME");
  return `"${value}"`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
