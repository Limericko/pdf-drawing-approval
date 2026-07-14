import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createAdministrationService } from "./administrationService.ts";

const ids = {
  admin1: "01890f1e-9b4a-7cc2-8f00-000000001001",
  admin2: "01890f1e-9b4a-7cc2-8f00-000000001002",
  member: "01890f1e-9b4a-7cc2-8f00-000000001003",
  project: "01890f1e-9b4a-7cc2-8f00-000000001004",
  membership: "01890f1e-9b4a-7cc2-8f00-000000001005",
  session: "01890f1e-9b4a-7cc2-8f00-000000001006",
  job: "01890f1e-9b4a-7cc2-8f00-000000001007",
  backup: "01890f1e-9b4a-7cc2-8f00-000000001008",
  audit: "01890f1e-9b4a-7cc2-8f00-000000001009"
} as const;

let database: PlatformTestDatabase;
let migration: Pool;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 5, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "administration-test");
});
afterAll(async () => { await web?.end(); await database?.dispose(); });
beforeEach(async () => {
  await migration.query("TRUNCATE platform.projects,platform.users,platform.jobs,platform.worker_heartbeats,platform.backup_runs,platform.audit_events CASCADE");
  await seed();
});

describe("administration service", () => {
  it("disables a user, revokes access and deduplicates the dangerous mutation", async () => {
    const service = createAdministrationService({ pool: web, storageHealth: async () => undefined });
    const target = (await service.listUsers({ actorUserId: ids.admin1, page: 1, pageSize: 20 }))
      .items.find(({ id }) => id === ids.member)!;
    const input = { actorUserId: ids.admin1, targetUserId: ids.member, requestId: "admin-disable-member",
      update: { status: "disabled" as const, expectedUpdatedAt: target.updatedAt.toISOString(),
        reason: "员工已离职", idempotencyKey: "admin:user:disable:member" } };
    const changed = await service.setUserStatus(input);
    await expect(service.setUserStatus({ ...input, requestId: "admin-disable-member-retry" })).resolves.toEqual(changed);
    expect(changed).toEqual({ targetId: ids.member, changed: true });
    await expect(migration.query(
      `SELECT user_account.status,membership.status AS membership_status,session.revoked_at IS NOT NULL AS revoked
       FROM platform.users user_account JOIN platform.project_members membership ON membership.user_id=user_account.id
       JOIN platform.sessions session ON session.user_id=user_account.id WHERE user_account.id=$1`, [ids.member]
    )).resolves.toMatchObject({ rows: [{ status: "disabled", membership_status: "disabled", revoked: true }] });
  });

  it("protects the last administrator and enforces optimistic membership updates", async () => {
    const service = createAdministrationService({ pool: web, storageHealth: async () => undefined });
    const users = await service.listUsers({ actorUserId: ids.admin1, page: 1, pageSize: 20 });
    const second = users.items.find(({ id }) => id === ids.admin2)!;
    await service.setUserStatus({ actorUserId: ids.admin1, targetUserId: ids.admin2, requestId: "disable-admin2",
      update: { status: "disabled", expectedUpdatedAt: second.updatedAt.toISOString(), reason: "权限交接",
        idempotencyKey: "admin:user:disable:admin2" } });
    const first = (await service.listUsers({ actorUserId: ids.admin1, page: 1, pageSize: 20 }))
      .items.find(({ id }) => id === ids.admin1)!;
    await expect(service.setUserStatus({ actorUserId: ids.admin1, targetUserId: ids.admin1,
      requestId: "disable-last-admin", update: { status: "disabled",
        expectedUpdatedAt: first.updatedAt.toISOString(), reason: "错误操作",
        idempotencyKey: "admin:user:disable:last" } })).rejects.toMatchObject({ code: "ADMIN_LAST_ADMIN" });

    const membership = await migration.query<{ updated_at: Date }>(
      "SELECT updated_at FROM platform.project_members WHERE id=$1", [ids.membership]
    );
    await expect(service.updateMembership({ actorUserId: ids.admin1, projectId: ids.project,
      membershipId: ids.membership, requestId: "membership-update", update: { role: "viewer", status: "active",
        expectedUpdatedAt: membership.rows[0]!.updated_at.toISOString(), reason: "转为只读协作",
        idempotencyKey: "admin:membership:viewer" } })).resolves.toEqual({ targetId: ids.membership, changed: true });
  });

  it("retries dead jobs and returns bounded diagnostics, backups and redacted audit metadata", async () => {
    const storageHealth = vi.fn(async () => { throw new Error("s3 secret endpoint"); });
    const service = createAdministrationService({ pool: web, storageHealth,
      clock: () => new Date("2026-07-14T08:02:00.000Z") });
    const beforeRetry = await service.getDiagnostics({ actorUserId: ids.admin1 });
    expect(beforeRetry.deadJobs).toEqual([expect.objectContaining({ id: ids.job, jobType: "approval.finalize",
      attemptCount: 5, maxAttempts: 5, errorCode: "TEMPORARY" })]);
    expect(JSON.stringify(beforeRetry.deadJobs)).not.toContain("safe failure");
    await expect(service.retryDeadJob({ actorUserId: ids.admin1, jobId: ids.job, requestId: "retry-job",
      update: { reason: "依赖已恢复", idempotencyKey: "admin:job:retry:1" } }))
      .resolves.toEqual({ targetId: ids.job, changed: true });
    const diagnostics = await service.getDiagnostics({ actorUserId: ids.admin1 });
    expect(diagnostics).toMatchObject({ postgres: "healthy", storage: "unhealthy",
      worker: { status: "healthy" }, queue: { pending: 1, running: 0, dead: 0 },
      deadJobs: [],
      latestBackup: { id: ids.backup, verificationStatus: "passed" } });
    await expect(service.listBackups({ actorUserId: ids.admin1 })).resolves.toMatchObject({
      items: [{ id: ids.backup }]
    });
    const audit = await service.listAudit({ actorUserId: ids.admin1, page: 1, pageSize: 20,
      projectId: ids.project });
    const seeded = audit.items.find(({ id }) => id === ids.audit)!;
    expect(seeded.metadata).toEqual({ projectId: ids.project, reason: "safe" });
    expect(JSON.stringify(audit)).not.toContain("secret-value");
    await expect(service.listUsers({ actorUserId: ids.member, page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "ADMIN_FORBIDDEN" });
  });
});

async function seed() {
  await migration.query(
    `INSERT INTO platform.users (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES ($1,'admin1@example.test','管理员甲','$argon2id$seed','admin','active','enabled'),
      ($2,'admin2@example.test','管理员乙','$argon2id$seed','admin','active','enabled'),
      ($3,'member@example.test','协作成员','$argon2id$seed','member','active','enabled')`,
    [ids.admin1, ids.admin2, ids.member]
  );
  await migration.query("INSERT INTO platform.projects (id,name,status) VALUES ($1,'项目A','active')", [ids.project]);
  await migration.query(
    `INSERT INTO platform.project_members (id,project_id,user_id,role,status)
     VALUES ($1,$2,$3,'designer','active')`, [ids.membership, ids.project, ids.member]
  );
  await migration.query(
    `INSERT INTO platform.sessions
      (id,user_id,token_hash,created_at,absolute_expires_at,idle_expires_at,last_activity_at,last_touch_at)
     VALUES ($1,$2,decode(repeat('31',32),'hex'),'2026-07-14T05:00:00Z','2026-07-14T10:00:00Z',
       '2026-07-14T09:00:00Z','2026-07-14T06:00:00Z','2026-07-14T06:00:00Z')`, [ids.session, ids.member]
  );
  await migration.query(
    `INSERT INTO platform.jobs
      (id,job_type,payload_version,payload,idempotency_key,status,attempt_count,max_attempts,next_run_at,
       last_error_code,last_error_message,completed_at)
     VALUES ($1,'approval.finalize',1,'{}','job:admin-test','dead',5,5,clock_timestamp(),
       'TEMPORARY','safe failure',clock_timestamp())`, [ids.job]
  );
  await migration.query(
    `INSERT INTO platform.worker_heartbeats (worker_id,started_at,heartbeat_at,metadata)
     VALUES ('worker-admin-test','2026-07-14T08:00:00Z','2026-07-14T08:01:30Z',
       '{"state":"active","smtp":"healthy"}')`
  );
  await migration.query(
    `INSERT INTO platform.backup_runs
      (id,provider,status,recovery_point_at,started_at,completed_at,verification_status)
     VALUES ($1,'postgres_pitr','completed','2026-07-14T07:55:00Z','2026-07-14T08:00:00Z',
       '2026-07-14T08:01:00Z','passed')`, [ids.backup]
  );
  await migration.query(
    `INSERT INTO platform.audit_events
      (id,actor_user_id,actor_type,action,target_type,target_id,request_id,result,metadata)
     VALUES ($1,$2,'user','project.read','project',$3,'seed-audit','success',$4)`,
    [ids.audit, ids.admin1, ids.project,
      { projectId: ids.project, reason: "safe", secretToken: "secret-value", nested: { password: "hidden" } }]
  );
}
