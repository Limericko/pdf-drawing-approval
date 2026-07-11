import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll } from "vitest";
import { runMigrations } from "../../../platform/database/migrationRunner.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../../platform/testing/postgresHarness.ts";
import { securityRepositoriesContract, type SecurityRepositoryContractContext, type SecurityRepositoryFactory } from "./contracts/securityRepositories.contract.ts";
import { PostgresAuditRepository } from "./postgres/PostgresAuditRepository.ts";
import { PostgresInvitationRepository } from "./postgres/PostgresInvitationRepository.ts";
import { PostgresMfaRepository } from "./postgres/PostgresMfaRepository.ts";
import { PostgresProjectRepository } from "./postgres/PostgresProjectRepository.ts";
import { PostgresRateLimitRepository } from "./postgres/PostgresRateLimitRepository.ts";
import { PostgresSessionRepository } from "./postgres/PostgresSessionRepository.ts";
import { PostgresUserRepository } from "./postgres/PostgresUserRepository.ts";

let database: PlatformTestDatabase;
let migration: Pool;
let primary: Pool;
let concurrentA: Pool;
let concurrentB: Pool;
let sequence = 0;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  primary = database.createPool("web");
  concurrentA = database.createPool("web");
  concurrentB = database.createPool("web");
});

afterAll(async () => {
  await database?.dispose();
});

const createRepositories: SecurityRepositoryFactory = (executor) => ({
  mfa: new PostgresMfaRepository(executor),
  sessions: new PostgresSessionRepository(executor),
  rateLimits: new PostgresRateLimitRepository(executor),
  audit: new PostgresAuditRepository(executor)
});

securityRepositoriesContract({
  createRepositories,
  getContext(): SecurityRepositoryContractContext {
    return {
      primary,
      concurrentA,
      concurrentB,
      migration,
      async createUser() {
        sequence += 1;
        return new PostgresUserRepository(primary).create({
          email: `security-${sequence}@example.test`,
          displayName: "Security Contract User",
          passwordHash: "$argon2id$v=19$contract",
          platformRole: "member",
          status: "active"
        });
      },
      async createInvitation() {
        const inviter = await this.createUser();
        const { project } = await new PostgresProjectRepository(primary).create({
          name: `Security Contract Project ${sequence}`,
          status: "active",
          createdByUserId: inviter.id
        });
        return new PostgresInvitationRepository(primary).create({
          tokenHash: randomBytes(32),
          tokenKeyVersion: "v1",
          email: `security-invite-${sequence}@example.test`,
          platformRole: "member",
          projectId: project.id,
          projectRole: "viewer",
          invitedByUserId: inviter.id
        });
      }
    };
  }
});
