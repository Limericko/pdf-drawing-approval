import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createPdmService } from "./pdmService.ts";

const ids = {
  project: "01890f1e-9b4a-7cc2-8f00-000000000801",
  otherProject: "01890f1e-9b4a-7cc2-8f00-000000000802",
  designer: "01890f1e-9b4a-7cc2-8f00-000000000803",
  manager: "01890f1e-9b4a-7cc2-8f00-000000000804",
  viewer: "01890f1e-9b4a-7cc2-8f00-000000000805",
  storage: "01890f1e-9b4a-7cc2-8f00-000000000806",
  signedStorage: "01890f1e-9b4a-7cc2-8f00-000000000807",
  document: "01890f1e-9b4a-7cc2-8f00-000000000808",
  revision: "01890f1e-9b4a-7cc2-8f00-000000000809",
  approval: "01890f1e-9b4a-7cc2-8f00-00000000080a",
  artifact: "01890f1e-9b4a-7cc2-8f00-00000000080b"
} as const;

let database: PlatformTestDatabase;
let migration: Pool;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 6, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "pdm-service-test");
});

afterAll(async () => {
  await web?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.projects CASCADE");
  await migration.query("TRUNCATE platform.users CASCADE");
  await migration.query("TRUNCATE platform.storage_objects CASCADE");
  await migration.query("TRUNCATE platform.audit_events");
  await seedFoundations();
});

