import { Pool, type PoolClient, type PoolConfig } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPlatformTestDatabase, type PlatformTestDatabase, withPlatformTestDatabase } from "./postgresHarness.ts";

type EndablePoolClient = PoolClient & {
  end(callback?: () => void): Promise<void> | void;
  readonly _ended?: boolean;
};

const adminUrl = process.env.PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error("PLATFORM_TEST_CONFIG_MISSING:PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL");
const verificationPool = new Pool({ connectionString: adminUrl, max: 1 });

afterAll(async () => {
  await verificationPool.end();
});

async function databaseExists(databaseName: string) {
  const result = await verificationPool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [databaseName]
  );
  return result.rows[0]?.exists ?? false;
}

describe("postgresHarness integration", () => {
  it("waits for every registered role backend to exit before dropping the database", async () => {
    let databaseName = "";
    let factoryCalls = 0;
    let sessionsAtDrop: Array<{ pid: number; usename: string }> = [];
    const connectedClients: EndablePoolClient[] = [];
    let releaseClientEnds!: () => void;
    let clientEndsReleased = false;
    const allowClientEnds = new Promise<void>((resolve) => {
      releaseClientEnds = () => {
        if (clientEndsReleased) return;
        clientEndsReleased = true;
        resolve();
      };
    });
    const poolFactory = (config: PoolConfig) => {
      const pool = new Pool(config);
      const isAdmin = factoryCalls === 0;
      factoryCalls += 1;
      if (!isAdmin) {
        pool.on("connect", (client) => {
          const endable = client as EndablePoolClient;
          connectedClients.push(endable);
          const end = endable.end.bind(endable);
          endable.end = ((callback?: () => void) => {
            if (callback) {
              void allowClientEnds.then(() => end(callback));
              return;
            }
            return allowClientEnds.then(() => end());
          }) as EndablePoolClient["end"];
        });
        return pool;
      }
      const query = pool.query.bind(pool);
      return new Proxy(pool, {
        get(target, property, receiver) {
          if (property === "query") return async (text: string, values?: readonly unknown[]) => {
            if (text.startsWith("DROP DATABASE") && databaseName) {
              const observed = await query<{ pid: number; usename: string }>(
                "SELECT pid, usename FROM pg_stat_activity WHERE datname = $1 ORDER BY pid",
                [databaseName]
              );
              sessionsAtDrop = observed.rows;
              releaseClientEnds();
              if (sessionsAtDrop.length > 0) throw new Error("ROLE_BACKENDS_STILL_ACTIVE_AT_DROP");
            }
            const result = await query(text, values ? [...values] : undefined);
            if (text.includes("FROM pg_stat_activity")) releaseClientEnds();
            return result;
          };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    };
    const database = await createPlatformTestDatabase(process.env, { poolFactory });
    databaseName = database.databaseName;
    try {
      for (const role of ["migration", "web", "worker", "bootstrap"] as const) {
        for (let index = 0; index < 3; index += 1) {
          const rolePool = database.createPool(role);
          await rolePool.query("SELECT current_user");
        }
      }

      await database.dispose();
      expect(sessionsAtDrop).toEqual([]);
      expect(connectedClients.every((client) => client._ended === true)).toBe(true);
    } finally {
      releaseClientEnds();
      await database.dispose();
    }
  });

  it("creates an isolated database where all four restricted roles can connect, then drops it", async () => {
    let databaseName = "";
    let databaseAfterCleanup!: PlatformTestDatabase;

    await withPlatformTestDatabase(async (database) => {
      databaseName = database.databaseName;
      databaseAfterCleanup = database;
      expect(await databaseExists(database.databaseName)).toBe(true);

      for (const role of ["migration", "web", "worker", "bootstrap"] as const) {
        const rolePool = database.createPool(role);
        const result = await rolePool.query<{ current_user: string }>("SELECT current_user");
        expect(result.rows[0]?.current_user).toBe(`platform_${role}`);
      }
    });

    await databaseAfterCleanup.dispose();
    expect(await databaseExists(databaseName)).toBe(false);
  });

  it("drops the isolated database when role verification fails after connecting", async () => {
    let databaseName = "";

    await expect(
      withPlatformTestDatabase(async (database) => {
        databaseName = database.databaseName;
        const rolePool = database.createPool("web");
        const result = await rolePool.query<{ current_user: string }>("SELECT current_user");
        expect(result.rows[0]?.current_user).toBe("platform_web");
        throw new Error("role verification failed");
      })
    ).rejects.toThrow("role verification failed");

    expect(databaseName).not.toBe("");
    expect(await databaseExists(databaseName)).toBe(false);
  });
});
