import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./migrationRunner.ts";
import { withPlatformTestDatabase } from "../testing/postgresHarness.ts";

const ids = {
  admin: "01890f1e-9b4a-7cc2-8f00-000000000401",
  project: "01890f1e-9b4a-7cc2-8f00-000000000402",
  otherProject: "01890f1e-9b4a-7cc2-8f00-000000000403",
  connection: "01890f1e-9b4a-7cc2-8f00-000000000404",
  mapping: "01890f1e-9b4a-7cc2-8f00-000000000405",
  storage: "01890f1e-9b4a-7cc2-8f00-000000000406",
  staging: "01890f1e-9b4a-7cc2-8f00-000000000407",
  item: "01890f1e-9b4a-7cc2-8f00-000000000408",
  conflict: "01890f1e-9b4a-7cc2-8f00-000000000409"
} as const;

const webDavTables = [
  "webdav_connections",
  "webdav_directory_mappings",
  "webdav_sync_conflicts",
  "webdav_sync_items"
] as const;

describe("Phase 5 WebDAV schema", () => {
  it("creates restricted connection, mapping, item and conflict relations", async () => {
    await withPlatformTestDatabase(async (database) => {
      const migration = database.createPool("migration");
      await expect(runMigrations(migration)).resolves.toEqual({ applied: 11, verified: 0, total: 11 });
      const tables = await migration.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='platform' AND table_name=ANY($1::text[]) ORDER BY table_name`, [webDavTables]
      );
      expect(tables.rows.map(({ table_name }) => table_name)).toEqual(webDavTables);
      for (const table of webDavTables) {
        await expect(migration.query(
          "SELECT has_table_privilege('platform_web',$1,'DELETE') AS allowed",
          [`platform.${table}`]
        )).resolves.toMatchObject({ rows: [{ allowed: false }] });
      }
      await expect(migration.query(
        "SELECT has_column_privilege('platform_web','platform.webdav_connections','credential_ref','SELECT') AS allowed"
      )).resolves.toMatchObject({ rows: [{ allowed: true }] });
    });
  });

  it("enforces project ownership, ready objects, conflict decisions and deletion protection", async () => {
    await withPlatformTestDatabase(async (database) => {
      const migration = database.createPool("migration");
      await runMigrations(migration);
      await seed(migration);
      const web = database.createPool("web");
      await web.query(
        `INSERT INTO platform.webdav_connections
          (id,name,endpoint_url,credential_ref,status,created_by_user_id)
         VALUES ($1,'坚果云','https://dav.example.test/','secret/webdav/test','active',$2)`,
        [ids.connection, ids.admin]
      );
      await web.query(
        `INSERT INTO platform.webdav_directory_mappings
          (id,connection_id,project_id,incoming_path,outgoing_path,publish_variant,status,scan_interval_seconds,created_by_user_id)
         VALUES ($1,$2,$3,'/Incoming/GX','/Published/GX','signed','active',300,$4)`,
        [ids.mapping, ids.connection, ids.project, ids.admin]
      );
      await expect(web.query(
        `INSERT INTO platform.webdav_sync_items
          (id,mapping_id,project_id,direction,remote_path,discovery_key,status,storage_object_id)
         VALUES ($1,$2,$3,'inbound','/Incoming/GX/A01.pdf','etag:1','validating',$4)`,
        [ids.item, ids.mapping, ids.otherProject, ids.storage]
      )).rejects.toMatchObject({ code: "23503" });
      await expect(web.query(
        `INSERT INTO platform.webdav_sync_items
          (id,mapping_id,project_id,direction,remote_path,discovery_key,status,storage_object_id)
         VALUES ($1,$2,$3,'inbound','/Incoming/GX/A01.pdf','etag:1','validating',$4)`,
        [ids.item, ids.mapping, ids.project, ids.staging]
      )).rejects.toMatchObject({ code: "23514" });
      await web.query(
        `INSERT INTO platform.webdav_sync_items
          (id,mapping_id,project_id,direction,remote_path,discovery_key,status,storage_object_id)
         VALUES ($1,$2,$3,'inbound','/Incoming/GX/A01.pdf','etag:1','conflict',$4)`,
        [ids.item, ids.mapping, ids.project, ids.storage]
      );
      await web.query(
        `INSERT INTO platform.webdav_sync_conflicts
          (id,mapping_id,project_id,sync_item_id,direction,remote_path,status,remote_sha256,cloud_sha256)
         VALUES ($1,$2,$3,$4,'inbound','/Incoming/GX/A01.pdf','open',decode(repeat('11',32),'hex'),decode(repeat('22',32),'hex'))`,
        [ids.conflict, ids.mapping, ids.project, ids.item]
      );
      await expect(web.query(
        "UPDATE platform.webdav_sync_conflicts SET status='resolved',version=version+1 WHERE id=$1",
        [ids.conflict]
      )).rejects.toMatchObject({ code: "23514" });
      await expect(web.query("DELETE FROM platform.webdav_sync_items WHERE id=$1", [ids.item]))
        .rejects.toMatchObject({ code: "42501" });
    });
  });
});

async function seed(pool: Pool) {
  await pool.query(
    `INSERT INTO platform.users
      (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES ($1,'admin@example.test','管理员','$argon2id$seed','admin','active','enabled')`, [ids.admin]
  );
  await pool.query(
    "INSERT INTO platform.projects (id,name,status) VALUES ($1,'项目 A','active'),($2,'项目 B','active')",
    [ids.project, ids.otherProject]
  );
  await pool.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at)
     VALUES ($1,'ready','filesystem','phase5/ready.pdf',4,decode(repeat('42',32),'hex'),'application/pdf',clock_timestamp())`,
    [ids.storage]
  );
  await pool.query(
    `INSERT INTO platform.storage_objects (id,status,driver,object_key,upload_expires_at)
     VALUES ($1,'staging','filesystem','phase5/staging.pdf',clock_timestamp()+interval '1 hour')`, [ids.staging]
  );
}
