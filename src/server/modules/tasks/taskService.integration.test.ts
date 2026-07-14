import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createTaskService } from "./taskService.ts";

const ids = {
  project: "01890f1e-9b4a-7cc2-8f00-000000000601",
  otherProject: "01890f1e-9b4a-7cc2-8f00-000000000602",
  designer: "01890f1e-9b4a-7cc2-8f00-000000000603",
  supervisor: "01890f1e-9b4a-7cc2-8f00-000000000604",
  process: "01890f1e-9b4a-7cc2-8f00-000000000605",
  admin: "01890f1e-9b4a-7cc2-8f00-000000000606",
  storage: "01890f1e-9b4a-7cc2-8f00-000000000607",
  document: "01890f1e-9b4a-7cc2-8f00-000000000608",
  revision: "01890f1e-9b4a-7cc2-8f00-000000000609",
  approval: "01890f1e-9b4a-7cc2-8f00-00000000060a",
  supervisorDecision: "01890f1e-9b4a-7cc2-8f00-00000000060b",
  processDecision: "01890f1e-9b4a-7cc2-8f00-00000000060c",
  assignedIssue: "01890f1e-9b4a-7cc2-8f00-00000000060d",
  reviewIssue: "01890f1e-9b4a-7cc2-8f00-00000000060e",
  part: "01890f1e-9b4a-7cc2-8f00-00000000060f",
  partLink: "01890f1e-9b4a-7cc2-8f00-000000000610",
  artifact: "01890f1e-9b4a-7cc2-8f00-000000000611",
  job: "01890f1e-9b4a-7cc2-8f00-000000000612",
  backup: "01890f1e-9b4a-7cc2-8f00-000000000613"
} as const;

let database: PlatformTestDatabase;
let migration: Pool;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "task-service-test");
});

afterAll(async () => {
  await web?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.projects CASCADE");
  await migration.query("TRUNCATE platform.users CASCADE");
  await migration.query("TRUNCATE platform.storage_objects CASCADE");
  await migration.query("TRUNCATE platform.jobs,platform.backup_runs");
  await seedTasks();
});

describe("Phase 4 unified task projection", () => {
  it("shows designers only assigned issues and their own PDM metadata work in priority order", async () => {
    const result = await createTaskService({ pool: web }).listMyTasks({ actorUserId: ids.designer });
    expect(result.items.map(({ kind }) => kind)).toEqual(["issue_assigned", "pdm_metadata"]);
    expect(result.items[0]).toMatchObject({ priority: "blocking", dueAt: "2026-07-15T01:00:00.000Z" });
    expect(result.counts).toEqual({ blocking: 1, total: 2 });
  });

  it("shows reviewers their parallel decision and independent issue review without admin alerts", async () => {
    const result = await createTaskService({ pool: web }).listMyTasks({ actorUserId: ids.supervisor });
    expect(result.items.map(({ kind }) => kind)).toEqual(["approval_review", "issue_review"]);
    expect(result.items.every(({ projectId }) => projectId === ids.project)).toBe(true);
  });

  it("adds render, dead-job and backup warnings only to platform administrators", async () => {
    const service = createTaskService({ pool: web });
    const admin = await service.listMyTasks({ actorUserId: ids.admin });
    expect(admin.items.map(({ kind }) => kind)).toEqual([
      "render_failure", "job_failure", "backup_warning", "issue_review", "pdm_metadata"
    ]);
    const projectOnly = await service.listMyTasks({ actorUserId: ids.admin, projectId: ids.project });
    expect(projectOnly.items.map(({ kind }) => kind)).toEqual([
      "render_failure", "issue_review", "pdm_metadata"
    ]);
  });

  it("uses not-found semantics for project scopes without an active membership", async () => {
    await expect(createTaskService({ pool: web }).listMyTasks({
      actorUserId: ids.designer,
      projectId: ids.otherProject
    })).rejects.toMatchObject({ code: "TASK_PROJECT_NOT_FOUND" });
  });
});

