import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DatabaseConnection = DatabaseSync;

export function createDatabase(databasePath: string): DatabaseConnection {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  if (databasePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  migrateDatabase(db);
  return db;
}

export function migrateDatabase(db: DatabaseConnection) {
  const schemaPath = path.join(process.cwd(), "src", "server", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  db.exec(schema);
  migrateUserPreferences(db);
  migrateApprovalStatusConstraint(db);
  migrateApprovalV3Columns(db);
  migrateApprovalIndexes(db);
  migrateOperationLogIndexes(db);
  migrateSignatureTemplates(db);
  migrateBatchSubmissions(db);
  migrateApprovalAnnotations(db);
}

function migrateApprovalIndexes(db: DatabaseConnection) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_approvals_status_submitted ON approvals(status, submitted_at, id);
    CREATE INDEX IF NOT EXISTS idx_approvals_signature_status_submitted ON approvals(signature_status, submitted_at, id);
    CREATE INDEX IF NOT EXISTS idx_approvals_project_part_submitted ON approvals(project_name, part_name, submitted_at, id);
    CREATE INDEX IF NOT EXISTS idx_approvals_current_file_path ON approvals(current_file_path);
    CREATE INDEX IF NOT EXISTS idx_approvals_submitted_by_user ON approvals(submitted_by_user_id, submitted_at, id);
  `);
}

function migrateOperationLogIndexes(db: DatabaseConnection) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operation_logs_target_created_id ON operation_logs(target_type, target_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_operation_logs_created_id ON operation_logs(created_at, id);
  `);
}

function migrateUserPreferences(db: DatabaseConnection) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER PRIMARY KEY,
      common_projects_json TEXT NOT NULL DEFAULT '[]',
      notification_preferences_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
}

function migrateApprovalStatusConstraint(db: DatabaseConnection) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get() as { sql: string } | undefined;
  if (!row?.sql || (row.sql.includes("'file_missing'") && row.sql.includes("'invalid_pdf'") && row.sql.includes("'voided'"))) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE approvals RENAME TO approvals_old;
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
    INSERT INTO approvals (
      id, project_name, part_name, version, minor_version, major_version,
      original_file_path, current_file_path, status, submitted_by, submitted_by_user_id,
      source, original_file_hash, signed_file_path, signed_file_hash, signed_at,
      signature_status, signature_error, submitted_at,
      supervisor_status, supervisor_comment, supervisor_reviewed_at,
      process_status, process_comment, process_reviewed_at, printed_at, archived_at
    )
    SELECT
      id, project_name, part_name, version, minor_version, major_version,
      original_file_path, current_file_path, status, submitted_by, NULL,
      'folder_watch', NULL, NULL, NULL, NULL, 'not_required', NULL, submitted_at,
      supervisor_status, supervisor_comment, supervisor_reviewed_at,
      process_status, process_comment, process_reviewed_at, printed_at, archived_at
    FROM approvals_old;
    DROP TABLE approvals_old;
    PRAGMA foreign_keys = ON;
  `);
}

function migrateApprovalV3Columns(db: DatabaseConnection) {
  const columns = db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  const migrations: Array<{ name: string; sql: string }> = [
    { name: "submitted_by_user_id", sql: "ALTER TABLE approvals ADD COLUMN submitted_by_user_id INTEGER" },
    {
      name: "source",
      sql: "ALTER TABLE approvals ADD COLUMN source TEXT NOT NULL DEFAULT 'folder_watch' CHECK (source IN ('web_upload', 'folder_watch'))"
    },
    { name: "original_file_hash", sql: "ALTER TABLE approvals ADD COLUMN original_file_hash TEXT" },
    { name: "signed_file_path", sql: "ALTER TABLE approvals ADD COLUMN signed_file_path TEXT" },
    { name: "signed_file_hash", sql: "ALTER TABLE approvals ADD COLUMN signed_file_hash TEXT" },
    { name: "signed_at", sql: "ALTER TABLE approvals ADD COLUMN signed_at TEXT" },
    {
      name: "signature_status",
      sql: "ALTER TABLE approvals ADD COLUMN signature_status TEXT NOT NULL DEFAULT 'not_required' CHECK (signature_status IN ('not_required', 'placement_required', 'pending', 'ready', 'generated', 'failed'))"
    },
    { name: "signature_error", sql: "ALTER TABLE approvals ADD COLUMN signature_error TEXT" }
  ];

  for (const migration of migrations) {
    if (!existing.has(migration.name)) {
      db.exec(migration.sql);
    }
  }
}

function migrateSignatureTemplates(db: DatabaseConnection) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signature_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      project_name TEXT,
      placements_json TEXT NOT NULL,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_signature_templates_project_name ON signature_templates(project_name, updated_at);
  `);
}

