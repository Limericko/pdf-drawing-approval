CREATE TABLE platform.legacy_migration_runs (
  id uuid PRIMARY KEY,
  source_id text NOT NULL,
  mode text NOT NULL,
  source_fingerprint_sha256 text NOT NULL,
  baseline_run_id uuid,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT legacy_migration_runs_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT legacy_migration_runs_source_id_check CHECK (
    source_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$'
  ),
  CONSTRAINT legacy_migration_runs_mode_check CHECK (mode IN ('import', 'verify', 'delta')),
  CONSTRAINT legacy_migration_runs_fingerprint_check CHECK (
    source_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT legacy_migration_runs_baseline_fk FOREIGN KEY (baseline_run_id)
    REFERENCES platform.legacy_migration_runs(id) ON DELETE RESTRICT,
  CONSTRAINT legacy_migration_runs_status_check CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT legacy_migration_runs_completion_check CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL AND completed_at >= started_at)
  ),
  CONSTRAINT legacy_migration_runs_report_check CHECK (jsonb_typeof(report) = 'object')
);

CREATE INDEX legacy_migration_runs_source_started_idx
  ON platform.legacy_migration_runs (source_id, started_at DESC, id DESC);
CREATE INDEX legacy_migration_runs_baseline_run_id_idx
  ON platform.legacy_migration_runs (baseline_run_id);
CREATE UNIQUE INDEX legacy_migration_runs_active_source_uidx
  ON platform.legacy_migration_runs (source_id) WHERE status = 'running';

CREATE TABLE platform.legacy_id_mappings (
  source_id text NOT NULL,
  entity_type text NOT NULL,
  legacy_id text NOT NULL,
  target_table text NOT NULL,
  target_id uuid NOT NULL,
  source_row_sha256 text NOT NULL,
  first_run_id uuid NOT NULL,
  last_seen_run_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (source_id, entity_type, legacy_id),
  CONSTRAINT legacy_id_mappings_source_id_check CHECK (
    source_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$'
  ),
  CONSTRAINT legacy_id_mappings_entity_type_check CHECK (
    entity_type ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT legacy_id_mappings_legacy_id_check CHECK (
    btrim(legacy_id) <> '' AND length(legacy_id) <= 240
  ),
  CONSTRAINT legacy_id_mappings_target_table_check CHECK (
    target_table ~ '^platform\.[a-z][a-z0-9_]{0,62}$'
  ),
  CONSTRAINT legacy_id_mappings_target_id_uuid_v7_check CHECK (
    substr(target_id::text, 15, 1) = '7' AND substr(target_id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT legacy_id_mappings_target_unique UNIQUE (target_table, target_id),
  CONSTRAINT legacy_id_mappings_row_hash_check CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT legacy_id_mappings_first_run_fk FOREIGN KEY (first_run_id)
    REFERENCES platform.legacy_migration_runs(id) ON DELETE RESTRICT,
  CONSTRAINT legacy_id_mappings_last_seen_run_fk FOREIGN KEY (last_seen_run_id)
    REFERENCES platform.legacy_migration_runs(id) ON DELETE RESTRICT,
  CONSTRAINT legacy_id_mappings_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX legacy_id_mappings_last_seen_run_idx
  ON platform.legacy_id_mappings (last_seen_run_id, entity_type, legacy_id);
CREATE INDEX legacy_id_mappings_first_run_id_idx
  ON platform.legacy_id_mappings (first_run_id);

CREATE TABLE platform.legacy_file_mappings (
  source_id text NOT NULL,
  source_path_sha256 text NOT NULL,
  source_content_sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  media_type text NOT NULL,
  storage_object_id uuid NOT NULL,
  first_run_id uuid NOT NULL,
  last_seen_run_id uuid NOT NULL,
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (source_id, source_path_sha256, source_content_sha256),
  CONSTRAINT legacy_file_mappings_source_id_check CHECK (
    source_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$'
  ),
  CONSTRAINT legacy_file_mappings_path_hash_check CHECK (source_path_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT legacy_file_mappings_content_hash_check CHECK (source_content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT legacy_file_mappings_size_check CHECK (size_bytes > 0),
  CONSTRAINT legacy_file_mappings_media_type_check CHECK (
    media_type IN ('application/pdf', 'image/png')
  ),
  CONSTRAINT legacy_file_mappings_storage_object_fk FOREIGN KEY (storage_object_id)
    REFERENCES platform.storage_objects(id) ON DELETE RESTRICT,
  CONSTRAINT legacy_file_mappings_storage_object_unique UNIQUE (storage_object_id),
  CONSTRAINT legacy_file_mappings_first_run_fk FOREIGN KEY (first_run_id)
    REFERENCES platform.legacy_migration_runs(id) ON DELETE RESTRICT,
  CONSTRAINT legacy_file_mappings_last_seen_run_fk FOREIGN KEY (last_seen_run_id)
    REFERENCES platform.legacy_migration_runs(id) ON DELETE RESTRICT
);

CREATE INDEX legacy_file_mappings_last_seen_run_idx
  ON platform.legacy_file_mappings (last_seen_run_id, source_path_sha256);
CREATE INDEX legacy_file_mappings_first_run_id_idx
  ON platform.legacy_file_mappings (first_run_id);
CREATE INDEX legacy_file_mappings_source_path_verified_idx
  ON platform.legacy_file_mappings (source_id, source_path_sha256, verified_at DESC);

REVOKE ALL ON TABLE
  platform.legacy_migration_runs,
  platform.legacy_id_mappings,
  platform.legacy_file_mappings
FROM PUBLIC;
