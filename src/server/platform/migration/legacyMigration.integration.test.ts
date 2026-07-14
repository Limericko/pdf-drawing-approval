import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { createStorageKey } from "../storage/storageKey.ts";
import { FilesystemStorage } from "../storage/filesystemStorage.ts";
import { importLegacyCoreRecords } from "./legacyCoreImporter.ts";
import { deriveLegacyUuidV7 } from "./legacyIdentity.ts";
import { LegacyMigrationStore } from "./legacyMigrationStore.ts";
import { runLegacyMigration } from "./legacyMigration.ts";

let platform: PlatformTestDatabase;
let migration: Pool;
let temporaryRoot: string;

beforeAll(async () => {
  platform = await createPlatformTestDatabase();
  migration = platform.createPool("migration");
  await runMigrations(migration);
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "legacy-migration-integration-"));
});

afterAll(async () => {
  await platform?.dispose();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe("legacy PostgreSQL migration tracking and core import", () => {
  it("persists stable mappings and imports disabled identities idempotently", async () => {
    const databasePath = path.join(temporaryRoot, "legacy.sqlite");
    createLegacyFixture(databasePath);
    const store = new LegacyMigrationStore(migration);
    const sourceId = "office-server-2026";
    const fingerprint = "a".repeat(64);
    const startedAt = new Date("2026-07-14T16:00:00Z");
    const run = await store.startRun({ sourceId, mode: "import", sourceFingerprintSha256: fingerprint, startedAt });
    const signaturePath = "X:\\legacy\\signature.png";
    const pathHash = createHash("sha256").update(signaturePath).digest("hex");
    const contentHash = "b".repeat(64);
    const objectId = deriveLegacyUuidV7(sourceId, "file_object", `${pathHash}:${contentHash}`);
    await store.ensureReadyStorageObject({ id: objectId, driver: "s3", objectKey: createStorageKey("migration/legacy", objectId),
      sizeBytes: 128, sha256: contentHash, mediaType: "image/png", readyAt: startedAt });
    await store.recordFileMapping({ runId: run.id, sourceId, sourcePathSha256: pathHash,
      sourceContentSha256: contentHash, sizeBytes: 128, mediaType: "image/png", storageObjectId: objectId,
      verifiedAt: startedAt });

    const emailOverrides = { "1": "designer@example.com", "2": "supervisor@example.com",
      "3": "process@example.com", "4": "admin@example.com" };
    const first = await importLegacyCoreRecords({ databasePath, sourceId, runId: run.id,
      emailOverrides, executor: migration, store, now: () => startedAt });
    await store.completeRun(run.id, { status: "succeeded", completedAt: new Date(startedAt.getTime() + 1_000),
      report: first });

    const rerun = await store.startRun({ sourceId, mode: "import", sourceFingerprintSha256: fingerprint,
      startedAt: new Date(startedAt.getTime() + 2_000) });
    const second = await importLegacyCoreRecords({ databasePath, sourceId, runId: rerun.id,
      emailOverrides, executor: migration, store, now: () => new Date(startedAt.getTime() + 2_000) });
    await store.completeRun(rerun.id, { status: "succeeded", completedAt: new Date(startedAt.getTime() + 3_000),
      report: second });

    expect(first).toMatchObject({ users: 4, projects: 0, memberships: 0, signatureAssets: 1,
      approvalCases: 0, reviewDecisions: 0 });
    expect(second).toEqual(first);
    const state = await migration.query<{
      users: string; disabled: string; signatures: string; user_mappings: string; run_count: string; legacy_passwords: string;
    }>(`SELECT
      (SELECT count(*) FROM platform.users) AS users,
      (SELECT count(*) FROM platform.users WHERE status='disabled' AND mfa_status='disabled') AS disabled,
      (SELECT count(*) FROM platform.signature_assets) AS signatures,
      (SELECT count(*) FROM platform.legacy_id_mappings WHERE entity_type='user') AS user_mappings,
      (SELECT count(*) FROM platform.legacy_migration_runs) AS run_count,
      (SELECT count(*) FROM platform.users WHERE password_hash IN ('old-1','old-2','old-3','old-4')) AS legacy_passwords`);
    expect(state.rows[0]).toEqual({ users: "4", disabled: "4", signatures: "1", user_mappings: "4",
      run_count: "2", legacy_passwords: "0" });
  });

  it("refuses to invent a missing public identity email", async () => {
    const databasePath = path.join(temporaryRoot, "missing-email.sqlite");
    createLegacyFixture(databasePath);
    const sourceId = "missing-email-source";
    const store = new LegacyMigrationStore(migration);
    const run = await store.startRun({ sourceId, mode: "import", sourceFingerprintSha256: "c".repeat(64),
      startedAt: new Date("2026-07-14T17:00:00Z") });
    await expect(importLegacyCoreRecords({ databasePath, sourceId, runId: run.id,
      emailOverrides: { "1": "designer2@example.com" }, executor: migration, store }))
      .rejects.toMatchObject({ message: "LEGACY_USER_EMAIL_REQUIRED", legacyId: "2" });
    await store.completeRun(run.id, { status: "failed", completedAt: new Date("2026-07-14T17:00:01Z"),
      report: { code: "LEGACY_USER_EMAIL_REQUIRED" } });
  });

  it("runs full import then an idempotent delta with file readback verification", async () => {
    const fixtureRoot = path.join(temporaryRoot, "orchestrated");
    const filesRoot = path.join(fixtureRoot, "files");
    const storageRoot = path.join(fixtureRoot, "storage");
    await mkdir(filesRoot, { recursive: true });
    const signaturePath = path.join(filesRoot, "signature.png");
    await writeFile(signaturePath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64"
    ));
    const databasePath = path.join(fixtureRoot, "legacy.sqlite");
    const sqlite = new DatabaseSync(databasePath);
    try {
      sqlite.exec(await readFile(path.resolve("src/server/schema.sql"), "utf8"));
      sqlite.prepare("INSERT INTO users(username,password_hash,role,email,display_name,active) VALUES(?,?,?,?,?,1)")
        .run("designer2", "old-password-hash", "designer", null, "迁移设计师");
      sqlite.prepare("INSERT INTO signature_assets(user_id,kind,file_path,active) VALUES(1,'uploaded_png',?,1)")
        .run("X:\\legacy\\signature.png");
    } finally { sqlite.close(); }
    const storage = new FilesystemStorage({ root: storageRoot });
    const migrationInput = { databasePath, sourceId: "orchestrated-source", roots: [
      { legacyRoot: "X:\\legacy", snapshotRoot: filesRoot }
    ], emailOverrides: { "1": "designer-orchestrated@example.com" }, executor: migration, storage } as const;

    const imported = await runLegacyMigration({ ...migrationInput, mode: "import",
      now: () => new Date("2026-07-14T18:00:00Z") });
    const changed = new DatabaseSync(databasePath);
    try { changed.prepare("UPDATE users SET display_name=? WHERE id=1").run("迁移设计师（增量）"); }
    finally { changed.close(); }
    const delta = await runLegacyMigration({ ...migrationInput, mode: "delta",
      now: () => new Date("2026-07-14T18:01:00Z") });

    expect(imported.counts).toMatchObject({ users: 1, signatureAssets: 1, importedFiles: 1, reusedFiles: 0 });
    expect(delta.counts).toMatchObject({ users: 1, signatureAssets: 1, importedFiles: 0, reusedFiles: 1 });
    expect(delta.baselineRunId).toBe(imported.runId);
    expect(delta.verification.eligibleForCutover).toBe(true);
    const updated = await migration.query<{ display_name: string }>(
      `SELECT target.display_name FROM platform.users target JOIN platform.legacy_id_mappings mapping
       ON mapping.target_id=target.id WHERE mapping.source_id='orchestrated-source' AND mapping.entity_type='user'`
    );
    expect(updated.rows[0]?.display_name).toBe("迁移设计师（增量）");
  });

  it("imports a drawing, parallel review decisions and signature placement", async () => {
    const fixtureRoot = path.join(temporaryRoot, "approval-flow");
    const filesRoot = path.join(fixtureRoot, "files");
    await mkdir(filesRoot, { recursive: true });
    const pdf = await PDFDocument.create(); pdf.addPage([400, 300]);
    await writeFile(path.join(filesRoot, "drawing.pdf"), Buffer.from(await pdf.save()));
    const databasePath = path.join(fixtureRoot, "legacy.sqlite");
    const sqlite = new DatabaseSync(databasePath);
    try {
      sqlite.exec(await readFile(path.resolve("src/server/schema.sql"), "utf8"));
      const insertUser = sqlite.prepare(
        "INSERT INTO users(username,password_hash,role,email,display_name,active) VALUES(?,?,?,?,?,1)"
      );
      insertUser.run("flow-designer", "old", "designer", "flow-designer@example.com", "流程设计师");
      insertUser.run("flow-supervisor", "old", "supervisor", "flow-supervisor@example.com", "流程主管");
      insertUser.run("flow-process", "old", "process", "flow-process@example.com", "流程工艺");
      insertUser.run("flow-admin", "old", "admin", "flow-admin@example.com", "流程管理员");
      sqlite.prepare(`INSERT INTO approvals(
        project_name,part_name,version,minor_version,major_version,original_file_path,current_file_path,
        status,submitted_by,submitted_by_user_id,source,signature_status,document_code,drawing_name,
        pdm_metadata_status,supervisor_status,process_status,submitted_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "迁移项目", "阀体", "a0A0", "a0", "A0", "X:\\legacy\\drawing.pdf", "X:\\legacy\\drawing.pdf",
        "pending", "flow-designer", 1, "web_upload", "placement_required", "DOC-001", "阀体图",
        "missing_material_code", "pending", "pending", "2026-07-01 10:00:00"
      );
      sqlite.prepare(`INSERT INTO signature_placements(
        approval_id,role,page_number,x_ratio,y_ratio,width_ratio,height_ratio,created_at,updated_at
      ) VALUES(1,'designer',1,0.1,0.1,0.2,0.1,'2026-07-01 10:01:00','2026-07-01 10:01:00')`).run();
      sqlite.prepare(`INSERT INTO approval_annotations(
        approval_id,author_user_id,kind,message,page_number,x_ratio,y_ratio,width_ratio,height_ratio,
        style_json,color,resolved,created_at,updated_at
      ) VALUES(1,2,'rect','尺寸需要确认',1,0.1,0.2,0.3,0.2,'{}','red',0,
        '2026-07-01 10:02:00','2026-07-01 10:02:00')`).run();
      sqlite.prepare(`INSERT INTO approval_issues(
        approval_id,annotation_id,creator_user_id,assignee_user_id,title,description,severity,status,
        version,created_at,updated_at
      ) VALUES(1,1,2,1,'尺寸问题','请核对尺寸','high','open',1,
        '2026-07-01 10:03:00','2026-07-01 10:03:00')`).run();
      sqlite.prepare(`INSERT INTO approval_issue_events(
        issue_id,actor_user_id,action,from_status,to_status,note,created_at
      ) VALUES(1,2,'created',NULL,'open','创建问题','2026-07-01 10:03:00')`).run();
      sqlite.prepare(`INSERT INTO pdm_parts(
        material_code,name,is_common,current_revision_id,created_from_approval_id,created_at,updated_at
      ) VALUES('MAT-001','阀体',0,NULL,1,'2026-07-01 10:04:00','2026-07-01 10:04:00')`).run();
      sqlite.prepare(`INSERT INTO pdm_drawing_revisions(
        part_id,material_code,document_code,drawing_name,version,minor_version,major_version,approval_id,
        release_status,original_file_path,released_at,created_at,updated_at
      ) VALUES(1,'MAT-001','DOC-001','阀体图','a0A0','a0','A0',1,'released',?,
        '2026-07-01 10:05:00','2026-07-01 10:04:00','2026-07-01 10:05:00')`)
        .run("X:\\legacy\\drawing.pdf");
      sqlite.prepare("UPDATE pdm_parts SET current_revision_id=1 WHERE id=1").run();
      sqlite.prepare(`INSERT INTO pdm_part_usages(
        part_id,material_code,project_name,first_approval_id,last_approval_id,created_at,updated_at
      ) VALUES(1,'MAT-001','迁移项目',1,1,'2026-07-01 10:05:00','2026-07-01 10:05:00')`).run();
    } finally { sqlite.close(); }
    const report = await runLegacyMigration({ databasePath, sourceId: "approval-flow-source",
      roots: [{ legacyRoot: "X:\\legacy", snapshotRoot: filesRoot }], mode: "import", executor: migration,
      storage: new FilesystemStorage({ root: path.join(fixtureRoot, "storage") }),
      now: () => new Date("2026-07-14T19:00:00Z") });
    expect(report.counts).toMatchObject({ projects: 1, documents: 1, drawingRevisions: 1,
      approvalCases: 1, reviewDecisions: 2, signaturePlacements: 1, annotations: 1,
      issues: 1, issueEvents: 1, parts: 1, partRevisionLinks: 1, partUsages: 1, importedFiles: 1 });
    const state = await migration.query<{ approvals: string; decisions: string; placements: string }>(`SELECT
      (SELECT count(*) FROM platform.approval_cases WHERE client_request_id='migration:approval-flow-source:approval:1') AS approvals,
      (SELECT count(*) FROM platform.review_decisions WHERE client_request_id LIKE 'migration:approval-flow-source:review:1:%') AS decisions,
      (SELECT count(*) FROM platform.signature_placements placement JOIN platform.legacy_id_mappings mapping
        ON mapping.target_id=placement.id WHERE mapping.source_id='approval-flow-source') AS placements`);
    expect(state.rows[0]).toEqual({ approvals: "1", decisions: "2", placements: "1" });
  });
});

function createLegacyFixture(databasePath: string) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT,role TEXT,email TEXT,display_name TEXT,active INTEGER,created_at TEXT);
      CREATE TABLE approvals(id INTEGER PRIMARY KEY,project_name TEXT);
      CREATE TABLE signature_assets(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,file_path TEXT,active INTEGER,created_at TEXT);
    `);
    const insert = database.prepare(
      "INSERT INTO users(id,username,password_hash,role,email,display_name,active,created_at) VALUES(?,?,?,?,NULL,?,?,?)"
    );
    insert.run(1, "designer", "old-1", "designer", "设计师", 1, "2026-07-01 08:00:00");
    insert.run(2, "supervisor", "old-2", "supervisor", "主管", 1, "2026-07-01 08:00:00");
    insert.run(3, "process", "old-3", "process", "工艺", 1, "2026-07-01 08:00:00");
    insert.run(4, "admin", "old-4", "admin", "管理员", 1, "2026-07-01 08:00:00");
    database.prepare("INSERT INTO signature_assets VALUES(1,1,'uploaded_png',?,1,'2026-07-01 09:00:00')")
      .run("X:\\legacy\\signature.png");
  } finally {
    database.close();
  }
}
