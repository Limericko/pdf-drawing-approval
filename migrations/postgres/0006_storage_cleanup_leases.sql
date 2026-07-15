ALTER TABLE platform.storage_objects
  ADD COLUMN cleanup_lease_owner text,
  ADD COLUMN cleanup_lease_token uuid,
  ADD COLUMN cleanup_lease_expires_at timestamptz;

ALTER TABLE platform.storage_objects
  ADD CONSTRAINT storage_objects_cleanup_lease_check CHECK (
    (
      cleanup_lease_owner IS NULL
      AND cleanup_lease_token IS NULL
      AND cleanup_lease_expires_at IS NULL
    ) OR (
      cleanup_tombstone = true
      AND status = 'delete_pending'
      AND cleanup_lease_owner IS NOT NULL
      AND cleanup_lease_owner = btrim(cleanup_lease_owner)
      AND cleanup_lease_owner <> ''
      AND length(cleanup_lease_owner) <= 255
      AND cleanup_lease_owner !~ '[[:cntrl:]]'
      AND cleanup_lease_token IS NOT NULL
      AND cleanup_lease_expires_at IS NOT NULL
    )
  );

CREATE INDEX storage_objects_cleanup_claim_idx
  ON platform.storage_objects (cleanup_not_before, cleanup_lease_expires_at, delete_requested_at, id)
  WHERE status = 'delete_pending' AND cleanup_tombstone = true;

GRANT UPDATE (cleanup_generation, cleanup_lease_owner, cleanup_lease_token, cleanup_lease_expires_at,
  cleanup_not_before, last_error, updated_at)
  ON TABLE platform.storage_objects TO platform_worker;
