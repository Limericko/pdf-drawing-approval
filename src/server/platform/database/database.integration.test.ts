import { describe, expect, it } from "vitest";
import type { PlatformDatabaseConfig } from "../config/types.ts";
import { type PlatformTestDatabase, withPlatformTestDatabase } from "../testing/postgresHarness.ts";
import { createPlatformPool, type PlatformPool } from "./pool.ts";
import { withTransaction } from "./transaction.ts";

type IntegrationContext = {
  pool: PlatformPool;
};

async function withDatabase(run: (context: IntegrationContext) => Promise<void>) {
  await withPlatformTestDatabase(async (database) => {
    await prepareTestTable(database);
    const config: PlatformDatabaseConfig = {
      connectionString: database.urls.web,
      poolMax: 1,
      connectTimeoutMs: 2_000,
      queryTimeoutMs: 50,
      lockTimeoutMs: 100,
      transactionTimeoutMs: 1_000
    };
    const pool = createPlatformPool(config, "pdf-approval-database-integration-test");
    try {
      await run({ pool });
    } finally {
      await pool.end();
    }
  });
}

async function prepareTestTable(database: PlatformTestDatabase) {
  const migrationPool = database.createPool("migration");
  await migrationPool.query("CREATE SCHEMA platform AUTHORIZATION platform_migration");
  await migrationPool.query("CREATE TABLE platform.test_items (name text PRIMARY KEY)");
  await migrationPool.query("GRANT USAGE ON SCHEMA platform TO platform_web");
  await migrationPool.query("GRANT SELECT, INSERT ON platform.test_items TO platform_web");
}

describe("database transaction integration", () => {
  it("commits a parameterized insert and returns the callback value", async () => {
    await withDatabase(async ({ pool }) => {
      const hostileValue = "committed'); DROP TABLE platform.test_items; --";

      const result = await withTransaction(pool, async (tx) => {
        await tx.query("INSERT INTO platform.test_items(name) VALUES ($1)", [hostileValue]);
        return "ok";
      });

      expect(result).toBe("ok");
      const rows = await pool.query<{ name: string }>("SELECT name FROM platform.test_items");
      expect(rows.rows).toEqual([{ name: hostileValue }]);
    });
  });

  it("rolls back writes when the callback throws and releases the client", async () => {
    await withDatabase(async ({ pool }) => {
      await expect(
        withTransaction(pool, async (tx) => {
          await tx.query("INSERT INTO platform.test_items(name) VALUES ($1)", ["rolled-back"]);
          throw new Error("abort transaction");
        })
      ).rejects.toThrow("abort transaction");

      const count = await pool.query<{ count: string }>("SELECT count(*) FROM platform.test_items");
      expect(count.rows[0]?.count).toBe("0");
      expect(pool.idleCount).toBe(1);
    });
  });

  it("rolls back a statement timeout and reuses the same physical connection", async () => {
    await withDatabase(async ({ pool }) => {
      let timedOutBackendPid: number | undefined;

      await expect(
        withTransaction(pool, async (tx) => {
          const backend = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          timedOutBackendPid = backend.rows[0]?.pid;
          await tx.query("SELECT pg_sleep($1)", [0.2]);
        })
      ).rejects.toMatchObject({ code: "57014" });

      const reused = await pool.query<{ pid: number; value: number }>(
        "SELECT pg_backend_pid() AS pid, $1::int AS value",
        [42]
      );
      expect(reused.rows[0]).toEqual({ pid: timedOutBackendPid, value: 42 });
    });
  });
});
