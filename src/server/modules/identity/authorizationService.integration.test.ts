import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createAuthorizationService } from "./authorizationService.ts";
import { PostgresProjectRepository } from "./repositories/postgres/PostgresProjectRepository.ts";
import { PostgresUserRepository } from "./repositories/postgres/PostgresUserRepository.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "authorization-test");
});

afterAll(async () => {
  await web?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.projects CASCADE");
  await migration.query("TRUNCATE platform.users CASCADE");
  await migration.query("TRUNCATE platform.audit_events");
});

describe("AuthorizationService", () => {
  it("returns active memberships with explicit capabilities in the session context", async () => {
    const admin = await createUser("context-admin@example.test", "admin");
    const first = await new PostgresProjectRepository(migration).create({ name: "Turbine", status: "active",
      createdByUserId: admin.id });
    const second = await new PostgresProjectRepository(migration).create({ name: "Archived", status: "archived",
      createdByUserId: admin.id });
    await migration.query("UPDATE platform.project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [second.project.id, admin.id]);

    const context = await service().getSessionContext({ userId: admin.id });

    expect(context.user).not.toHaveProperty("passwordHash");
    expect(context.globalCapabilities).toEqual(["platform.security.manage", "projects.create"]);
    expect(context.projects).toEqual([
      expect.objectContaining({ id: second.project.id, name: "Archived", role: "viewer",
        capabilities: ["project.read"] }),
      expect.objectContaining({ id: first.project.id, name: "Turbine", role: "manager",
        capabilities: expect.arrayContaining(["project.read", "project.invitations.create"]) })
    ]);
    await expect(service().getProjectAccess({ projectId: first.project.id, userId: admin.id }))
      .resolves.toMatchObject({ members: [{ userId: admin.id, displayName: "context-admin", role: "manager", status: "active" }] });
  });

  it("uses the same not-found result for missing projects, non-members and disabled memberships", async () => {
    const owner = await createUser("owner@example.test", "member");
    const outsider = await createUser("outsider@example.test", "admin");
    const created = await new PostgresProjectRepository(migration).create({ name: "Restricted", status: "active",
      createdByUserId: owner.id });

    await expect(service().getProjectAccess({ projectId: created.project.id, userId: outsider.id }))
      .rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(service().getProjectAccess({ projectId: "01890f1e-9b4a-7cc2-8f00-000000000099",
      userId: outsider.id })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await migration.query("UPDATE platform.project_members SET status='disabled' WHERE project_id=$1 AND user_id=$2",
      [created.project.id, owner.id]);
    await expect(service().getProjectAccess({ projectId: created.project.id, userId: owner.id }))
      .rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("creates a project for an active admin with an active manager membership and one audit", async () => {
    const admin = await createUser("create-admin@example.test", "admin");

    const result = await service().createProject({ name: "  Pump Housing  ", actorUserId: admin.id,
      requestId: "project-create-request" });

    expect(result).toMatchObject({ project: { name: "Pump Housing", status: "active" },
      membership: { userId: admin.id, role: "manager", status: "active" } });
    await expect(migration.query(`SELECT actor_user_id,target_id,request_id,result,metadata
      FROM platform.audit_events WHERE action='project.create'`)).resolves.toMatchObject({ rows: [{
        actor_user_id: admin.id, target_id: result.project.id, request_id: "project-create-request",
        result: "success", metadata: { projectId: result.project.id }
      }] });
  });

  it("denies non-admin and disabled actors without creating a project", async () => {
    const member = await createUser("create-member@example.test", "member");
    const disabled = await createUser("create-disabled@example.test", "admin", "disabled");
    for (const actorUserId of [member.id, disabled.id]) {
      await expect(service().createProject({ name: "Denied", actorUserId, requestId: "denied-project" }))
        .rejects.toMatchObject({ code: "AUTHORIZATION_FORBIDDEN" });
    }
    await expect(migration.query("SELECT count(*)::int AS count FROM platform.projects"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("rolls project and creator membership back when success audit fails", async () => {
    const admin = await createUser("rollback-admin@example.test", "admin");
    await migration.query(`CREATE FUNCTION platform.reject_project_audit() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'synthetic audit secret'; END $$`);
    await migration.query(`CREATE TRIGGER reject_project_audit BEFORE INSERT ON platform.audit_events
      FOR EACH ROW WHEN (NEW.action='project.create') EXECUTE FUNCTION platform.reject_project_audit()`);
    try {
      await expect(service().createProject({ name: "Rollback", actorUserId: admin.id,
        requestId: "rollback-project" })).rejects.toMatchObject({ code: "AUTHORIZATION_DEPENDENCY_UNAVAILABLE" });
      await expect(migration.query(`SELECT
        (SELECT count(*) FROM platform.projects)::int AS projects,
        (SELECT count(*) FROM platform.project_members)::int AS memberships,
        (SELECT count(*) FROM platform.audit_events)::int AS audits`))
        .resolves.toMatchObject({ rows: [{ projects: 0, memberships: 0, audits: 0 }] });
    } finally {
      await migration.query("DROP TRIGGER reject_project_audit ON platform.audit_events");
      await migration.query("DROP FUNCTION platform.reject_project_audit()");
    }
  });
});

function service() {
  return createAuthorizationService({ pool: web });
}

function createUser(email: string, platformRole: "admin" | "member", status: "active" | "disabled" = "active") {
  return new PostgresUserRepository(migration).create({ email, displayName: email.split("@")[0]!,
    passwordHash: "$argon2id$seed", platformRole, status, mfaEnabledAt: new Date() });
}
