import type { PlatformPool } from "../../../src/server/platform/database/pool.ts";
import { v7 as uuidv7 } from "uuid";
import { createBootstrapAdminService } from "../../../src/server/modules/identity/bootstrapAdminService.ts";
import { loadPlatformConfig } from "../../../src/server/platform/config/loadPlatformConfig.ts";
import { runMigrations } from "../../../src/server/platform/database/migrationRunner.ts";
import type { PlatformTestDatabase } from "../../../src/server/platform/testing/postgresHarness.ts";
import { totpAt } from "../../../src/server/platform/security/totp.ts";
import { hashPassword } from "../../../src/server/platform/security/passwords.ts";
import { encryptSecret } from "../../../src/server/platform/security/secretEncryption.ts";

export const platformE2EAdmin = Object.freeze({
  email: "phase1-admin@example.test",
  displayName: "Phase 1 E2E Admin",
  password: "Phase1-E2E-Admin-Password-42!"
});
export const platformE2EAdminTotpSecret = Buffer.from("phase1-e2e-totp-001!", "utf8");
export const platformE2EBusinessUsers = Object.freeze({
  designer: Object.freeze({ email: "phase4-designer@example.test", displayName: "Phase 4 设计师",
    password: "Phase4-E2E-Designer-Password-42!", secret: Buffer.from("phase4-design-001xxx", "utf8") }),
  supervisor: Object.freeze({ email: "phase4-supervisor@example.test", displayName: "Phase 4 主管",
    password: "Phase4-E2E-Supervisor-Password-42!", secret: Buffer.from("phase4-superv-001xxx", "utf8") }),
  process: Object.freeze({ email: "phase4-process@example.test", displayName: "Phase 4 工艺",
    password: "Phase4-E2E-Process-Password-42!", secret: Buffer.from("phase4-proc-0001xxxx", "utf8") })
});
const passwordHashOptions = Object.freeze({ memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });

export type PlatformE2ESeed = {
  readonly adminEmail: string;
  readonly unauthorizedProjectId: string;
  readonly businessProjectId: string;
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
  const businessProjectId = uuidv7();
  await migrationPool.query(
    "INSERT INTO platform.projects (id, name, status) VALUES ($1, $2, 'active'),($3,$4,'active')",
    [unauthorizedProjectId, "隔离的未授权项目", businessProjectId, "Phase 4 工程图纸协同"]);
  for (const [role, account] of Object.entries(platformE2EBusinessUsers) as Array<
    ["designer" | "supervisor" | "process", (typeof platformE2EBusinessUsers)[keyof typeof platformE2EBusinessUsers]]>) {
    const userId = uuidv7();
    const enabledAt = new Date();
    const encrypted = encryptSecret(Buffer.from(account.secret), bootstrapConfig.keyrings.totpEncryption);
    await migrationPool.query(
      `INSERT INTO platform.users
        (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status,mfa_enabled_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'member','active','enabled',$5,$5,$5)`,
      [userId, account.email, account.displayName, await hashPassword(account.password, passwordHashOptions), enabledAt]
    );
    await migrationPool.query(
      `INSERT INTO platform.totp_credentials (id,user_id,encrypted_secret,key_version,confirmed_at)
       VALUES ($1,$2,$3,$4,clock_timestamp())`,
      [uuidv7(), userId, encrypted.encryptedSecret, encrypted.keyVersion]
    );
    await migrationPool.query(
      `INSERT INTO platform.project_members (id,project_id,user_id,role,status)
       VALUES ($1,$2,$3,$4,'active')`, [uuidv7(), businessProjectId, userId, role]
    );
  }
  return { adminEmail: platformE2EAdmin.email, unauthorizedProjectId, businessProjectId };
}
