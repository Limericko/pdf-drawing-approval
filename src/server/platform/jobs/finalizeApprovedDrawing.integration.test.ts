import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import type { Pool } from "pg";
import { v7 as uuidV7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPdmService } from "../../modules/pdm/pdmService.ts";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { FilesystemStorage } from "../storage/filesystemStorage.ts";
import { createStorageKey } from "../storage/storageKey.ts";
import { createFinalizeApprovedDrawingHandler } from "./handlers/finalizeApprovedDrawing.ts";

const ids = {
  project: "01890f1e-9b4a-7cc2-8f00-000000000b01",
  designer: "01890f1e-9b4a-7cc2-8f00-000000000b02",
  supervisor: "01890f1e-9b4a-7cc2-8f00-000000000b03",
  process: "01890f1e-9b4a-7cc2-8f00-000000000b04",
  source: "01890f1e-9b4a-7cc2-8f00-000000000b05",
  designerPng: "01890f1e-9b4a-7cc2-8f00-000000000b06",
  supervisorPng: "01890f1e-9b4a-7cc2-8f00-000000000b07",
  processPng: "01890f1e-9b4a-7cc2-8f00-000000000b08",
  document: "01890f1e-9b4a-7cc2-8f00-000000000b09",
  revision: "01890f1e-9b4a-7cc2-8f00-000000000b0a",
  approval: "01890f1e-9b4a-7cc2-8f00-000000000b0b"
} as const;

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

let database: PlatformTestDatabase;
let migration: Pool;
let worker: PlatformPool;
let storage: FilesystemStorage;
let root: string;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  worker = createPlatformPool({ connectionString: database.urls.worker, poolMax: 4, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "finalize-drawing-test");
  root = await mkdtemp(path.join(os.tmpdir(), "pdf-approval-finalize-"));
});

afterAll(async () => {
  await worker?.end();
  await database?.dispose();
  if (root?.startsWith(os.tmpdir())) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.projects,platform.users,platform.storage_objects,platform.audit_events CASCADE");
  storage = new FilesystemStorage({ root: path.join(root, uuidV7()) });
  await seedApprovedDrawing();
});

describe("approval completion worker", () => {
  it("renders all three PNG signatures, stores an immutable PDF and publishes the PDM revision", async () => {
    const pdm = createPdmService({ pool: worker });
    const handler = createFinalizeApprovedDrawingHandler({ pool: worker, storage, pdm });
    const job = { id: uuidV7(), payload: { projectId: ids.project, approvalId: ids.approval } } as never;
    await handler(job);
    await handler(job);

    const artifacts = await migration.query<{ status: string; object_id: string; generation: number }>(
      "SELECT status,object_id,generation FROM platform.render_artifacts WHERE approval_case_id=$1",
      [ids.approval]
    );
    expect(artifacts.rows).toEqual([{ status: "ready", object_id: expect.any(String), generation: 1 }]);
    const object = await migration.query<{ object_key: string }>(
      "SELECT object_key FROM platform.storage_objects WHERE id=$1 AND status='ready'",
      [artifacts.rows[0]!.object_id]
    );
    const signed = await read(await storage.openRead(object.rows[0]!.object_key));
    await expect(PDFDocument.load(signed)).resolves.toBeTruthy();
    await expect(migration.query(
      "SELECT release_status FROM platform.part_revision_links WHERE revision_id=$1", [ids.revision]
    )).resolves.toMatchObject({ rows: [{ release_status: "published" }] });
  });

  it("records a safe failed artifact when a required signature is missing", async () => {
    await migration.query("UPDATE platform.signature_assets SET active=false WHERE user_id=$1", [ids.process]);
    const handler = createFinalizeApprovedDrawingHandler({ pool: worker, storage,
      pdm: createPdmService({ pool: worker }) });
    await expect(handler({ id: uuidV7(), payload: { projectId: ids.project,
      approvalId: ids.approval } } as never)).rejects.toMatchObject({
      kind: "permanent", code: "SIGNATURE_CONFIGURATION_MISSING"
    });
    await expect(migration.query(
      "SELECT status,error_code,object_id FROM platform.render_artifacts WHERE approval_case_id=$1",
      [ids.approval]
    )).resolves.toMatchObject({ rows: [{ status: "failed",
      error_code: "SIGNATURE_CONFIGURATION_MISSING", object_id: null }] });
  });
});

