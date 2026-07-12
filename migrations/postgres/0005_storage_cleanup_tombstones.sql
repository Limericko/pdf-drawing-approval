ALTER TABLE platform.storage_objects
  ADD COLUMN cleanup_tombstone boolean NOT NULL DEFAULT false,
  ADD COLUMN cleanup_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN cleanup_not_before timestamptz;

-- Rows deleted by the pre-tombstone S3 staging cleanup are intentionally restored to a
-- retryable tombstone. A canceled single PUT has an ambiguous remote outcome, so these
-- rows remain durable cleanup ownership rather than claiming terminal deletion.
UPDATE platform.storage_objects
SET status = 'delete_pending',
  delete_requested_at = COALESCE(delete_requested_at, updated_at),
  deleted_at = NULL,
  cleanup_tombstone = true,
  cleanup_generation = 0,
  cleanup_not_before = GREATEST(updated_at, upload_expires_at)
WHERE driver = 's3'
  AND ready_at IS NULL
  AND upload_expires_at IS NOT NULL
  AND status IN ('delete_pending', 'deleted');

ALTER TABLE platform.storage_objects
  ADD CONSTRAINT storage_objects_cleanup_generation_check CHECK (
    cleanup_generation >= 0
  ),
  ADD CONSTRAINT storage_objects_cleanup_tombstone_check CHECK (
    (
      cleanup_tombstone = false
      AND cleanup_generation = 0
      AND cleanup_not_before IS NULL
    ) OR (
      cleanup_tombstone = true
      AND status = 'delete_pending'
      AND driver = 's3'
      AND ready_at IS NULL
      AND deleted_at IS NULL
      AND cleanup_not_before IS NOT NULL
    )
  );

CREATE INDEX storage_objects_cleanup_due_idx
  ON platform.storage_objects (cleanup_not_before, delete_requested_at, id)
  WHERE status = 'delete_pending';

GRANT UPDATE (cleanup_tombstone, cleanup_generation, cleanup_not_before)
  ON TABLE platform.storage_objects TO platform_worker;