async function seedTasks() {
  await migration.query(
    `INSERT INTO platform.users
      (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES
      ($1,'designer@example.test','设计师','$argon2id$seed','member','active','enabled'),
      ($2,'supervisor@example.test','主管','$argon2id$seed','member','active','enabled'),
      ($3,'process@example.test','工艺','$argon2id$seed','member','active','enabled'),
      ($4,'admin@example.test','管理员','$argon2id$seed','admin','active','enabled')`,
    [ids.designer, ids.supervisor, ids.process, ids.admin]
  );
  await migration.query(
    `INSERT INTO platform.projects (id,name,status) VALUES ($1,'E2E 项目','active'),($2,'隔离项目','active')`,
    [ids.project, ids.otherProject]
  );
  await migration.query(
    `INSERT INTO platform.project_members (id,project_id,user_id,role,status)
     VALUES
      ('01890f1e-9b4a-7cc2-8f00-000000000621',$1,$2,'designer','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000622',$1,$3,'supervisor','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000623',$1,$4,'process','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000624',$1,$5,'manager','active')`,
    [ids.project, ids.designer, ids.supervisor, ids.process, ids.admin]
  );
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at)
     VALUES ($1,'ready','filesystem','phase4/task-source.pdf',1024,decode(repeat('62',32),'hex'),
       'application/pdf',clock_timestamp())`,
    [ids.storage]
  );
  await migration.query(
    `INSERT INTO platform.documents (id,project_id,document_code,name,created_by_user_id)
     VALUES ($1,$2,'GX-240714-006','泵体',$3)`,
    [ids.document, ids.project, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.drawing_revisions
      (id,project_id,document_id,revision_code,original_object_id,status,material_code,created_by_user_id,submitted_at)
     VALUES ($1,$2,$3,'A01',$4,'submitted','QT450-10',$5,clock_timestamp())`,
    [ids.revision, ids.project, ids.document, ids.storage, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.approval_cases (id,project_id,revision_id,status,created_by_user_id)
     VALUES ($1,$2,$3,'pending',$4)`,
    [ids.approval, ids.project, ids.revision, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.review_decisions
      (id,project_id,approval_case_id,reviewer_role,assigned_user_id,status)
     VALUES ($1,$2,$3,'supervisor',$4,'pending'),($5,$2,$3,'process',$6,'pending')`,
    [ids.supervisorDecision, ids.project, ids.approval, ids.supervisor,
      ids.processDecision, ids.process]
  );
  await migration.query(
    `INSERT INTO platform.issues
      (id,project_id,approval_case_id,creator_user_id,assignee_user_id,title,description,severity,status,due_at)
     VALUES
      ($1,$2,$3,$4,$5,'基准尺寸缺失','补充基准尺寸','high','open','2026-07-15T01:00:00.000Z'),
      ($6,$2,$3,$4,$5,'材料说明已修订','请复核材料说明','medium','review','2026-07-16T01:00:00.000Z')`,
    [ids.assignedIssue, ids.project, ids.approval, ids.supervisor, ids.designer, ids.reviewIssue]
  );
  await migration.query(
    `INSERT INTO platform.parts (id,project_id,part_number,name) VALUES ($1,$2,'P-006','泵体')`,
    [ids.part, ids.project]
  );
  await migration.query(
    `INSERT INTO platform.part_revision_links (id,project_id,part_id,revision_id,release_status)
     VALUES ($1,$2,$3,$4,'pending_metadata')`,
    [ids.partLink, ids.project, ids.part, ids.revision]
  );
  await migration.query(
    `INSERT INTO platform.render_artifacts
      (id,project_id,approval_case_id,kind,generation,status,error_code,idempotency_key)
     VALUES ($1,$2,$3,'signed_pdf',1,'failed','PDF_RENDER_FAILED','render:task-test')`,
    [ids.artifact, ids.project, ids.approval]
  );
  await migration.query(
    `INSERT INTO platform.jobs
      (id,job_type,payload_version,payload,idempotency_key,status,attempt_count,max_attempts,next_run_at,
       last_error_code,last_error_message,completed_at)
     VALUES ($1,'pdf.render',1,'{}'::jsonb,'job:task-test','dead',5,5,clock_timestamp(),
       'PDF_RENDER_FAILED','safe summary',clock_timestamp())`,
    [ids.job]
  );
  await migration.query(
    `INSERT INTO platform.backup_runs
      (id,provider,status,actor_user_id,completed_at,verification_status,error_code)
     VALUES ($1,'postgres_pitr','failed',$2,clock_timestamp(),'failed','RESTORE_CHECK_FAILED')`,
    [ids.backup, ids.admin]
  );
}
