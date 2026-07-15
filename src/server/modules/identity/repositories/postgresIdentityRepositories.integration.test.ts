import type { Pool } from "pg";
import { afterAll, beforeAll } from "vitest";
import { runMigrations } from "../../../platform/database/migrationRunner.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../../platform/testing/postgresHarness.ts";
import {
  identityRepositoryContract,
  type IdentityRepositoryContractContext,
  type IdentityRepositoryFactory
} from "./contracts/identityRepository.contract.ts";
import { PostgresInvitationRepository } from "./postgres/PostgresInvitationRepository.ts";
import { PostgresProjectRepository } from "./postgres/PostgresProjectRepository.ts";
import { PostgresUserRepository } from "./postgres/PostgresUserRepository.ts";

let database: PlatformTestDatabase;
let migration: Pool;
let primary: Pool;
let concurrentA: Pool;
let concurrentB: Pool;

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

const createRepositories: IdentityRepositoryFactory = (executor) => ({
  users: new PostgresUserRepository(executor),
  invitations: new PostgresInvitationRepository(executor),
  projects: new PostgresProjectRepository(executor)
});

identityRepositoryContract({
  createRepositories,
  getContext(): IdentityRepositoryContractContext {
    return { primary, concurrentA, concurrentB, migration };
  }
});
