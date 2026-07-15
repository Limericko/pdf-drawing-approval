import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BootstrapPlatformConfig } from "../platform/config/types.ts";
import { loadPlatformConfig } from "../platform/config/loadPlatformConfig.ts";
import { loadMigrationFiles } from "../platform/database/migrationFiles.ts";
import { createPlatformPool, type PlatformPool } from "../platform/database/pool.ts";
import { assertExpectedSchema } from "../platform/database/schemaVersion.ts";
import { withTransaction } from "../platform/database/transaction.ts";
import { hashPassword } from "../platform/security/passwords.ts";
import { PostgresAuditRepository } from "../modules/identity/repositories/postgres/PostgresAuditRepository.ts";
import { PostgresUserRepository } from "../modules/identity/repositories/postgres/PostgresUserRepository.ts";

const passwordHashOptions = Object.freeze({ memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 });
const SINGLE_NODE_BOOTSTRAP_LOCK = 1_347_696_962;

export async function runSingleNodeBootstrap(config: BootstrapPlatformConfig) {
  const pool = createPlatformPool(config.database, "platform-single-node-bootstrap");
  try {
    await assertExpectedSchema(pool, await loadMigrationFiles());
    return await ensureSingleNodeAdmin(pool);
  } finally {
    await pool.end();
  }
}

export function ensureSingleNodeAdmin(pool: PlatformPool) {
  return withTransaction(pool, async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock($1)", [SINGLE_NODE_BOOTSTRAP_LOCK]);
      const existing = await transaction.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM platform.users) AS exists");
      if (existing.rows[0]?.exists !== false) return Object.freeze({ created: false as const });
      const passwordHash = await hashPassword("admin123", passwordHashOptions);
      const user = await new PostgresUserRepository(transaction).create({
        username: "admin",
        email: "admin@single-node.invalid",
        displayName: "系统管理员",
        passwordHash,
        platformRole: "admin",
        status: "active",
        passwordChangeRequired: true
      });
      await new PostgresAuditRepository(transaction).appendOnly({
        actorUserId: user.id,
        actorType: "bootstrap",
        action: "admin.bootstrap",
        targetType: "user",
        targetId: user.id,
        requestId: `single-node-bootstrap:${user.id}`,
        result: "success",
        metadata: { reason: "single-node-default-admin" }
      });
      return Object.freeze({ created: true as const });
  });
}

export async function singleNodeBootstrapMain(env: NodeJS.ProcessEnv = process.env) {
  if (env.PDF_APPROVAL_DEPLOYMENT_PROFILE !== "single-node") {
    process.stderr.write("SINGLE_NODE_BOOTSTRAP_PROFILE_REQUIRED\n");
    return 1;
  }
  try {
    const result = await runSingleNodeBootstrap(loadPlatformConfig(env, "bootstrap-admin"));
    process.stdout.write(result.created ? "SINGLE_NODE_ADMIN_CREATED\n" : "SINGLE_NODE_ADMIN_ALREADY_EXISTS\n");
    return 0;
  } catch {
    process.stderr.write("SINGLE_NODE_BOOTSTRAP_FAILED\n");
    return 1;
  }
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) process.exitCode = await singleNodeBootstrapMain();