async function seedApprovedDrawing() {
  await migration.query(
    `INSERT INTO platform.users (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES ($1,'designer@example.test','设计师','$argon2id$seed','member','active','enabled'),
       ($2,'supervisor@example.test','主管','$argon2id$seed','member','active','enabled'),
       ($3,'process@example.test','工艺','$argon2id$seed','member','active','enabled')`,
    [ids.designer, ids.supervisor, ids.process]
  );
  await migration.query("INSERT INTO platform.projects (id,name,status) VALUES ($1,'液压项目','active')", [ids.project]);
  const pdf = await PDFDocument.create();
  pdf.addPage([800, 600]);
  await storeReady(ids.source, "source-pdf", Buffer.from(await pdf.save()), "application/pdf");
  await storeReady(ids.designerPng, "signature-png", png, "image/png");
  await storeReady(ids.supervisorPng, "signature-png", png, "image/png");
  await storeReady(ids.processPng, "signature-png", png, "image/png");
  await migration.query(
    `INSERT INTO platform.signature_assets (id,user_id,object_id) VALUES
      ('01890f1e-9b4a-7cc2-8f00-000000000b11',$1,$2),
      ('01890f1e-9b4a-7cc2-8f00-000000000b12',$3,$4),
      ('01890f1e-9b4a-7cc2-8f00-000000000b13',$5,$6)`,
    [ids.designer, ids.designerPng, ids.supervisor, ids.supervisorPng, ids.process, ids.processPng]
  );
  await migration.query(
    `INSERT INTO platform.documents (id,project_id,document_code,name,created_by_user_id)
     VALUES ($1,$2,'GX-240714-011','液压阀体',$3)`, [ids.document, ids.project, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.drawing_revisions
      (id,project_id,document_id,revision_code,original_object_id,status,metadata_status,material_code,
       created_by_user_id,submitted_at,created_at)
     VALUES ($1,$2,$3,'A01',$4,'approved','complete','40Cr',$5,clock_timestamp(),
       clock_timestamp() - interval '1 second')`,
    [ids.revision, ids.project, ids.document, ids.source, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.approval_cases
      (id,project_id,revision_id,status,requires_signature,created_by_user_id,completed_at,created_at)
     VALUES ($1,$2,$3,'approved',true,$4,clock_timestamp(),clock_timestamp() - interval '1 second')`,
    [ids.approval, ids.project, ids.revision, ids.designer]
  );
  await migration.query(
    `INSERT INTO platform.review_decisions
      (id,project_id,approval_case_id,reviewer_role,assigned_user_id,status,decided_at,created_at)
     VALUES
      ('01890f1e-9b4a-7cc2-8f00-000000000b14',$1,$2,'supervisor',$3,'approved',clock_timestamp(),
        clock_timestamp() - interval '1 second'),
      ('01890f1e-9b4a-7cc2-8f00-000000000b15',$1,$2,'process',$4,'approved',clock_timestamp(),
        clock_timestamp() - interval '1 second')`,
    [ids.project, ids.approval, ids.supervisor, ids.process]
  );
  await migration.query(
    `INSERT INTO platform.signature_placements
      (id,project_id,approval_case_id,signer_role,page_number,x_ratio,y_ratio,width_ratio,height_ratio)
     VALUES
      ('01890f1e-9b4a-7cc2-8f00-000000000b16',$1,$2,'designer',1,0.62,0.80,0.10,0.05),
      ('01890f1e-9b4a-7cc2-8f00-000000000b17',$1,$2,'supervisor',1,0.73,0.80,0.10,0.05),
      ('01890f1e-9b4a-7cc2-8f00-000000000b18',$1,$2,'process',1,0.84,0.80,0.10,0.05)`,
    [ids.project, ids.approval]
  );
}

async function storeReady(id: string, prefix: string, body: Buffer, mediaType: string) {
  const objectKey = createStorageKey(prefix, id);
  const result = await storage.write(objectKey, Readable.from(body), mediaType);
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at)
     VALUES ($1,'ready','filesystem',$2,$3,$4,$5,clock_timestamp())`,
    [id, objectKey, result.sizeBytes, result.sha256, mediaType]
  );
}

async function read(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
