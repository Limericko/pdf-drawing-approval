import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { createRateLimitService } from "./rateLimitService.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let firstPool: PlatformPool;
let secondPool: PlatformPool;

const policy = { windowSeconds: 60, limit: 2, blockSeconds: 120 } as const;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  const config = { poolMax: 1, connectTimeoutMs: 2_000, queryTimeoutMs: 5_000,
    lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 };
  firstPool = createPlatformPool({ ...config, connectionString: database.urls.web }, "rate-limit-first");
  secondPool = createPlatformPool({ ...config, connectionString: database.urls.web }, "rate-limit-second");
});

afterAll(async () => {
  await secondPool?.end();
  await firstPool?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.security_rate_limit_buckets");
});

describe("RateLimitService", () => {
  it("shares attempts across pools while isolating operation and scope domains", async () => {
    const first = createRateLimitService({ pool: firstPool });
    const second = createRateLimitService({ pool: secondPool });
    const accountKey = Buffer.alloc(32, 7);

    await expect(first.consumeAccount({ operation: "authentication.login", accountKey, policy }))
      .resolves.toMatchObject({ blocked: false, attemptCount: 1 });
    await expect(second.consumeAccount({ operation: "authentication.login", accountKey, policy }))
      .resolves.toMatchObject({ blocked: true, attemptCount: 2 });
    await expect(first.consumeAccount({ operation: "authentication.login", accountKey, policy }))
      .resolves.toMatchObject({ blocked: true, attemptCount: 3 });

    await expect(second.consumeAccount({ operation: "authentication.mfa", accountKey, policy }))
      .resolves.toMatchObject({ blocked: false, attemptCount: 1 });
    await expect(second.consumeIp({ operation: "authentication.login", sourceIpPrefix: accountKey.toString("hex"), policy }))
      .resolves.toMatchObject({ blocked: false, attemptCount: 1 });
    await expect(migration.query("SELECT count(*)::int AS count FROM platform.security_rate_limit_buckets"))
      .resolves.toMatchObject({ rows: [{ count: 3 }] });
  });

  it("supports an IP-first then known-account flow without consuming an account bucket early", async () => {
    const service = createRateLimitService({ pool: firstPool });

    await service.consumeIp({ operation: "invitation.prepare", sourceIpPrefix: "203.0.113.0/24", policy });
    await expect(migration.query(`SELECT bucket_type,count(*)::int AS count
      FROM platform.security_rate_limit_buckets GROUP BY bucket_type`))
      .resolves.toMatchObject({ rows: [{ bucket_type: "ip-prefix", count: 1 }] });

    await service.consumeAccount({ operation: "invitation.prepare", accountKey: Buffer.alloc(32, 9), policy });
    await expect(migration.query(`SELECT bucket_type,count(*)::int AS count
      FROM platform.security_rate_limit_buckets GROUP BY bucket_type ORDER BY bucket_type`))
      .resolves.toMatchObject({ rows: [
        { bucket_type: "account", count: 1 },
        { bucket_type: "ip-prefix", count: 1 }
      ] });
  });

  it("rejects invalid operations, identities and fail-open policies", async () => {
    const service = createRateLimitService({ pool: firstPool });
    await expect(service.consumeIp({ operation: "", sourceIpPrefix: "203.0.113.0/24", policy }))
      .rejects.toMatchObject({ code: "RATE_LIMIT_INPUT_INVALID" });
    await expect(service.consumeIp({ operation: "authentication.login", sourceIpPrefix: "bad\nvalue", policy }))
      .rejects.toMatchObject({ code: "RATE_LIMIT_INPUT_INVALID" });
    await expect(service.consumeAccount({ operation: "authentication.login", accountKey: Buffer.alloc(0), policy }))
      .rejects.toMatchObject({ code: "RATE_LIMIT_INPUT_INVALID" });
    await expect(service.consumeAccount({ operation: "authentication.login", accountKey: Buffer.alloc(32),
      policy: { ...policy, limit: 0 } })).rejects.toMatchObject({ code: "RATE_LIMIT_POLICY_INVALID" });
    await expect(migration.query("SELECT count(*)::int AS count FROM platform.security_rate_limit_buckets"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("sanitizes PostgreSQL dependency failures", async () => {
    const service = createRateLimitService({ pool: failingPool("database password must not leak") });

    const error = await service.consumeIp({ operation: "authentication.login",
      sourceIpPrefix: "203.0.113.0/24", policy }).then(() => undefined, (failure: unknown) => failure);

    expect(error).toMatchObject({ code: "RATE_LIMIT_DEPENDENCY_UNAVAILABLE",
      message: "RATE_LIMIT_DEPENDENCY_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain("database password must not leak");
  });
});

function failingPool(message: string) {
  return {
    transactionTimeouts: { queryTimeoutMs: 1_000, lockTimeoutMs: 1_000, transactionTimeoutMs: 1_000 },
    async connect() { throw new Error(message); }
  } as never;
}