describe("Phase 4 PDM service", () => {
  it("waits for a signed artifact, publishes an immutable current revision and deduplicates worker retries", async () => {
    await seedApprovedRevision({ requiresSignature: true, materialCode: "QT450-10" });
    const service = createPdmService({ pool: web });
    const pending = await service.publishApprovedRevision({ projectId: ids.project, approvalId: ids.approval,
      requestId: "pdm-publish-pending" });
    expect(pending.revisions[0]).toMatchObject({ releaseStatus: "pending", signedObjectId: null });

    await seedSignedArtifact();
    const published = await service.publishApprovedRevision({ projectId: ids.project, approvalId: ids.approval,
      requestId: "pdm-publish-ready" });
    expect(published.part).toMatchObject({ currentRevisionId: ids.revision,
      currentRevisionCode: "A01", releaseStatus: "published" });
    expect(published.revisions[0]).toMatchObject({ releaseStatus: "published",
      signedObjectId: ids.signedStorage, materialCode: "QT450-10" });
    expect(published.usages).toHaveLength(1);

    await service.publishApprovedRevision({ projectId: ids.project, approvalId: ids.approval,
      requestId: "pdm-publish-duplicate" });
    await expect(migration.query(
      "SELECT count(*)::int AS count FROM platform.audit_events WHERE action='pdm.revision.publish'"
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(migration.query(
      "UPDATE platform.drawing_revisions SET material_code='MUTATED' WHERE id=$1", [ids.revision]
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("lets the owning designer complete metadata once and publishes immediately when signing is disabled", async () => {
    await seedApprovedRevision({ requiresSignature: false, materialCode: null });
    const service = createPdmService({ pool: web });
    const pending = await service.publishApprovedRevision({ projectId: ids.project, approvalId: ids.approval,
      requestId: "pdm-metadata-pending" });
    const link = pending.revisions[0]!;
    expect(link.releaseStatus).toBe("pending_metadata");

    const update = { projectId: ids.project, linkId: link.linkId, actorUserId: ids.designer,
      requestId: "pdm-metadata-update", update: { materialCode: "40Cr", version: link.version,
        idempotencyKey: "pdm:metadata:GX-240714-008:A01" } };
    const published = await service.updateMetadata(update);
    const retried = await service.updateMetadata({ ...update, requestId: "pdm-metadata-retry" });
    expect(retried).toEqual(published);
    expect(published.revisions[0]).toMatchObject({ materialCode: "40Cr", releaseStatus: "published" });
    await expect(service.updateMetadata({ ...update, requestId: "pdm-metadata-conflict",
      update: { ...update.update, materialCode: "Q235" } }))
      .rejects.toMatchObject({ code: "PDM_IDEMPOTENCY_CONFLICT" });
    await expect(migration.query(
      "SELECT count(*)::int AS count FROM platform.pdm_mutation_requests"
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("keeps a pending-metadata revision visible when it is not the part current revision", async () => {
    await seedApprovedRevision({ requiresSignature: false, materialCode: null });
    const service = createPdmService({ pool: web });
    const pending = await service.publishApprovedRevision({ projectId: ids.project, approvalId: ids.approval,
      requestId: "pdm-pending-list" });
    expect(pending.part.currentRevisionId).toBeNull();
    await expect(service.listParts({ projectId: ids.project, actorUserId: ids.viewer, page: 1, pageSize: 20 }))
      .resolves.toMatchObject({ items: [{ currentRevisionCode: "A01", releaseStatus: "pending_metadata", materialCode: null }] });
  });

  it("lets only managers void a published revision while retaining release history", async () => {
    await seedApprovedRevision({ requiresSignature: false, materialCode: "6061-T6" });
    const service = createPdmService({ pool: web });
    const published = await service.publishApprovedRevision({ projectId: ids.project, approvalId: ids.approval,
      requestId: "pdm-before-void" });
    const link = published.revisions[0]!;
    await expect(service.voidRevision({ projectId: ids.project, linkId: link.linkId,
      actorUserId: ids.designer, requestId: "pdm-void-forbidden",
      update: { reason: "错误版本", version: link.version, idempotencyKey: "pdm:void:forbidden" } }))
      .rejects.toMatchObject({ code: "PDM_FORBIDDEN" });

    const input = { projectId: ids.project, linkId: link.linkId, actorUserId: ids.manager,
      requestId: "pdm-void-success", update: { reason: "该版本图号录入错误", version: link.version,
        idempotencyKey: "pdm:void:GX-240714-008:A01" } };
    const voided = await service.voidRevision(input);
    const retried = await service.voidRevision({ ...input, requestId: "pdm-void-retry" });
    expect(retried).toEqual(voided);
    expect(voided.part.currentRevisionId).toBeNull();
    expect(voided.revisions[0]).toMatchObject({ releaseStatus: "void",
      voidReason: "该版本图号录入错误", releasedAt: expect.any(Date) });
  });

  it("supports project-scoped list/detail traceability and hides foreign projects", async () => {
    await seedApprovedRevision({ requiresSignature: false, materialCode: "Q235B" });
    const service = createPdmService({ pool: web });
    const published = await service.publishApprovedRevision({ projectId: ids.project, approvalId: ids.approval,
      requestId: "pdm-list-publish" });
    const listed = await service.listParts({ projectId: ids.project, actorUserId: ids.viewer,
      page: 1, pageSize: 20, keyword: "GX-240714", releaseStatus: "published",
      sort: "part_number_asc" });
    expect(listed.page).toEqual({ page: 1, pageSize: 20, total: 1, pageCount: 1 });
    expect(listed.items[0]).toMatchObject({ partNumber: "GX-240714-008", currentRevisionCode: "A01" });
    await expect(service.listParts({ projectId: ids.project, actorUserId: ids.viewer,
      page: 1, pageSize: 20, releaseStatus: "pending_metadata" }))
      .resolves.toMatchObject({ items: [], page: { total: 0 } });
    await expect(service.getPart({ projectId: ids.otherProject, partId: published.part.id,
      actorUserId: ids.viewer })).rejects.toMatchObject({ code: "PDM_NOT_FOUND" });
  });
});

async function seedFoundations() {
  await migration.query(
    `INSERT INTO platform.users
      (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES
      ($1,'designer@example.test','设计师','$argon2id$seed','member','active','enabled'),
      ($2,'manager@example.test','项目管理员','$argon2id$seed','admin','active','enabled'),
      ($3,'viewer@example.test','只读用户','$argon2id$seed','member','active','enabled')`,
    [ids.designer, ids.manager, ids.viewer]
  );
  await migration.query(
    "INSERT INTO platform.projects (id,name,status) VALUES ($1,'E2E 项目','active'),($2,'隔离项目','active')",
    [ids.project, ids.otherProject]
  );
  await migration.query(
    `INSERT INTO platform.project_members (id,project_id,user_id,role,status)
     VALUES
      ('01890f1e-9b4a-7cc2-8f00-000000000811',$1,$2,'designer','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000812',$1,$3,'manager','active'),
      ('01890f1e-9b4a-7cc2-8f00-000000000813',$1,$4,'viewer','active')`,
    [ids.project, ids.designer, ids.manager, ids.viewer]
  );
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at)
     VALUES ($1,'ready','filesystem','phase4/pdm-source.pdf',2048,decode(repeat('81',32),'hex'),
       'application/pdf',clock_timestamp())`,
    [ids.storage]
  );
}

async function seedApprovedRevision(input: { requiresSignature: boolean; materialCode: string | null }) {
  await migration.query(
    `INSERT INTO platform.documents (id,project_id,document_code,name,created_by_user_id)
     VALUES ($1,$2,'GX-240714-008','液压阀体',$3)`,
    [ids.document, ids.project, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.drawing_revisions
      (id,project_id,document_id,revision_code,original_object_id,status,metadata_status,material_code,
       created_by_user_id,submitted_at,created_at)
     VALUES ($1,$2,$3,'A01',$4,'approved',$5,$6,$7,clock_timestamp(),clock_timestamp() - interval '1 second')`,
    [ids.revision, ids.project, ids.document, ids.storage,
      input.materialCode ? "complete" : "missing_material_code", input.materialCode, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.approval_cases
      (id,project_id,revision_id,status,requires_signature,created_by_user_id,completed_at,created_at)
     VALUES ($1,$2,$3,'approved',$4,$5,clock_timestamp(),clock_timestamp() - interval '1 second')`,
    [ids.approval, ids.project, ids.revision, input.requiresSignature, ids.designer]
  );
}

async function seedSignedArtifact() {
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at)
     VALUES ($1,'ready','filesystem','phase4/pdm-signed.pdf',3072,decode(repeat('82',32),'hex'),
       'application/pdf',clock_timestamp())`,
    [ids.signedStorage]
  );
  await migration.query(
    `INSERT INTO platform.render_artifacts
      (id,project_id,approval_case_id,kind,generation,status,object_id,idempotency_key,ready_at)
     VALUES ($1,$2,$3,'signed_pdf',1,'ready',$4,'render:pdm-signed',clock_timestamp())`,
    [ids.artifact, ids.project, ids.approval, ids.signedStorage]
  );
}
