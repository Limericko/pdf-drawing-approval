CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('designer', 'supervisor', 'process', 'printer', 'admin')),
  email TEXT,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INTEGER PRIMARY KEY,
  common_projects_json TEXT NOT NULL DEFAULT '[]',
  notification_preferences_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS approvals (
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
  document_code TEXT,
  material_code TEXT,
  drawing_name TEXT,
  pdm_revision_id INTEGER,
  pdm_metadata_status TEXT NOT NULL DEFAULT 'missing_material_code' CHECK (pdm_metadata_status IN ('complete', 'missing_material_code', 'missing_document_code', 'missing_required')),
  pdm_publish_status TEXT NOT NULL DEFAULT 'not_applicable' CHECK (pdm_publish_status IN ('not_applicable', 'metadata_pending', 'pending', 'published', 'failed')),
  pdm_publish_error TEXT,
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

CREATE TABLE IF NOT EXISTS pdm_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_common INTEGER NOT NULL DEFAULT 0,
  current_revision_id INTEGER,
  created_from_approval_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pdm_parts_name ON pdm_parts(name);
CREATE INDEX IF NOT EXISTS idx_pdm_parts_current_revision ON pdm_parts(current_revision_id);

CREATE TABLE IF NOT EXISTS pdm_drawing_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL,
  material_code TEXT NOT NULL,
  document_code TEXT,
  drawing_name TEXT NOT NULL,
  version TEXT NOT NULL,
  minor_version TEXT NOT NULL,
  major_version TEXT NOT NULL,
  approval_id INTEGER NOT NULL UNIQUE,
  release_status TEXT NOT NULL DEFAULT 'released' CHECK (release_status IN ('released', 'superseded', 'voided')),
  original_file_path TEXT NOT NULL,
  original_file_hash TEXT,
  signed_file_path TEXT,
  signed_file_hash TEXT,
  annotated_file_path TEXT,
  released_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(material_code, version),
  FOREIGN KEY (part_id) REFERENCES pdm_parts(id)
);

CREATE INDEX IF NOT EXISTS idx_pdm_revisions_part_released ON pdm_drawing_revisions(part_id, released_at, id);
CREATE INDEX IF NOT EXISTS idx_pdm_revisions_material_status ON pdm_drawing_revisions(material_code, release_status);

CREATE TABLE IF NOT EXISTS pdm_part_usages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL,
  material_code TEXT NOT NULL,
  project_name TEXT NOT NULL,
  first_approval_id INTEGER NOT NULL,
  last_approval_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(material_code, project_name),
  FOREIGN KEY (part_id) REFERENCES pdm_parts(id)
);

CREATE INDEX IF NOT EXISTS idx_pdm_usages_part_project ON pdm_part_usages(part_id, project_name);
CREATE INDEX IF NOT EXISTS idx_pdm_usages_project ON pdm_part_usages(project_name, material_code);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_target_created_id ON operation_logs(target_type, target_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created_id ON operation_logs(created_at, id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id, created_at);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  processed_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  triggered_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_started_at ON scan_runs(started_at);

CREATE TABLE IF NOT EXISTS backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  backup_path TEXT,
  error_message TEXT,
  triggered_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs(started_at);

CREATE TABLE IF NOT EXISTS signature_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('uploaded_png', 'drawn_png')),
  file_path TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_signature_assets_user_id ON signature_assets(user_id, active);

CREATE TABLE IF NOT EXISTS signature_placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('designer', 'supervisor', 'process')),
  page_number INTEGER NOT NULL,
  x_ratio REAL NOT NULL,
  y_ratio REAL NOT NULL,
  width_ratio REAL NOT NULL,
  height_ratio REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(approval_id, role),
  FOREIGN KEY (approval_id) REFERENCES approvals(id)
);

CREATE INDEX IF NOT EXISTS idx_signature_placements_approval_id ON signature_placements(approval_id);

CREATE TABLE IF NOT EXISTS approval_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  author_user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'issue')),
  message TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  FOREIGN KEY (approval_id) REFERENCES approvals(id),
  FOREIGN KEY (author_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_comments_approval_id ON approval_comments(approval_id, created_at);

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

CREATE TABLE IF NOT EXISTS approval_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  annotation_id INTEGER,
  creator_user_id INTEGER NOT NULL,
  assignee_user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'review', 'closed')),
  due_at TEXT,
  client_request_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  resolution_summary TEXT,
  review_note TEXT,
  forced_close_reason TEXT,
  submitted_for_review_at TEXT,
  closed_by_user_id INTEGER,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (approval_id) REFERENCES approvals(id),
  FOREIGN KEY (annotation_id) REFERENCES approval_annotations(id),
  FOREIGN KEY (creator_user_id) REFERENCES users(id),
  FOREIGN KEY (assignee_user_id) REFERENCES users(id),
  FOREIGN KEY (closed_by_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_issues_approval_status
  ON approval_issues(approval_id, status, severity, created_at, id);
CREATE INDEX IF NOT EXISTS idx_approval_issues_assignee_status
  ON approval_issues(assignee_user_id, status, due_at, id);
CREATE INDEX IF NOT EXISTS idx_approval_issues_annotation_id
  ON approval_issues(annotation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_issues_client_request
  ON approval_issues(client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS approval_issue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  actor_user_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'started', 'submitted_review', 'returned', 'closed', 'force_closed')),
  from_status TEXT CHECK (from_status IN ('open', 'in_progress', 'review', 'closed')),
  to_status TEXT NOT NULL CHECK (to_status IN ('open', 'in_progress', 'review', 'closed')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (issue_id) REFERENCES approval_issues(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_issue_events_issue_created
  ON approval_issue_events(issue_id, created_at, id);

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
