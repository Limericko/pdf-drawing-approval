CREATE TABLE platform.storage_objects (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  driver text NOT NULL,
  object_key text NOT NULL,
  size_bytes bigint,
  sha256 bytea,
  media_type text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz,
  delete_requested_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT storage_objects_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT storage_objects_driver_key_unique UNIQUE (driver, object_key),
  CONSTRAINT storage_objects_status_check CHECK (
    status IN ('staging', 'ready', 'delete_pending', 'deleted', 'failed')
  ),
  CONSTRAINT storage_objects_driver_check CHECK (driver IN ('filesystem', 's3')),
  CONSTRAINT storage_objects_object_key_check CHECK (btrim(object_key) <> ''),
  CONSTRAINT storage_objects_size_check CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT storage_objects_sha256_check CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  CONSTRAINT storage_objects_ready_content_check CHECK (
    status <> 'ready' OR (size_bytes IS NOT NULL AND sha256 IS NOT NULL)
  ),
  CONSTRAINT storage_objects_updated_at_check CHECK (updated_at >= created_at),
  CONSTRAINT storage_objects_ready_at_check CHECK (ready_at IS NULL OR ready_at >= created_at),
  CONSTRAINT storage_objects_delete_requested_at_check CHECK (
    delete_requested_at IS NULL OR delete_requested_at >= created_at
  ),
  CONSTRAINT storage_objects_deleted_at_check CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CONSTRAINT storage_objects_ready_state_check CHECK (
    status <> 'ready' OR ready_at IS NOT NULL
  ),
  CONSTRAINT storage_objects_delete_pending_state_check CHECK (
    status <> 'delete_pending' OR delete_requested_at IS NOT NULL
  ),
  CONSTRAINT storage_objects_deleted_state_check CHECK (
    status <> 'deleted' OR (delete_requested_at IS NOT NULL AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT storage_objects_ready_lifecycle_check CHECK (
    ready_at IS NULL OR status IN ('ready', 'delete_pending', 'deleted')
  ),
  CONSTRAINT storage_objects_delete_lifecycle_check CHECK (
    delete_requested_at IS NULL OR status IN ('delete_pending', 'deleted')
  ),
  CONSTRAINT storage_objects_deleted_lifecycle_check CHECK (
    deleted_at IS NULL OR status = 'deleted'
  )
);

CREATE INDEX storage_objects_staging_idx ON platform.storage_objects (created_at, id)
  WHERE status = 'staging';
CREATE INDEX storage_objects_delete_pending_idx ON platform.storage_objects (delete_requested_at, id)
  WHERE status = 'delete_pending';

CREATE TABLE platform.outbox_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  payload_version integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  CONSTRAINT outbox_events_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT outbox_events_event_type_check CHECK (btrim(event_type) <> ''),
  CONSTRAINT outbox_events_payload_version_check CHECK (payload_version > 0),
  CONSTRAINT outbox_events_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_events_dispatched_at_check CHECK (dispatched_at IS NULL OR dispatched_at >= created_at)
);

CREATE INDEX outbox_events_undispatched_idx ON platform.outbox_events (created_at, id)
  WHERE dispatched_at IS NULL;

CREATE TABLE platform.jobs (
  id uuid PRIMARY KEY,
  job_type text NOT NULL,
  payload_version integer NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL,
  max_attempts integer NOT NULL,
  next_run_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  lease_token uuid,
  worker_id text,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT jobs_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT jobs_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT jobs_job_type_check CHECK (btrim(job_type) <> ''),
  CONSTRAINT jobs_payload_version_check CHECK (payload_version > 0),
  CONSTRAINT jobs_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT jobs_idempotency_key_check CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT jobs_status_check CHECK (status IN ('pending', 'running', 'succeeded', 'dead')),
  CONSTRAINT jobs_attempts_check CHECK (
    attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts
  ),
  CONSTRAINT jobs_lease_state_check CHECK (
    (status = 'running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_token IS NOT NULL)
    OR (status <> 'running' AND worker_id IS NULL AND lease_expires_at IS NULL AND lease_token IS NULL)
  ),
  CONSTRAINT jobs_worker_id_check CHECK (worker_id IS NULL OR btrim(worker_id) <> ''),
  CONSTRAINT jobs_updated_at_check CHECK (updated_at >= created_at),
  CONSTRAINT jobs_started_at_check CHECK (started_at IS NULL OR started_at >= created_at),
  CONSTRAINT jobs_completed_at_check CHECK (
    completed_at IS NULL OR (completed_at >= created_at AND status IN ('succeeded', 'dead'))
  )
);

CREATE INDEX jobs_pending_idx ON platform.jobs (next_run_at, created_at, id)
  WHERE status = 'pending';
CREATE INDEX jobs_running_lease_idx ON platform.jobs (lease_expires_at, next_run_at, created_at, id)
  WHERE status = 'running';
CREATE INDEX jobs_dead_idx ON platform.jobs (updated_at, id)
  WHERE status = 'dead';

CREATE TABLE platform.worker_heartbeats (
  worker_id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT worker_heartbeats_worker_id_check CHECK (btrim(worker_id) <> ''),
  CONSTRAINT worker_heartbeats_time_check CHECK (heartbeat_at >= started_at),
  CONSTRAINT worker_heartbeats_metadata_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX worker_heartbeats_heartbeat_at_idx ON platform.worker_heartbeats (heartbeat_at);

REVOKE ALL ON TABLE
  platform.storage_objects,
  platform.outbox_events,
  platform.jobs,
  platform.worker_heartbeats
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON TABLE platform.storage_objects TO platform_web;
GRANT SELECT, INSERT ON TABLE platform.outbox_events, platform.jobs TO platform_web;

GRANT SELECT ON TABLE platform.storage_objects, platform.outbox_events TO platform_worker;
GRANT UPDATE (status, last_error, updated_at, delete_requested_at, deleted_at)
  ON TABLE platform.storage_objects TO platform_worker;
GRANT UPDATE (dispatched_at) ON TABLE platform.outbox_events TO platform_worker;
GRANT SELECT, INSERT ON TABLE platform.jobs, platform.worker_heartbeats TO platform_worker;
GRANT UPDATE (
  status,
  attempt_count,
  next_run_at,
  lease_expires_at,
  lease_token,
  worker_id,
  last_error_code,
  last_error_message,
  updated_at,
  started_at,
  completed_at
) ON TABLE platform.jobs TO platform_worker;
GRANT UPDATE (heartbeat_at, metadata) ON TABLE platform.worker_heartbeats TO platform_worker;
