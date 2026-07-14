import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createIssueService } from "./issueService.ts";

const ids = {
  project: "01890f1e-9b4a-7cc2-8f00-000000000f01",
  otherProject: "01890f1e-9b4a-7cc2-8f00-000000000f02",
  designer: "01890f1e-9b4a-7cc2-8f00-000000000f03",
  supervisor: "01890f1e-9b4a-7cc2-8f00-000000000f04",
  manager: "01890f1e-9b4a-7cc2-8f00-000000000f05",
  storage: "01890f1e-9b4a-7cc2-8f00-000000000f06",
  document: "01890f1e-9b4a-7cc2-8f00-000000000f07",
  revision: "01890f1e-9b4a-7cc2-8f00-000000000f08",
  approval: "01890f1e-9b4a-7cc2-8f00-000000000f09"
} as const;

let database: PlatformTestDatabase;
let migration: Pool;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 5, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "issue-service-test");
});
afterAll(async () => { await web?.end(); await database?.dispose(); });
beforeEach(async () => {
  await migration.query("TRUNCATE platform.projects,platform.users,platform.storage_objects,platform.audit_events CASCADE");
  await seed();
});

describe("issue service", () => {
  it("creates an annotation atomically and closes the assignee/reviewer workflow with idempotent commands", async () => {
    const service = createIssueService({ pool: web });
    const create = { projectId: ids.project, approvalId: ids.approval, actorUserId: ids.supervisor,
      requestId: "issue-create", issue: { title: "密封面尺寸需复核", description: "公差与总装要求不一致",
        severity: "high" as const, assigneeUserId: ids.designer, dueAt: null,
        annotation: { kind: "rect" as const, pageNumber: 1, geometry: { x: 0.2, y: 0.3, w: 0.1, h: 0.08 },
          style: { color: "#b64b3c" }, message: "请核对该处尺寸" }, idempotencyKey: "issue:create:seal:1" } };
    const created = await service.createIssue(create);
    await expect(service.createIssue({ ...create, requestId: "issue-create-retry" })).resolves.toEqual(created);
    expect(created).toMatchObject({ status: "open", severity: "high", annotationId: expect.any(String),
      annotation: { kind: "rect", pageNumber: 1, geometry: { x: 0.2, y: 0.3, w: 0.1, h: 0.08 }, message: "请核对该处尺寸" } });
    await expect(service.listIssues({ projectId: ids.project, actorUserId: ids.supervisor, approvalCaseId: ids.approval,
      page: 1, pageSize: 20 })).resolves.toMatchObject({ items: [expect.objectContaining({ id: created.id,
      annotation: expect.objectContaining({ id: created.annotationId }) })] });

    const started = await service.startIssue({ projectId: ids.project, issueId: created.id,
      actorUserId: ids.designer, requestId: "issue-start",
      update: { version: created.version, idempotencyKey: "issue:start:seal:1" } });
    await expect(service.startIssue({ projectId: ids.project, issueId: created.id,
      actorUserId: ids.designer, requestId: "issue-start-retry",
      update: { version: created.version, idempotencyKey: "issue:start:seal:1" } })).resolves.toEqual(started);
    const submitted = await service.submitIssue({ projectId: ids.project, issueId: created.id,
      actorUserId: ids.designer, requestId: "issue-submit",
      update: { version: started.version, resolutionSummary: "已按总装公差修订",
        idempotencyKey: "issue:submit:seal:1" } });
    const closed = await service.reviewIssue({ projectId: ids.project, issueId: created.id,
      actorUserId: ids.supervisor, requestId: "issue-close",
      update: { version: submitted.version, decision: "closed", note: "复核通过",
        idempotencyKey: "issue:review:seal:1" } });
    expect(closed.status).toBe("closed");
    await expect(migration.query(
      "SELECT event_type FROM platform.issue_events WHERE issue_id=$1 ORDER BY created_at,id", [created.id]
    )).resolves.toMatchObject({ rows: [{ event_type: "created" }, { event_type: "started" },
      { event_type: "submitted" }, { event_type: "closed" }] });
  });

  it("enforces assignee, reviewer, manager and project isolation boundaries", async () => {
    const service = createIssueService({ pool: web });
    const created = await service.createIssue({ projectId: ids.project, approvalId: ids.approval,
      actorUserId: ids.supervisor, requestId: "issue-boundary-create",
      issue: { title: "材料牌号缺失", description: "标题栏缺少材料", severity: "medium",
        assigneeUserId: ids.designer, dueAt: null, annotation: null,
        idempotencyKey: "issue:create:boundary:1" } });
    await expect(service.startIssue({ projectId: ids.project, issueId: created.id,
      actorUserId: ids.supervisor, requestId: "issue-wrong-assignee",
      update: { version: created.version, idempotencyKey: "issue:start:wrong:1" } }))
      .rejects.toMatchObject({ code: "ISSUE_FORBIDDEN" });
    const forced = await service.forceCloseIssue({ projectId: ids.project, issueId: created.id,
      actorUserId: ids.manager, requestId: "issue-force-close",
      update: { version: created.version, reason: "重复问题，合并到主问题单",
        idempotencyKey: "issue:force:boundary:1" } });
    expect(forced.status).toBe("closed");
    await expect(service.getIssue({ projectId: ids.otherProject, issueId: created.id,
      actorUserId: ids.manager })).rejects.toMatchObject({ code: "ISSUE_NOT_FOUND" });
  });
});

async function seed() {
  await migration.query(
    `INSERT INTO platform.users (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES ($1,'designer@example.test','设计师','$argon2id$seed','member','active','enabled'),
      ($2,'supervisor@example.test','主管','$argon2id$seed','member','active','enabled'),
      ($3,'manager@example.test','管理员','$argon2id$seed','admin','active','enabled')`,
    [ids.designer, ids.supervisor, ids.manager]
  );
  await migration.query("INSERT INTO platform.projects (id,name,status) VALUES ($1,'项目A','active'),($2,'项目B','active')",
    [ids.project, ids.otherProject]);
  await migration.query(
    `INSERT INTO platform.project_members (id,project_id,user_id,role,status) VALUES
      ('01890f1e-9b4a-7cc2-8f00-000000000f11',$1,$2,'designer','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000f12',$1,$3,'supervisor','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000f13',$1,$4,'manager','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000f14',$5,$4,'manager','active')`,
    [ids.project, ids.designer, ids.supervisor, ids.manager, ids.otherProject]
  );
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at,created_at)
     VALUES ($1,'ready','filesystem','issue/source',100,decode(repeat('21',32),'hex'),'application/pdf',
       clock_timestamp(),clock_timestamp() - interval '1 second')`, [ids.storage]
  );
  await migration.query(
    "INSERT INTO platform.documents (id,project_id,document_code,name,created_by_user_id) VALUES ($1,$2,'GX-ISSUE-01','阀体',$3)",
    [ids.document, ids.project, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.drawing_revisions
      (id,project_id,document_id,revision_code,original_object_id,status,created_by_user_id,submitted_at,created_at)
     VALUES ($1,$2,$3,'A01',$4,'submitted',$5,clock_timestamp(),clock_timestamp() - interval '1 second')`,
    [ids.revision, ids.project, ids.document, ids.storage, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.approval_cases (id,project_id,revision_id,status,created_by_user_id)
     VALUES ($1,$2,$3,'pending',$4)`, [ids.approval, ids.project, ids.revision, ids.designer]
  );
}
