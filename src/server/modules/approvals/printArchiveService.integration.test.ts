import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createPrintArchiveService } from "./printArchiveService.ts";

const ids = {
  project: "01890f1e-9b4a-7cc2-8f00-000000001101",
  designer: "01890f1e-9b4a-7cc2-8f00-000000001102",
  supervisor: "01890f1e-9b4a-7cc2-8f00-000000001103",
  source: "01890f1e-9b4a-7cc2-8f00-000000001104",
  signed: "01890f1e-9b4a-7cc2-8f00-000000001105",
  foreign: "01890f1e-9b4a-7cc2-8f00-000000001106",
  document: "01890f1e-9b4a-7cc2-8f00-000000001107",
  revision: "01890f1e-9b4a-7cc2-8f00-000000001108",
  approval: "01890f1e-9b4a-7cc2-8f00-000000001109",
  artifact: "01890f1e-9b4a-7cc2-8f00-00000000110a"
} as const;
let database: PlatformTestDatabase; let migration: Pool; let web: PlatformPool;
beforeAll(async () => {
  database = await createPlatformTestDatabase(); migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 3, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "print-archive-test");
});
afterAll(async () => { await web?.end(); await database?.dispose(); });
beforeEach(async () => {
  await migration.query("TRUNCATE platform.projects,platform.users,platform.storage_objects,platform.audit_events CASCADE");
  await seed();
});

describe("print archive service", () => {
  it("records only the approved signed artifact and deduplicates the desktop result", async () => {
    const service = createPrintArchiveService({ pool: web });
    const input = { projectId: ids.project, approvalId: ids.approval, actorUserId: ids.designer,
      requestId: "print-archive-success", result: { objectId: ids.signed, printerName: "工程部-HP-M404",
        status: "archived" as const, errorCode: null, idempotencyKey: "print:archive:approval:1" } };
    const created = await service.record(input);
    await expect(service.record({ ...input, requestId: "print-archive-retry" })).resolves.toEqual(created);
    await expect(service.list({ projectId: ids.project, approvalId: ids.approval,
      actorUserId: ids.designer })).resolves.toMatchObject({ items: [{ id: created.id, status: "archived" }] });
    await expect(service.record({ ...input, requestId: "print-wrong-object",
      result: { ...input.result, objectId: ids.foreign, idempotencyKey: "print:archive:wrong:1" } }))
      .rejects.toMatchObject({ code: "PRINT_ARCHIVE_OBJECT_INVALID" });
  });

  it("rejects reviewers but records a controlled desktop failure for the designer", async () => {
    const service = createPrintArchiveService({ pool: web });
    const result = { objectId: ids.signed, printerName: "工程部-HP-M404", status: "failed" as const,
      errorCode: "PRINT_DRIVER_OFFLINE", idempotencyKey: "print:failure:1" };
    await expect(service.record({ projectId: ids.project, approvalId: ids.approval,
      actorUserId: ids.supervisor, requestId: "print-forbidden", result }))
      .rejects.toMatchObject({ code: "PRINT_ARCHIVE_FORBIDDEN" });
    await expect(service.record({ projectId: ids.project, approvalId: ids.approval,
      actorUserId: ids.designer, requestId: "print-failed", result }))
      .resolves.toMatchObject({ status: "failed", errorCode: "PRINT_DRIVER_OFFLINE" });
  });
});

async function seed() {
  await migration.query(
    `INSERT INTO platform.users (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES ($1,'designer@example.test','设计师','$argon2id$seed','member','active','enabled'),
      ($2,'supervisor@example.test','主管','$argon2id$seed','member','active','enabled')`,
    [ids.designer, ids.supervisor]
  );
  await migration.query("INSERT INTO platform.projects (id,name,status) VALUES ($1,'项目A','active')", [ids.project]);
  await migration.query(
    `INSERT INTO platform.project_members (id,project_id,user_id,role,status) VALUES
      ('01890f1e-9b4a-7cc2-8f00-000000001111',$1,$2,'designer','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000001112',$1,$3,'supervisor','active')`,
    [ids.project, ids.designer, ids.supervisor]
  );
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at,created_at) VALUES
      ($1,'ready','filesystem','print/source',100,decode(repeat('41',32),'hex'),'application/pdf',clock_timestamp(),clock_timestamp()-interval '1 second'),
      ($2,'ready','filesystem','print/signed',120,decode(repeat('42',32),'hex'),'application/pdf',clock_timestamp(),clock_timestamp()-interval '1 second'),
      ($3,'ready','filesystem','print/foreign',130,decode(repeat('43',32),'hex'),'application/pdf',clock_timestamp(),clock_timestamp()-interval '1 second')`,
    [ids.source, ids.signed, ids.foreign]
  );
  await migration.query(
    "INSERT INTO platform.documents (id,project_id,document_code,name,created_by_user_id) VALUES ($1,$2,'GX-PRINT-01','阀体',$3)",
    [ids.document, ids.project, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.drawing_revisions
      (id,project_id,document_id,revision_code,original_object_id,status,created_by_user_id,submitted_at,created_at)
     VALUES ($1,$2,$3,'A01',$4,'approved',$5,clock_timestamp(),clock_timestamp()-interval '1 second')`,
    [ids.revision, ids.project, ids.document, ids.source, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.approval_cases
      (id,project_id,revision_id,status,requires_signature,created_by_user_id,completed_at,created_at)
     VALUES ($1,$2,$3,'approved',true,$4,clock_timestamp(),clock_timestamp()-interval '1 second')`,
    [ids.approval, ids.project, ids.revision, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.render_artifacts
      (id,project_id,approval_case_id,kind,generation,status,object_id,idempotency_key,ready_at)
     VALUES ($1,$2,$3,'signed_pdf',1,'ready',$4,'render:print-test',clock_timestamp())`,
    [ids.artifact, ids.project, ids.approval, ids.signed]
  );
}
