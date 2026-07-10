import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPlatformTestDatabase, withPlatformTestDatabase } from "./postgresHarness.ts";

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
  it("creates an isolated database where all four restricted roles can connect, then drops it", async () => {
    const database = await createPlatformTestDatabase();
    expect(await databaseExists(database.databaseName)).toBe(true);

    for (const role of ["migration", "web", "worker", "bootstrap"] as const) {
      const rolePool = database.createPool(role);
      const result = await rolePool.query<{ current_user: string }>("SELECT current_user");
      expect(result.rows[0]?.current_user).toBe(`platform_${role}`);
    }

    await database.dispose();
    await database.dispose();
    expect(await databaseExists(database.databaseName)).toBe(false);
  });

  it("drops the isolated database when the callback fails", async () => {
    let databaseName = "";

    await expect(
      withPlatformTestDatabase(async (database) => {
        databaseName = database.databaseName;
        throw new Error("callback failed");
      })
    ).rejects.toThrow("callback failed");

    expect(databaseName).not.toBe("");
    expect(await databaseExists(databaseName)).toBe(false);
  });
});
