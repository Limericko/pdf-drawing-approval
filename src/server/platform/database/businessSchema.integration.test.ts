import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./migrationRunner.ts";
import { withPlatformTestDatabase } from "../testing/postgresHarness.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000000101",
  secondUser: "01890f1e-9b4a-7cc2-8f00-000000000102",
  project: "01890f1e-9b4a-7cc2-8f00-000000000103",
  otherProject: "01890f1e-9b4a-7cc2-8f00-000000000104",
  storage: "01890f1e-9b4a-7cc2-8f00-000000000105",
  document: "01890f1e-9b4a-7cc2-8f00-000000000106",
  revision: "01890f1e-9b4a-7cc2-8f00-000000000107",
  approval: "01890f1e-9b4a-7cc2-8f00-000000000108",
  supervisorDecision: "01890f1e-9b4a-7cc2-8f00-000000000109",
  processDecision: "01890f1e-9b4a-7cc2-8f00-00000000010a"
} as const;

const businessTables = [
  "admin_mutation_requests",
  "annotations",
  "approval_cases",
  "backup_runs",
  "documents",
  "drawing_revisions",
  "issue_events",
  "issues",
  "part_revision_links",
  "part_usages",
  "parts",
  "pdm_mutation_requests",
  "print_archive_events",
  "render_artifacts",
  "review_decisions",
  "signature_assets",
  "signature_placements"
] as const;

describe("Phase 4 PostgreSQL business schema", () => {
  it("creates the approval, PDM and administration relations with restricted web access", async () => {
    await withPlatformTestDatabase(async (database) => {
      const migration = database.createPool("migration");
      await expect(runMigrations(migration)).resolves.toEqual({ applied: 10, verified: 0, total: 10 });

      const tables = await migration.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='platform' AND table_type='BASE TABLE' AND table_name=ANY($1::text[])
         ORDER BY table_name`,
        [businessTables]
      );
      expect(tables.rows.map(({ table_name }) => table_name)).toEqual(businessTables);

      const web = database.createPool("web");
      for (const table of businessTables) {
        await expect(migration.query(
          "SELECT has_table_privilege('platform_web', $1, 'DELETE') AS allowed",
          [`platform.${table}`]
        )).resolves.toMatchObject({ rows: [{ allowed: false }] });
      }
      await expect(web.query("CREATE TABLE platform.business_ddl_forbidden(id integer)"))
        .rejects.toMatchObject({ code: "42501" });
    });
  });

  it("enforces project-scoped revisions, parallel decisions and published revision immutability", async () => {
    await withPlatformTestDatabase(async (database) => {
      const migration = database.createPool("migration");
      await runMigrations(migration);
      await seedFoundations(migration);
      const web = database.createPool("web");

      await web.query(
        `INSERT INTO platform.documents (id,project_id,document_code,name,created_by_user_id)
         VALUES ($1,$2,'GX-240714-001','减速器壳体',$3)`,
        [ids.document, ids.project, ids.user]
      );
      const stagingObject = "01890f1e-9b4a-7cc2-8f00-00000000010d";
      await migration.query(
        `INSERT INTO platform.storage_objects (id,status,driver,object_key,upload_expires_at)
         VALUES ($1,'staging','filesystem','phase4/staging.pdf',clock_timestamp() + interval '1 hour')`,
        [stagingObject]
      );
      await expect(web.query(
        `INSERT INTO platform.drawing_revisions
          (id,project_id,document_id,revision_code,original_object_id,status,created_by_user_id)
         VALUES ('01890f1e-9b4a-7cc2-8f00-00000000010e',$1,$2,'STAGING',$3,'draft',$4)`,
        [ids.project, ids.document, stagingObject, ids.user]
      )).rejects.toMatchObject({ code: "23514" });
      await web.query(
        `INSERT INTO platform.drawing_revisions
          (id,project_id,document_id,revision_code,original_object_id,status,created_by_user_id)
         VALUES ($1,$2,$3,'A01',$4,'approved',$5)`,
        [ids.revision, ids.project, ids.document, ids.storage, ids.user]
      );
      await expect(web.query(
        `INSERT INTO platform.drawing_revisions
          (id,project_id,document_id,revision_code,original_object_id,status,created_by_user_id)
         VALUES ('01890f1e-9b4a-7cc2-8f00-00000000010b',$1,$2,'A02',$3,'draft',$4)`,
        [ids.otherProject, ids.document, ids.storage, ids.user]
      )).rejects.toMatchObject({ code: "23503" });

      await web.query(
        `INSERT INTO platform.approval_cases (id,project_id,revision_id,status,created_by_user_id)
         VALUES ($1,$2,$3,'pending',$4)`,
        [ids.approval, ids.project, ids.revision, ids.user]
      );
      await web.query(
        `INSERT INTO platform.review_decisions
          (id,project_id,approval_case_id,reviewer_role,assigned_user_id,status)
         VALUES ($1,$2,$3,'supervisor',$4,'pending'),($5,$2,$3,'process',$6,'pending')`,
        [ids.supervisorDecision, ids.project, ids.approval, ids.user,
          ids.processDecision, ids.secondUser]
      );
      await expect(web.query(
        `INSERT INTO platform.review_decisions
          (id,project_id,approval_case_id,reviewer_role,assigned_user_id,status)
         VALUES ('01890f1e-9b4a-7cc2-8f00-00000000010c',$1,$2,'supervisor',$3,'pending')`,
        [ids.project, ids.approval, ids.secondUser]
      )).rejects.toMatchObject({ code: "23505" });

      await web.query(
        "UPDATE platform.drawing_revisions SET status='published',published_at=clock_timestamp(),version=version+1 WHERE id=$1",
        [ids.revision]
      );
      await expect(web.query(
        "UPDATE platform.drawing_revisions SET material_code='M-99',version=version+1 WHERE id=$1",
        [ids.revision]
      )).rejects.toMatchObject({ code: "23514" });
    });
  });
});

async function seedFoundations(migration: Pool) {
  await migration.query(
    `INSERT INTO platform.users
      (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES
      ($1,'designer@example.test','设计师','$argon2id$seed','member','active','enabled'),
      ($2,'reviewer@example.test','审核人','$argon2id$seed','member','active','enabled')`,
    [ids.user, ids.secondUser]
  );
  await migration.query(
    `INSERT INTO platform.projects (id,name,status)
     VALUES ($1,'E2E 项目','active'),($2,'隔离项目','active')`,
    [ids.project, ids.otherProject]
  );
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at)
     VALUES ($1,'ready','filesystem','phase4/original.pdf',4,decode(repeat('42',32),'hex'),
       'application/pdf',clock_timestamp())`,
    [ids.storage]
  );
}
