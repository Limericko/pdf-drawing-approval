import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDatabase, migrateDatabase } from "./db.ts";

describe("database indexes", () => {
  it("creates approval indexes used by V7 list, risk, and version queries", () => {
    const db = createDatabase(":memory:");
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(indexes.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "idx_approvals_status_submitted",
        "idx_approvals_signature_status_submitted",
        "idx_approvals_project_part_submitted",
        "idx_approvals_current_file_path",
        "idx_approvals_submitted_by_user",
        "idx_operation_logs_target_created_id",
        "idx_operation_logs_created_id"
      ])
    );
  });

  it("keeps operation log indexes aligned with timeline and admin log ordering", () => {
    const db = createDatabase(":memory:");
    const indexColumns = (name: string) =>
      (
        db.prepare(`PRAGMA index_info(${name})`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);

    expect(indexColumns("idx_operation_logs_target_created_id")).toEqual(["target_type", "target_id", "created_at", "id"]);
    expect(indexColumns("idx_operation_logs_created_id")).toEqual(["created_at", "id"]);
  });

  it("migrates existing approval tables before creating PDM approval indexes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name TEXT NOT NULL,
        part_name TEXT NOT NULL,
        version TEXT NOT NULL,
        minor_version TEXT NOT NULL,
        major_version TEXT NOT NULL,
        original_file_path TEXT NOT NULL,
        current_file_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'rejected', 'approved_for_print', 'printed_archived', 'filename_invalid', 'file_missing', 'invalid_pdf', 'voided')),
        submitted_by TEXT,
        submitted_by_user_id INTEGER,
        source TEXT NOT NULL DEFAULT 'folder_watch' CHECK (source IN ('web_upload', 'folder_watch')),
        original_file_hash TEXT,
        signed_file_path TEXT,
        signed_file_hash TEXT,
        signed_at TEXT,
        signature_status TEXT NOT NULL DEFAULT 'not_required' CHECK (signature_status IN ('not_required', 'placement_required', 'pending', 'ready', 'generated', 'failed')),
        signature_error TEXT,
        submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        supervisor_status TEXT NOT NULL DEFAULT 'pending' CHECK (supervisor_status IN ('pending', 'approved', 'rejected')),
        supervisor_comment TEXT,
        supervisor_reviewed_at TEXT,
        process_status TEXT NOT NULL DEFAULT 'pending' CHECK (process_status IN ('pending', 'approved', 'rejected')),
        process_comment TEXT,
        process_reviewed_at TEXT,
        printed_at TEXT,
        archived_at TEXT,
        UNIQUE(project_name, part_name, version)
      );
    `);

    expect(() => migrateDatabase(db)).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["pdm_metadata_status", "pdm_publish_status"]));

    const indexColumns = (
      db.prepare("PRAGMA index_info(idx_approvals_pdm_metadata_status)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(indexColumns).toEqual(["pdm_metadata_status", "pdm_publish_status", "submitted_at", "id"]);
  });
});
