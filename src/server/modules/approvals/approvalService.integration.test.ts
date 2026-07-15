import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createApprovalService } from "./approvalService.ts";

const ids = {
  project: "01890f1e-9b4a-7cc2-8f00-000000000301",
  otherProject: "01890f1e-9b4a-7cc2-8f00-000000000302",
  designer: "01890f1e-9b4a-7cc2-8f00-000000000303",
  supervisor: "01890f1e-9b4a-7cc2-8f00-000000000304",
  process: "01890f1e-9b4a-7cc2-8f00-000000000305",
  manager: "01890f1e-9b4a-7cc2-8f00-000000000306",
  outsider: "01890f1e-9b4a-7cc2-8f00-000000000307",
  storage: "01890f1e-9b4a-7cc2-8f00-000000000308"
} as const;

let database: PlatformTestDatabase;
let migration: Pool;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 8, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "approval-service-test");
});

afterAll(async () => {
  await web?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.projects CASCADE");
  await migration.query("TRUNCATE platform.users CASCADE");
  await migration.query("TRUNCATE platform.storage_objects CASCADE");
  await migration.query("TRUNCATE platform.audit_events,platform.outbox_events");
  await seedFoundations();
});

describe("Phase 4 approval service", () => {
  it("creates one idempotent project draft and rejects reuse with different content", async () => {
    const service = createApprovalService({ pool: web });
    const input = draftInput();
    const first = await service.createDraft(input);
    const retried = await service.createDraft({ ...input, requestId: "draft-retry-request" });

    expect(retried).toEqual(first);
    await expect(service.createDraft({ ...input, requestId: "draft-conflict-request",
      draft: { ...input.draft, documentCode: "GX-240714-OTHER" } }))
      .rejects.toMatchObject({ code: "APPROVAL_IDEMPOTENCY_CONFLICT" });
    await expect(migration.query(
      "SELECT count(*)::int AS count FROM platform.drawing_revisions"
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(migration.query(
      "SELECT count(*)::int AS count FROM platform.audit_events WHERE action='document.revision.draft_created'"
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("submits complete signature positions and creates exactly two parallel review decisions", async () => {
    const service = createApprovalService({ pool: web });
    const draft = await service.createDraft(draftInput());
    const submission = submissionInput(draft.revision.id, draft.revision.version);
    const approval = await service.submitRevision(submission);
    const retried = await service.submitRevision({ ...submission, requestId: "submission-retry" });

    expect(retried.id).toBe(approval.id);
    expect(approval.decisions.map((decision) => [decision.reviewerRole, decision.status])).toEqual([
      ["supervisor", "pending"],
      ["process", "pending"]
    ]);
    await expect(migration.query(
      "SELECT signer_role FROM platform.signature_placements WHERE approval_case_id=$1 ORDER BY signer_role",
      [approval.id]
    )).resolves.toMatchObject({ rows: [
      { signer_role: "designer" }, { signer_role: "process" }, { signer_role: "supervisor" }
    ] });
    await expect(migration.query(
      "SELECT count(*)::int AS count FROM platform.audit_events WHERE action='approval.submit'"
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("completes concurrent supervisor and process approvals once and publishes one outbox event", async () => {
    const service = createApprovalService({ pool: web });
    const approval = await createSubmittedApproval(service);
    const [supervisor, process] = await Promise.all([
      service.decide(decisionInput(approval.id, "supervisor", ids.supervisor, "approved", "decision:supervisor:1")),
      service.decide(decisionInput(approval.id, "process", ids.process, "approved", "decision:process:1"))
    ]);

    expect([supervisor.status, process.status]).toContain("approved");
    const completed = await service.getApproval({ projectId: ids.project, approvalId: approval.id,
      actorUserId: ids.designer });
    expect(completed.status).toBe("approved");
    expect(completed.decisions.every(({ status }) => status === "approved")).toBe(true);
    await expect(migration.query(
      "SELECT count(*)::int AS count FROM platform.outbox_events WHERE event_type='approval.completed'"
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(migration.query(
      "SELECT count(*)::int AS count FROM platform.audit_events WHERE action LIKE 'approval.%approved'"
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("blocks approval while an open high issue exists and permits it after independent closure", async () => {
    const service = createApprovalService({ pool: web });
    const approval = await createSubmittedApproval(service);
    const issueId = "01890f1e-9b4a-7cc2-8f00-000000000309";
    await migration.query(
      `INSERT INTO platform.issues
        (id,project_id,approval_case_id,creator_user_id,assignee_user_id,title,description,severity,status)
       VALUES ($1,$2,$3,$4,$5,'尺寸链缺失','请补充尺寸链','high','open')`,
      [issueId, ids.project, approval.id, ids.supervisor, ids.designer]
    );

    await expect(service.decide(
      decisionInput(approval.id, "supervisor", ids.supervisor, "approved", "decision:blocking:1")
    )).rejects.toMatchObject({ code: "OPEN_HIGH_SEVERITY_ISSUES" });
    await migration.query(
      `UPDATE platform.issues SET status='closed',closed_by_user_id=$1,closed_at=clock_timestamp(),
       review_note='复核通过',version=version+1,updated_at=clock_timestamp() WHERE id=$2`,
      [ids.supervisor, issueId]
    );
    await expect(service.decide(
      decisionInput(approval.id, "supervisor", ids.supervisor, "approved", "decision:unblocked:1")
    )).resolves.toMatchObject({ decisions: expect.arrayContaining([
      expect.objectContaining({ reviewerRole: "supervisor", status: "approved" })
    ]) });
  });

  it("returns not found across project boundaries and forbids a viewer from submitting", async () => {
    const service = createApprovalService({ pool: web });
    const draft = await service.createDraft(draftInput());
    await expect(service.getApproval({ projectId: ids.otherProject,
      approvalId: "01890f1e-9b4a-7cc2-8f00-00000000030a", actorUserId: ids.outsider }))
      .rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });

    await migration.query(
      "UPDATE platform.project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [ids.project, ids.designer]
    );
    await expect(service.submitRevision(submissionInput(draft.revision.id, draft.revision.version)))
      .rejects.toMatchObject({ code: "APPROVAL_FORBIDDEN" });
  });
});

function draftInput() {
  return {
    projectId: ids.project,
    actorUserId: ids.designer,
    requestId: "draft-create-request",
    draft: {
      documentCode: "GX-240714-001",
      name: "减速器壳体",
      revisionCode: "A01",
      originalObjectId: ids.storage,
      source: "web_upload" as const,
      materialCode: "QT450-10",
      idempotencyKey: "draft:GX-240714-001:A01"
    }
  };
}

function submissionInput(revisionId: string, version: number) {
  return {
    projectId: ids.project,
    revisionId,
    actorUserId: ids.designer,
    requestId: "submission-create-request",
    submission: {
      version,
      supervisorUserId: ids.supervisor,
      processUserId: ids.process,
      requiresSignature: true,
      placements: [
        placement("designer", 0.1),
        placement("supervisor", 0.4),
        placement("process", 0.7)
      ],
      idempotencyKey: "submit:GX-240714-001:A01"
    }
  };
}

function placement(signerRole: "designer" | "supervisor" | "process", xRatio: number) {
  return { signerRole, pageNumber: 1, xRatio, yRatio: 0.8, widthRatio: 0.15, heightRatio: 0.08 };
}

function decisionInput(approvalId: string, reviewerRole: "supervisor" | "process", actorUserId: string,
  decision: "approved" | "rejected", idempotencyKey: string) {
  return {
    projectId: ids.project,
    approvalId,
    actorUserId,
    reviewerRole,
    requestId: `${idempotencyKey}:request`,
    decision: { decision, comment: decision === "rejected" ? "请修改" : "审核通过", version: 1, idempotencyKey }
  };
}

async function createSubmittedApproval(service: ReturnType<typeof createApprovalService>) {
  const draft = await service.createDraft(draftInput());
  return service.submitRevision(submissionInput(draft.revision.id, draft.revision.version));
}

async function seedFoundations() {
  await migration.query(
    `INSERT INTO platform.users
      (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES
      ($1,'designer@example.test','设计师','$argon2id$seed','member','active','enabled'),
      ($2,'supervisor@example.test','主管','$argon2id$seed','member','active','enabled'),
      ($3,'process@example.test','工艺','$argon2id$seed','member','active','enabled'),
      ($4,'manager@example.test','项目管理员','$argon2id$seed','admin','active','enabled'),
      ($5,'outsider@example.test','隔离用户','$argon2id$seed','member','active','enabled')`,
    [ids.designer, ids.supervisor, ids.process, ids.manager, ids.outsider]
  );
  await migration.query(
    `INSERT INTO platform.projects (id,name,status)
     VALUES ($1,'E2E 项目','active'),($2,'隔离项目','active')`,
    [ids.project, ids.otherProject]
  );
  await migration.query(
    `INSERT INTO platform.project_members (id,project_id,user_id,role,status)
     VALUES
      ('01890f1e-9b4a-7cc2-8f00-000000000311',$1,$2,'designer','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000312',$1,$3,'supervisor','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000313',$1,$4,'process','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000314',$1,$5,'manager','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000315',$6,$7,'viewer','active')`,
    [ids.project, ids.designer, ids.supervisor, ids.process, ids.manager,
      ids.otherProject, ids.outsider]
  );
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at)
     VALUES ($1,'ready','filesystem','phase4/approval-source.pdf',1024,decode(repeat('73',32),'hex'),
       'application/pdf',clock_timestamp())`,
    [ids.storage]
  );
}
