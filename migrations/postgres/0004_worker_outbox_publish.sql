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