function migrateBatchSubmissions(db: DatabaseConnection) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_by_user_id INTEGER,
      project_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'partial')),
      total_count INTEGER NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_batch_submissions_created_at ON batch_submissions(created_at);

    CREATE TABLE IF NOT EXISTS batch_submission_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      approval_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
      error_message TEXT,
      placement_state TEXT CHECK (placement_state IN ('template', 'manual', 'missing')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (batch_id) REFERENCES batch_submissions(id),
      FOREIGN KEY (approval_id) REFERENCES approvals(id)
    );

    CREATE INDEX IF NOT EXISTS idx_batch_submission_items_batch_id ON batch_submission_items(batch_id);
  `);
}

function migrateApprovalAnnotations(db: DatabaseConnection) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id INTEGER NOT NULL,
      author_user_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pin', 'rect', 'arrow', 'circle', 'text', 'ink', 'cloud')),
      message TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      x_ratio REAL NOT NULL,
      y_ratio REAL NOT NULL,
      width_ratio REAL,
      height_ratio REAL,
      end_x_ratio REAL,
      end_y_ratio REAL,
      points_json TEXT,
      style_json TEXT,
      color TEXT NOT NULL DEFAULT 'red' CHECK (color IN ('red', 'amber', 'blue', 'green', 'custom')),
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_by_user_id INTEGER,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (approval_id) REFERENCES approvals(id),
      FOREIGN KEY (author_user_id) REFERENCES users(id),
      FOREIGN KEY (resolved_by_user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_approval_annotations_approval_id ON approval_annotations(approval_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_approval_annotations_resolved ON approval_annotations(approval_id, resolved);
  `);
  migrateApprovalAnnotationV61Columns(db);
}

function migrateApprovalAnnotationV61Columns(db: DatabaseConnection) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approval_annotations'").get() as
    | { sql: string }
    | undefined;
  const columns = db.prepare("PRAGMA table_info(approval_annotations)").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  if (row?.sql.includes("'ink'") && row.sql.includes("'custom'") && existing.has("points_json") && existing.has("style_json")) return;

  const pointsSelect = existing.has("points_json") ? "points_json" : "NULL AS points_json";
  const styleSelect = existing.has("style_json") ? "style_json" : "NULL AS style_json";

  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE approval_annotations RENAME TO approval_annotations_old;
    CREATE TABLE approval_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_id INTEGER NOT NULL,
      author_user_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pin', 'rect', 'arrow', 'circle', 'text', 'ink', 'cloud')),
      message TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      x_ratio REAL NOT NULL,
      y_ratio REAL NOT NULL,
      width_ratio REAL,
      height_ratio REAL,
      end_x_ratio REAL,
      end_y_ratio REAL,
      points_json TEXT,
      style_json TEXT,
      color TEXT NOT NULL DEFAULT 'red' CHECK (color IN ('red', 'amber', 'blue', 'green', 'custom')),
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_by_user_id INTEGER,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (approval_id) REFERENCES approvals(id),
      FOREIGN KEY (author_user_id) REFERENCES users(id),
      FOREIGN KEY (resolved_by_user_id) REFERENCES users(id)
    );
    INSERT INTO approval_annotations (
      id, approval_id, author_user_id, kind, message, page_number,
      x_ratio, y_ratio, width_ratio, height_ratio, end_x_ratio, end_y_ratio,
      points_json, style_json, color, resolved, resolved_by_user_id, resolved_at, created_at, updated_at
    )
    SELECT
      id, approval_id, author_user_id, kind, message, page_number,
      x_ratio, y_ratio, width_ratio, height_ratio, end_x_ratio, end_y_ratio,
      ${pointsSelect}, ${styleSelect}, color, resolved, resolved_by_user_id, resolved_at, created_at, updated_at
    FROM approval_annotations_old;
    DROP TABLE approval_annotations_old;
    PRAGMA foreign_keys = ON;

    CREATE INDEX IF NOT EXISTS idx_approval_annotations_approval_id ON approval_annotations(approval_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_approval_annotations_resolved ON approval_annotations(approval_id, resolved);
  `);
}
