ALTER TABLE platform.outbox_events
  ADD COLUMN idempotency_key text,
  ADD CONSTRAINT outbox_events_idempotency_key_check CHECK (
    idempotency_key IS NULL OR (
      idempotency_key = btrim(idempotency_key)
      AND idempotency_key <> ''
      AND length(idempotency_key) <= 512
      AND idempotency_key !~ '[[:cntrl:]]'
    )
  );

CREATE UNIQUE INDEX outbox_events_idempotency_key_uidx
  ON platform.outbox_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

GRANT INSERT (id, event_type, payload_version, payload, idempotency_key, created_at)
  ON TABLE platform.outbox_events TO platform_worker;

ALTER TABLE platform.storage_objects ADD COLUMN upload_expires_at timestamptz;
UPDATE platform.storage_objects
SET upload_expires_at = created_at + interval '24 hours'
WHERE status = 'staging';
ALTER TABLE platform.storage_objects
  ADD CONSTRAINT storage_objects_upload_expiry_check CHECK (
    upload_expires_at IS NULL OR upload_expires_at >= created_at
  ),
  ADD CONSTRAINT storage_objects_staging_upload_expiry_check CHECK (
    status <> 'staging' OR upload_expires_at IS NOT NULL
  ),
  ADD CONSTRAINT storage_objects_ready_before_upload_expiry_check CHECK (
    ready_at IS NULL OR upload_expires_at IS NULL OR ready_at < upload_expires_at
  );

CREATE INDEX storage_objects_staging_upload_expiry_idx
  ON platform.storage_objects (upload_expires_at, id)
  WHERE status = 'staging';
