import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export type PlatformDatabaseRole = "migration" | "web" | "worker" | "bootstrap";

export type PlatformTestDatabase = {
  readonly databaseName: string;
  readonly urls: Record<PlatformDatabaseRole | "admin", string>;
  createPool(role: PlatformDatabaseRole): Pool;
  dispose(): Promise<void>;
};

export async function createPlatformTestDatabase(env: NodeJS.ProcessEnv = process.env): Promise<PlatformTestDatabase> {
  const adminBaseUrl = requiredEnv(env, "PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL");
  const baseUrls: Record<PlatformDatabaseRole, string> = {
    migration: env.PDF_APPROVAL_PLATFORM_TEST_DATABASE_URL ?? requiredEnv(env, "PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL"),
    web: requiredEnv(env, "PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL"),
    worker: requiredEnv(env, "PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL"),
    bootstrap: requiredEnv(env, "PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL")
  };
  const databaseName = `pdf_approval_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: adminBaseUrl, max: 1 });

  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER platform_migration`);
    await adminPool.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`);
    await adminPool.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO platform_migration, platform_web, platform_worker, platform_bootstrap`
    );
  } catch (error) {
    await adminPool.end();
    throw error;
  }

  const pools = new Set<Pool>();
  let disposed = false;
  const urls = {
    admin: replaceDatabase(adminBaseUrl, databaseName),
    migration: replaceDatabase(baseUrls.migration, databaseName),
    web: replaceDatabase(baseUrls.web, databaseName),
    worker: replaceDatabase(baseUrls.worker, databaseName),
    bootstrap: replaceDatabase(baseUrls.bootstrap, databaseName)
  };

  return {
    databaseName,
    urls,
    createPool(role) {
      if (disposed) throw new Error("PLATFORM_TEST_DATABASE_DISPOSED");
      const pool = new Pool({ connectionString: urls[role] });
      pools.add(pool);
      return pool;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([...pools].map((pool) => pool.end()));
      try {
        await adminPool.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      } finally {
        await adminPool.end();
      }
    }
  };
}

export async function withPlatformTestDatabase<T>(
  run: (database: PlatformTestDatabase) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env
) {
  const database = await createPlatformTestDatabase(env);
  try {
    return await run(database);
  } finally {
    await database.dispose();
  }
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
