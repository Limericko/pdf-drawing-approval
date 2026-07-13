import type { PlatformPool } from "../../../src/server/platform/database/pool.ts";
import { v7 as uuidv7 } from "uuid";
import { createBootstrapAdminService } from "../../../src/server/modules/identity/bootstrapAdminService.ts";
import { loadPlatformConfig } from "../../../src/server/platform/config/loadPlatformConfig.ts";
import { runMigrations } from "../../../src/server/platform/database/migrationRunner.ts";
import type { PlatformTestDatabase } from "../../../src/server/platform/testing/postgresHarness.ts";
import { totpAt } from "../../../src/server/platform/security/totp.ts";

export const platformE2EAdmin = Object.freeze({
  email: "phase1-admin@example.test",
  displayName: "Phase 1 E2E Admin",
  password: "Phase1-E2E-Admin-Password-42!"
});
export const platformE2EAdminTotpSecret = Buffer.from("phase1-e2e-totp-001!", "utf8");
const passwordHashOptions = Object.freeze({ memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });

export type PlatformE2ESeed = {
  readonly adminEmail: string;
  readonly unauthorizedProjectId: string;
};

export async function seedPlatformE2E(database: PlatformTestDatabase, env: NodeJS.ProcessEnv): Promise<PlatformE2ESeed> {
  const migrationPool = database.createPool("migration");
  await runMigrations(migrationPool);
  const bootstrapConfig = loadPlatformConfig({ ...env, NODE_ENV: "test",
    PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL: database.urls.bootstrap }, "bootstrap-admin");
  const bootstrapPool = database.createPool("bootstrap") as PlatformPool;
  Object.defineProperty(bootstrapPool, "transactionTimeouts", { value: Object.freeze({
    queryTimeoutMs: bootstrapConfig.database.queryTimeoutMs,
    lockTimeoutMs: bootstrapConfig.database.lockTimeoutMs,
    transactionTimeoutMs: bootstrapConfig.database.transactionTimeoutMs
  }) });
  const bootstrap = createBootstrapAdminService({
    pool: bootstrapPool,
    keyrings: bootstrapConfig.keyrings,
    passwordHashOptions,
    generateTotpSecret: () => Buffer.from(platformE2EAdminTotpSecret)
  });
  const challenge = await bootstrap.prepare(platformE2EAdmin);
  await challenge.complete(totpAt(platformE2EAdminTotpSecret, Date.now()));
  const unauthorizedProjectId = uuidv7();
  await migrationPool.query("INSERT INTO platform.projects (id, name, status) VALUES ($1, $2, 'active')",
    [unauthorizedProjectId, "隔离的未授权项目"]);
  return { adminEmail: platformE2EAdmin.email, unauthorizedProjectId };
}
