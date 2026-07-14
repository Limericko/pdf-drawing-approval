CREATE TABLE platform.documents (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  document_code text NOT NULL,
  name text NOT NULL,
  created_by_user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT documents_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT documents_project_id_fk FOREIGN KEY (project_id)
    REFERENCES platform.projects(id) ON DELETE RESTRICT,
  CONSTRAINT documents_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT documents_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT documents_project_code_unique UNIQUE (project_id, document_code),
  CONSTRAINT documents_code_check CHECK (btrim(document_code) <> '' AND length(document_code) <= 160),
  CONSTRAINT documents_name_check CHECK (btrim(name) <> '' AND length(name) <= 240),
  CONSTRAINT documents_version_check CHECK (version > 0),
  CONSTRAINT documents_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX documents_created_by_user_id_idx ON platform.documents (created_by_user_id);

CREATE TABLE platform.drawing_revisions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_code text NOT NULL,
  original_object_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'web_upload',
  status text NOT NULL DEFAULT 'draft',
  metadata_status text NOT NULL DEFAULT 'complete',
  material_code text,
  client_request_id text,
  client_request_hash bytea,
  version integer NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL,
  submitted_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT drawing_revisions_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT drawing_revisions_project_document_fk FOREIGN KEY (project_id, document_id)
    REFERENCES platform.documents(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT drawing_revisions_original_object_id_fk FOREIGN KEY (original_object_id)
    REFERENCES platform.storage_objects(id) ON DELETE RESTRICT,
  CONSTRAINT drawing_revisions_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT drawing_revisions_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT drawing_revisions_document_code_unique UNIQUE (document_id, revision_code),
  CONSTRAINT drawing_revisions_revision_code_check CHECK (
    btrim(revision_code) <> '' AND length(revision_code) <= 80
  ),
  CONSTRAINT drawing_revisions_source_check CHECK (source IN ('web_upload', 'webdav_import', 'migration')),
  CONSTRAINT drawing_revisions_status_check CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected', 'published', 'void')
  ),
  CONSTRAINT drawing_revisions_metadata_status_check CHECK (
    metadata_status IN ('complete', 'missing_material_code', 'missing_document_code', 'missing_required')
  ),
  CONSTRAINT drawing_revisions_material_code_check CHECK (
    material_code IS NULL OR (btrim(material_code) <> '' AND length(material_code) <= 160)
  ),
  CONSTRAINT drawing_revisions_client_request_id_check CHECK (
    client_request_id IS NULL OR (btrim(client_request_id) <> '' AND length(client_request_id) <= 160)
  ),
  CONSTRAINT drawing_revisions_version_check CHECK (version > 0),
  CONSTRAINT drawing_revisions_submitted_at_check CHECK (
    submitted_at IS NULL OR submitted_at >= created_at
  ),
  CONSTRAINT drawing_revisions_published_at_check CHECK (
    (status = 'published' AND published_at IS NOT NULL AND published_at >= created_at)
    OR (status <> 'published' AND published_at IS NULL)
  ),
  CONSTRAINT drawing_revisions_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX drawing_revisions_project_document_idx
  ON platform.drawing_revisions (project_id, document_id);
CREATE INDEX drawing_revisions_original_object_id_idx
  ON platform.drawing_revisions (original_object_id);
CREATE INDEX drawing_revisions_created_by_user_id_idx
  ON platform.drawing_revisions (created_by_user_id);
CREATE INDEX drawing_revisions_project_status_idx
  ON platform.drawing_revisions (project_id, status, created_at DESC, id DESC);
CREATE UNIQUE INDEX drawing_revisions_client_request_id_uidx
  ON platform.drawing_revisions (client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE platform.approval_cases (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requires_signature boolean NOT NULL DEFAULT true,
  client_request_id text,
  version integer NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT approval_cases_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT approval_cases_project_revision_fk FOREIGN KEY (project_id, revision_id)
    REFERENCES platform.drawing_revisions(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT approval_cases_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT approval_cases_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT approval_cases_revision_unique UNIQUE (revision_id),
  CONSTRAINT approval_cases_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'void')),
  CONSTRAINT approval_cases_client_request_id_check CHECK (
    client_request_id IS NULL OR (btrim(client_request_id) <> '' AND length(client_request_id) <= 160)
  ),
  CONSTRAINT approval_cases_version_check CHECK (version > 0),
  CONSTRAINT approval_cases_completed_at_check CHECK (
    (status IN ('approved', 'rejected', 'void') AND completed_at IS NOT NULL AND completed_at >= created_at)
    OR (status = 'pending' AND completed_at IS NULL)
  ),
  CONSTRAINT approval_cases_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX approval_cases_project_revision_idx
  ON platform.approval_cases (project_id, revision_id);
CREATE INDEX approval_cases_created_by_user_id_idx
  ON platform.approval_cases (created_by_user_id);
CREATE INDEX approval_cases_project_status_idx
  ON platform.approval_cases (project_id, status, created_at DESC, id DESC);
CREATE UNIQUE INDEX approval_cases_client_request_id_uidx
  ON platform.approval_cases (client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE platform.review_decisions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  approval_case_id uuid NOT NULL,
  reviewer_role text NOT NULL,
  assigned_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  comment text,
  client_request_id text,
  version integer NOT NULL DEFAULT 1,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT review_decisions_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT review_decisions_project_approval_fk FOREIGN KEY (project_id, approval_case_id)
    REFERENCES platform.approval_cases(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_decisions_assigned_user_id_fk FOREIGN KEY (assigned_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT review_decisions_approval_role_unique UNIQUE (approval_case_id, reviewer_role),
  CONSTRAINT review_decisions_reviewer_role_check CHECK (reviewer_role IN ('supervisor', 'process')),
  CONSTRAINT review_decisions_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT review_decisions_comment_check CHECK (
    comment IS NULL OR (btrim(comment) <> '' AND length(comment) <= 4000)
  ),
  CONSTRAINT review_decisions_client_request_id_check CHECK (
    client_request_id IS NULL OR (btrim(client_request_id) <> '' AND length(client_request_id) <= 160)
  ),
  CONSTRAINT review_decisions_rejection_comment_check CHECK (
    status <> 'rejected' OR comment IS NOT NULL
  ),
  CONSTRAINT review_decisions_version_check CHECK (version > 0),
  CONSTRAINT review_decisions_decided_at_check CHECK (
    (status = 'pending' AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_at >= created_at)
  ),
  CONSTRAINT review_decisions_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX review_decisions_project_approval_idx
  ON platform.review_decisions (project_id, approval_case_id);
CREATE INDEX review_decisions_assigned_user_id_idx
  ON platform.review_decisions (assigned_user_id);
CREATE INDEX review_decisions_assignee_status_idx
  ON platform.review_decisions (assigned_user_id, status, created_at, id);
CREATE UNIQUE INDEX review_decisions_client_request_id_uidx
  ON platform.review_decisions (client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE platform.signature_placements (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  approval_case_id uuid NOT NULL,
  signer_role text NOT NULL,
  page_number integer NOT NULL,
  x_ratio double precision NOT NULL,
  y_ratio double precision NOT NULL,
  width_ratio double precision NOT NULL,
  height_ratio double precision NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT signature_placements_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT signature_placements_project_approval_fk FOREIGN KEY (project_id, approval_case_id)
    REFERENCES platform.approval_cases(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT signature_placements_approval_role_unique UNIQUE (approval_case_id, signer_role),
  CONSTRAINT signature_placements_signer_role_check CHECK (
    signer_role IN ('designer', 'supervisor', 'process')
  ),
  CONSTRAINT signature_placements_page_number_check CHECK (page_number > 0),
  CONSTRAINT signature_placements_geometry_check CHECK (
    x_ratio >= 0 AND y_ratio >= 0 AND width_ratio > 0 AND height_ratio > 0
    AND x_ratio + width_ratio <= 1 AND y_ratio + height_ratio <= 1
  ),
  CONSTRAINT signature_placements_version_check CHECK (version > 0),
  CONSTRAINT signature_placements_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX signature_placements_project_approval_idx
  ON platform.signature_placements (project_id, approval_case_id);

CREATE TABLE platform.signature_assets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  object_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'handwritten_png',
  active boolean NOT NULL DEFAULT true,
  client_request_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT signature_assets_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT signature_assets_user_id_fk FOREIGN KEY (user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT signature_assets_object_id_fk FOREIGN KEY (object_id)
    REFERENCES platform.storage_objects(id) ON DELETE RESTRICT,
  CONSTRAINT signature_assets_kind_check CHECK (kind = 'handwritten_png'),
  CONSTRAINT signature_assets_client_request_id_check CHECK (
    client_request_id IS NULL OR (btrim(client_request_id) <> '' AND length(client_request_id) <= 160)
  )
);

CREATE INDEX signature_assets_user_id_idx ON platform.signature_assets (user_id, created_at, id);
CREATE INDEX signature_assets_object_id_idx ON platform.signature_assets (object_id);
CREATE UNIQUE INDEX signature_assets_active_user_uidx
  ON platform.signature_assets (user_id) WHERE active = true;
CREATE UNIQUE INDEX signature_assets_client_request_id_uidx
  ON platform.signature_assets (client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE platform.annotations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  approval_case_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  kind text NOT NULL,
  page_number integer NOT NULL,
  geometry jsonb NOT NULL,
  style jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text NOT NULL,
  resolved boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT annotations_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT annotations_project_approval_fk FOREIGN KEY (project_id, approval_case_id)
    REFERENCES platform.approval_cases(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT annotations_author_user_id_fk FOREIGN KEY (author_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT annotations_approval_id_unique UNIQUE (approval_case_id, id),
  CONSTRAINT annotations_kind_check CHECK (
    kind IN ('pin', 'rect', 'arrow', 'circle', 'text', 'ink', 'cloud')
  ),
  CONSTRAINT annotations_page_number_check CHECK (page_number > 0),
  CONSTRAINT annotations_geometry_check CHECK (jsonb_typeof(geometry) = 'object'),
  CONSTRAINT annotations_style_check CHECK (jsonb_typeof(style) = 'object'),
  CONSTRAINT annotations_message_check CHECK (btrim(message) <> '' AND length(message) <= 4000),
  CONSTRAINT annotations_version_check CHECK (version > 0),
  CONSTRAINT annotations_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX annotations_project_approval_idx
  ON platform.annotations (project_id, approval_case_id);
CREATE INDEX annotations_author_user_id_idx ON platform.annotations (author_user_id);
CREATE INDEX annotations_open_idx
  ON platform.annotations (approval_case_id, page_number, created_at, id) WHERE resolved = false;

CREATE TABLE platform.issues (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  approval_case_id uuid NOT NULL,
  annotation_id uuid,
  creator_user_id uuid NOT NULL,
  assignee_user_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  due_at timestamptz,
  resolution_summary text,
  review_note text,
  forced_close_reason text,
  client_request_id text,
  client_request_hash bytea,
  version integer NOT NULL DEFAULT 1,
  submitted_for_review_at timestamptz,
  closed_by_user_id uuid,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT issues_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT issues_project_approval_fk FOREIGN KEY (project_id, approval_case_id)
    REFERENCES platform.approval_cases(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT issues_approval_annotation_fk FOREIGN KEY (approval_case_id, annotation_id)
    REFERENCES platform.annotations(approval_case_id, id) ON DELETE RESTRICT,
  CONSTRAINT issues_creator_user_id_fk FOREIGN KEY (creator_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT issues_assignee_user_id_fk FOREIGN KEY (assignee_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT issues_closed_by_user_id_fk FOREIGN KEY (closed_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT issues_title_check CHECK (btrim(title) <> '' AND length(title) <= 240),
  CONSTRAINT issues_description_check CHECK (btrim(description) <> '' AND length(description) <= 8000),
  CONSTRAINT issues_severity_check CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT issues_status_check CHECK (status IN ('open', 'in_progress', 'review', 'closed')),
  CONSTRAINT issues_resolution_summary_check CHECK (
    resolution_summary IS NULL OR (btrim(resolution_summary) <> '' AND length(resolution_summary) <= 8000)
  ),
  CONSTRAINT issues_review_note_check CHECK (
    review_note IS NULL OR (btrim(review_note) <> '' AND length(review_note) <= 8000)
  ),
  CONSTRAINT issues_forced_close_reason_check CHECK (
    forced_close_reason IS NULL OR (btrim(forced_close_reason) <> '' AND length(forced_close_reason) <= 4000)
  ),
  CONSTRAINT issues_client_request_id_check CHECK (
    client_request_id IS NULL OR (btrim(client_request_id) <> '' AND length(client_request_id) <= 160)
  ),
  CONSTRAINT issues_client_request_hash_check CHECK (
    (client_request_id IS NULL AND client_request_hash IS NULL)
    OR (client_request_id IS NOT NULL AND octet_length(client_request_hash) = 32)
  ),
  CONSTRAINT issues_version_check CHECK (version > 0),
  CONSTRAINT issues_submitted_for_review_at_check CHECK (
    submitted_for_review_at IS NULL OR submitted_for_review_at >= created_at
  ),
  CONSTRAINT issues_closed_state_check CHECK (
    (status = 'closed' AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL AND closed_at >= created_at)
    OR (status <> 'closed' AND closed_by_user_id IS NULL AND closed_at IS NULL)
  ),
  CONSTRAINT issues_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX issues_project_approval_idx ON platform.issues (project_id, approval_case_id);
CREATE INDEX issues_approval_annotation_idx ON platform.issues (approval_case_id, annotation_id);
CREATE INDEX issues_creator_user_id_idx ON platform.issues (creator_user_id);
CREATE INDEX issues_closed_by_user_id_idx ON platform.issues (closed_by_user_id);
CREATE INDEX issues_assignee_status_idx
  ON platform.issues (assignee_user_id, status, due_at, id);
CREATE INDEX issues_approval_blocking_idx
  ON platform.issues (approval_case_id, severity, created_at, id) WHERE status <> 'closed';
CREATE UNIQUE INDEX issues_client_request_id_uidx
  ON platform.issues (client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE platform.issue_events (
  id uuid PRIMARY KEY,
  issue_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text,
  client_request_id text,
  client_request_hash bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT issue_events_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT issue_events_issue_id_fk FOREIGN KEY (issue_id)
    REFERENCES platform.issues(id) ON DELETE RESTRICT,
  CONSTRAINT issue_events_actor_user_id_fk FOREIGN KEY (actor_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT issue_events_event_type_check CHECK (
    event_type IN ('created', 'started', 'submitted', 'returned', 'closed', 'force_closed', 'updated')
  ),
  CONSTRAINT issue_events_from_status_check CHECK (
    from_status IS NULL OR from_status IN ('open', 'in_progress', 'review', 'closed')
  ),
  CONSTRAINT issue_events_to_status_check CHECK (to_status IN ('open', 'in_progress', 'review', 'closed')),
  CONSTRAINT issue_events_note_check CHECK (
    note IS NULL OR (btrim(note) <> '' AND length(note) <= 8000)
  ),
  CONSTRAINT issue_events_client_request_id_check CHECK (
    client_request_id IS NULL OR (btrim(client_request_id) <> '' AND length(client_request_id) <= 160)
  ),
  CONSTRAINT issue_events_client_request_hash_check CHECK (
    (client_request_id IS NULL AND client_request_hash IS NULL)
    OR (client_request_id IS NOT NULL AND octet_length(client_request_hash) = 32)
  )
);

CREATE INDEX issue_events_issue_id_idx ON platform.issue_events (issue_id, created_at, id);
CREATE INDEX issue_events_actor_user_id_idx ON platform.issue_events (actor_user_id);
CREATE UNIQUE INDEX issue_events_client_request_id_uidx
  ON platform.issue_events (client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE platform.render_artifacts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  approval_case_id uuid NOT NULL,
  kind text NOT NULL,
  generation integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  object_id uuid,
  error_code text,
  idempotency_key text NOT NULL,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT render_artifacts_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT render_artifacts_project_approval_fk FOREIGN KEY (project_id, approval_case_id)
    REFERENCES platform.approval_cases(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT render_artifacts_object_id_fk FOREIGN KEY (object_id)
    REFERENCES platform.storage_objects(id) ON DELETE RESTRICT,
  CONSTRAINT render_artifacts_approval_kind_generation_unique UNIQUE (approval_case_id, kind, generation),
  CONSTRAINT render_artifacts_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT render_artifacts_kind_check CHECK (kind IN ('annotated_review', 'signed_pdf')),
  CONSTRAINT render_artifacts_generation_check CHECK (generation > 0),
  CONSTRAINT render_artifacts_status_check CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  CONSTRAINT render_artifacts_error_code_check CHECK (
    error_code IS NULL OR (btrim(error_code) <> '' AND length(error_code) <= 160)
  ),
  CONSTRAINT render_artifacts_result_check CHECK (
    (status = 'ready' AND object_id IS NOT NULL AND ready_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND object_id IS NULL AND ready_at IS NULL AND error_code IS NOT NULL)
    OR (status IN ('pending', 'processing') AND object_id IS NULL AND ready_at IS NULL AND error_code IS NULL)
  ),
  CONSTRAINT render_artifacts_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX render_artifacts_project_approval_idx
  ON platform.render_artifacts (project_id, approval_case_id);
CREATE INDEX render_artifacts_object_id_idx ON platform.render_artifacts (object_id);
CREATE INDEX render_artifacts_pending_idx
  ON platform.render_artifacts (status, created_at, id) WHERE status IN ('pending', 'processing');

CREATE TABLE platform.print_archive_events (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  approval_case_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  object_id uuid,
  printer_name text,
  status text NOT NULL,
  error_code text,
  client_request_id text NOT NULL,
  client_request_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT print_archive_events_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT print_archive_events_project_approval_fk FOREIGN KEY (project_id, approval_case_id)
    REFERENCES platform.approval_cases(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT print_archive_events_actor_user_id_fk FOREIGN KEY (actor_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT print_archive_events_object_id_fk FOREIGN KEY (object_id)
    REFERENCES platform.storage_objects(id) ON DELETE RESTRICT,
  CONSTRAINT print_archive_events_printer_name_check CHECK (
    printer_name IS NULL OR (btrim(printer_name) <> '' AND length(printer_name) <= 240)
  ),
  CONSTRAINT print_archive_events_status_check CHECK (status IN ('accepted', 'archived', 'failed')),
  CONSTRAINT print_archive_events_error_code_check CHECK (
    error_code IS NULL OR (btrim(error_code) <> '' AND length(error_code) <= 160)
  ),
  CONSTRAINT print_archive_events_client_request_id_check CHECK (
    btrim(client_request_id) <> '' AND length(client_request_id) <= 160
  ),
  CONSTRAINT print_archive_events_client_request_hash_check CHECK (octet_length(client_request_hash) = 32),
  CONSTRAINT print_archive_events_client_request_id_unique UNIQUE (client_request_id),
  CONSTRAINT print_archive_events_result_check CHECK (
    (status IN ('accepted', 'archived') AND object_id IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND error_code IS NOT NULL)
  )
);

CREATE INDEX print_archive_events_project_approval_idx
  ON platform.print_archive_events (project_id, approval_case_id);
CREATE INDEX print_archive_events_actor_user_id_idx ON platform.print_archive_events (actor_user_id);
CREATE INDEX print_archive_events_object_id_idx ON platform.print_archive_events (object_id);

CREATE TABLE platform.parts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  part_number text NOT NULL,
  name text NOT NULL,
  current_revision_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT parts_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT parts_project_id_fk FOREIGN KEY (project_id)
    REFERENCES platform.projects(id) ON DELETE RESTRICT,
  CONSTRAINT parts_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT parts_project_number_unique UNIQUE (project_id, part_number),
  CONSTRAINT parts_number_check CHECK (btrim(part_number) <> '' AND length(part_number) <= 160),
  CONSTRAINT parts_name_check CHECK (btrim(name) <> '' AND length(name) <= 240),
  CONSTRAINT parts_version_check CHECK (version > 0),
  CONSTRAINT parts_updated_at_check CHECK (updated_at >= created_at)
);

CREATE TABLE platform.part_revision_links (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  part_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  material_code text,
  release_status text NOT NULL DEFAULT 'pending_metadata',
  void_reason text,
  version integer NOT NULL DEFAULT 1,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT part_revision_links_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT part_revision_links_project_part_fk FOREIGN KEY (project_id, part_id)
    REFERENCES platform.parts(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT part_revision_links_project_revision_fk FOREIGN KEY (project_id, revision_id)
    REFERENCES platform.drawing_revisions(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT part_revision_links_part_revision_unique UNIQUE (part_id, revision_id),
  CONSTRAINT part_revision_links_revision_unique UNIQUE (revision_id),
  CONSTRAINT part_revision_links_material_code_check CHECK (
    material_code IS NULL OR (btrim(material_code) <> '' AND length(material_code) <= 160)
  ),
  CONSTRAINT part_revision_links_status_check CHECK (
    release_status IN ('pending_metadata', 'pending', 'published', 'failed', 'void')
  ),
  CONSTRAINT part_revision_links_void_reason_check CHECK (
    void_reason IS NULL OR (btrim(void_reason) <> '' AND length(void_reason) <= 4000)
  ),
  CONSTRAINT part_revision_links_void_state_check CHECK (
    release_status <> 'void' OR void_reason IS NOT NULL
  ),
  CONSTRAINT part_revision_links_version_check CHECK (version > 0),
  CONSTRAINT part_revision_links_released_at_check CHECK (
    (release_status = 'published' AND released_at IS NOT NULL AND released_at >= created_at)
    OR (release_status = 'void' AND (released_at IS NULL OR released_at >= created_at))
    OR (release_status IN ('pending_metadata', 'pending', 'failed') AND released_at IS NULL)
  ),
  CONSTRAINT part_revision_links_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX part_revision_links_project_part_idx
  ON platform.part_revision_links (project_id, part_id);
CREATE INDEX part_revision_links_project_revision_idx
  ON platform.part_revision_links (project_id, revision_id);
CREATE INDEX part_revision_links_status_idx
  ON platform.part_revision_links (project_id, release_status, created_at, id);

CREATE TABLE platform.pdm_mutation_requests (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  part_revision_link_id uuid NOT NULL,
  action text NOT NULL,
  client_request_id text NOT NULL,
  payload_hash bytea NOT NULL,
  result_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pdm_mutation_requests_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT pdm_mutation_requests_project_id_fk FOREIGN KEY (project_id)
    REFERENCES platform.projects(id) ON DELETE RESTRICT,
  CONSTRAINT pdm_mutation_requests_part_revision_link_id_fk FOREIGN KEY (part_revision_link_id)
    REFERENCES platform.part_revision_links(id) ON DELETE RESTRICT,
  CONSTRAINT pdm_mutation_requests_client_request_id_unique UNIQUE (client_request_id),
  CONSTRAINT pdm_mutation_requests_action_check CHECK (action IN ('metadata_update', 'publish_retry', 'void')),
  CONSTRAINT pdm_mutation_requests_client_request_id_check CHECK (
    btrim(client_request_id) <> '' AND length(client_request_id) <= 160
  ),
  CONSTRAINT pdm_mutation_requests_payload_hash_check CHECK (octet_length(payload_hash) = 32),
  CONSTRAINT pdm_mutation_requests_result_version_check CHECK (result_version > 0)
);

CREATE INDEX pdm_mutation_requests_project_id_idx ON platform.pdm_mutation_requests (project_id);
CREATE INDEX pdm_mutation_requests_part_revision_link_id_idx
  ON platform.pdm_mutation_requests (part_revision_link_id);

ALTER TABLE platform.parts
  ADD CONSTRAINT parts_current_revision_link_fk FOREIGN KEY (id, current_revision_id)
  REFERENCES platform.part_revision_links(part_id, revision_id) ON DELETE RESTRICT;

CREATE INDEX parts_current_revision_id_idx ON platform.parts (current_revision_id);
CREATE INDEX parts_current_revision_link_idx ON platform.parts (id, current_revision_id);

CREATE TABLE platform.part_usages (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  part_id uuid NOT NULL,
  used_in_project_id uuid NOT NULL,
  first_approval_case_id uuid NOT NULL,
  last_approval_case_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT part_usages_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT part_usages_project_part_fk FOREIGN KEY (project_id, part_id)
    REFERENCES platform.parts(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT part_usages_used_in_project_id_fk FOREIGN KEY (used_in_project_id)
    REFERENCES platform.projects(id) ON DELETE RESTRICT,
  CONSTRAINT part_usages_first_approval_case_id_fk FOREIGN KEY (first_approval_case_id)
    REFERENCES platform.approval_cases(id) ON DELETE RESTRICT,
  CONSTRAINT part_usages_last_approval_case_id_fk FOREIGN KEY (last_approval_case_id)
    REFERENCES platform.approval_cases(id) ON DELETE RESTRICT,
  CONSTRAINT part_usages_part_project_unique UNIQUE (part_id, used_in_project_id),
  CONSTRAINT part_usages_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX part_usages_project_part_idx ON platform.part_usages (project_id, part_id);
CREATE INDEX part_usages_used_in_project_id_idx ON platform.part_usages (used_in_project_id);
CREATE INDEX part_usages_first_approval_case_id_idx ON platform.part_usages (first_approval_case_id);
CREATE INDEX part_usages_last_approval_case_id_idx ON platform.part_usages (last_approval_case_id);

CREATE TABLE platform.backup_runs (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  status text NOT NULL,
  actor_user_id uuid,
  recovery_point_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  verification_status text NOT NULL DEFAULT 'pending',
  error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT backup_runs_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT backup_runs_actor_user_id_fk FOREIGN KEY (actor_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT backup_runs_provider_check CHECK (
    provider IN ('postgres_pitr', 'object_versioning', 'configuration_export')
  ),
  CONSTRAINT backup_runs_status_check CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT backup_runs_verification_status_check CHECK (
    verification_status IN ('pending', 'passed', 'failed')
  ),
  CONSTRAINT backup_runs_error_code_check CHECK (
    error_code IS NULL OR (btrim(error_code) <> '' AND length(error_code) <= 160)
  ),
  CONSTRAINT backup_runs_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT backup_runs_completion_check CHECK (
    (status = 'running' AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND completed_at >= started_at AND error_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND completed_at >= started_at AND error_code IS NOT NULL)
  )
);

CREATE INDEX backup_runs_actor_user_id_idx ON platform.backup_runs (actor_user_id);
CREATE INDEX backup_runs_status_idx ON platform.backup_runs (status, started_at DESC, id DESC);

CREATE TABLE platform.admin_mutation_requests (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target_id uuid NOT NULL,
  client_request_id text NOT NULL,
  payload_hash bytea NOT NULL,
  result_changed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT admin_mutation_requests_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT admin_mutation_requests_actor_user_id_fk FOREIGN KEY (actor_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT admin_mutation_requests_action_check CHECK (
    action IN ('user_status','membership_update','session_revoke','job_retry')
  ),
  CONSTRAINT admin_mutation_requests_client_request_id_check CHECK (
    btrim(client_request_id) <> '' AND length(client_request_id) <= 160
  ),
  CONSTRAINT admin_mutation_requests_payload_hash_check CHECK (octet_length(payload_hash) = 32),
  CONSTRAINT admin_mutation_requests_client_request_id_unique UNIQUE (client_request_id)
);

CREATE INDEX admin_mutation_requests_actor_user_id_idx
  ON platform.admin_mutation_requests (actor_user_id, created_at, id);

CREATE FUNCTION platform.reject_published_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'PUBLISHED_REVISION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER drawing_revisions_published_immutable
BEFORE UPDATE OR DELETE ON platform.drawing_revisions
FOR EACH ROW EXECUTE FUNCTION platform.reject_published_revision_mutation();

REVOKE ALL ON FUNCTION platform.reject_published_revision_mutation() FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.require_ready_storage_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = platform, pg_temp
AS $$
DECLARE
  referenced_object_id uuid;
BEGIN
  referenced_object_id := CASE TG_TABLE_NAME
    WHEN 'drawing_revisions' THEN (to_jsonb(NEW)->>'original_object_id')::uuid
    ELSE (to_jsonb(NEW)->>'object_id')::uuid
  END;
  IF referenced_object_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM platform.storage_objects object
    WHERE object.id = referenced_object_id AND object.status = 'ready'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'storage object is not ready';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER drawing_revisions_ready_object_trigger
BEFORE INSERT OR UPDATE OF original_object_id ON platform.drawing_revisions
FOR EACH ROW EXECUTE FUNCTION platform.require_ready_storage_object();
CREATE TRIGGER signature_assets_ready_object_trigger
BEFORE INSERT OR UPDATE OF object_id ON platform.signature_assets
FOR EACH ROW EXECUTE FUNCTION platform.require_ready_storage_object();
CREATE TRIGGER render_artifacts_ready_object_trigger
BEFORE INSERT OR UPDATE OF object_id ON platform.render_artifacts
FOR EACH ROW EXECUTE FUNCTION platform.require_ready_storage_object();
CREATE TRIGGER print_archive_events_ready_object_trigger
BEFORE INSERT OR UPDATE OF object_id ON platform.print_archive_events
FOR EACH ROW EXECUTE FUNCTION platform.require_ready_storage_object();

REVOKE ALL ON FUNCTION platform.require_ready_storage_object() FROM PUBLIC;

REVOKE ALL ON TABLE
  platform.admin_mutation_requests,
  platform.documents,
  platform.drawing_revisions,
  platform.approval_cases,
  platform.review_decisions,
  platform.signature_placements,
  platform.signature_assets,
  platform.annotations,
  platform.issues,
  platform.issue_events,
  platform.render_artifacts,
  platform.print_archive_events,
  platform.parts,
  platform.part_revision_links,
  platform.pdm_mutation_requests,
  platform.part_usages,
  platform.backup_runs
FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE
  platform.admin_mutation_requests,
  platform.documents,
  platform.drawing_revisions,
  platform.approval_cases,
  platform.review_decisions,
  platform.signature_placements,
  platform.signature_assets,
  platform.annotations,
  platform.issues,
  platform.issue_events,
  platform.render_artifacts,
  platform.print_archive_events,
  platform.parts,
  platform.part_revision_links,
  platform.pdm_mutation_requests,
  platform.part_usages,
  platform.backup_runs
TO platform_web;

GRANT UPDATE (document_code, name, version, updated_at)
  ON TABLE platform.documents TO platform_web;
GRANT UPDATE (status, metadata_status, material_code, version, submitted_at, published_at, updated_at)
  ON TABLE platform.drawing_revisions TO platform_web;
GRANT UPDATE (status, requires_signature, version, completed_at, updated_at)
  ON TABLE platform.approval_cases TO platform_web;
GRANT UPDATE (assigned_user_id, status, comment, client_request_id, version, decided_at, updated_at)
  ON TABLE platform.review_decisions TO platform_web;
GRANT UPDATE (page_number, x_ratio, y_ratio, width_ratio, height_ratio, version, updated_at)
  ON TABLE platform.signature_placements TO platform_web;
GRANT UPDATE (active) ON TABLE platform.signature_assets TO platform_web;
GRANT UPDATE (geometry, style, message, resolved, version, updated_at)
  ON TABLE platform.annotations TO platform_web;
GRANT UPDATE (
  assignee_user_id, title, description, severity, status, due_at, resolution_summary,
  review_note, forced_close_reason, version, submitted_for_review_at, closed_by_user_id,
  closed_at, updated_at
) ON TABLE platform.issues TO platform_web;
GRANT UPDATE (status, object_id, error_code, ready_at, updated_at)
  ON TABLE platform.render_artifacts TO platform_web;
GRANT UPDATE (current_revision_id, version, updated_at)
  ON TABLE platform.parts TO platform_web;
GRANT UPDATE (material_code, release_status, void_reason, version, released_at, updated_at)
  ON TABLE platform.part_revision_links TO platform_web;
GRANT UPDATE (last_approval_case_id, updated_at)
  ON TABLE platform.part_usages TO platform_web;
GRANT UPDATE (status, recovery_point_at, completed_at, verification_status, error_code, metadata)
  ON TABLE platform.backup_runs TO platform_web;

GRANT SELECT ON TABLE
  platform.documents,
  platform.drawing_revisions,
  platform.approval_cases,
  platform.review_decisions,
  platform.signature_placements,
  platform.signature_assets,
  platform.annotations,
  platform.issues,
  platform.issue_events,
  platform.render_artifacts,
  platform.print_archive_events,
  platform.parts,
  platform.part_revision_links,
  platform.pdm_mutation_requests,
  platform.part_usages,
  platform.backup_runs
TO platform_worker;

GRANT UPDATE (status, attempt_count, next_run_at, lease_expires_at, lease_token, worker_id,
  last_error_code, last_error_message, updated_at, started_at, completed_at)
  ON TABLE platform.jobs TO platform_web;

GRANT INSERT ON TABLE
  platform.render_artifacts,
  platform.issue_events,
  platform.backup_runs,
  platform.parts,
  platform.part_revision_links,
  platform.part_usages
TO platform_worker;
GRANT INSERT (id, status, driver, object_key, created_at, updated_at, upload_expires_at)
  ON TABLE platform.storage_objects TO platform_worker;
GRANT UPDATE (status, size_bytes, sha256, media_type, ready_at, updated_at)
  ON TABLE platform.storage_objects TO platform_worker;
GRANT UPDATE (status, object_id, error_code, ready_at, updated_at)
  ON TABLE platform.render_artifacts TO platform_worker;
GRANT UPDATE (material_code, release_status, void_reason, version, released_at, updated_at)
  ON TABLE platform.part_revision_links TO platform_worker;
GRANT UPDATE (current_revision_id, version, updated_at)
  ON TABLE platform.parts TO platform_worker;
GRANT UPDATE (status, material_code, version, published_at, updated_at)
  ON TABLE platform.drawing_revisions TO platform_worker;
GRANT UPDATE (last_approval_case_id, updated_at)
  ON TABLE platform.part_usages TO platform_worker;
GRANT UPDATE (status, recovery_point_at, completed_at, verification_status, error_code, metadata)
  ON TABLE platform.backup_runs TO platform_worker;
