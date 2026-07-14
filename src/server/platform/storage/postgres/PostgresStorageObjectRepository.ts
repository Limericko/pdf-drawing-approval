import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../database/queryExecutor.ts";
import type { StorageDriver } from "../storageAdapter.ts";
import { assertStorageKey } from "../storageKey.ts";
import {
  type ClaimStorageCleanupReap,
  type CreateStagingStorageObject,
  type CompleteStorageCleanup,
  type PrepareStorageCleanup,
  type ReadyStorageObjectContent,
  type ReleaseStorageCleanupReap,
  type ScheduleStorageCleanupReap,
  type StorageObject,
  type StorageObjectRepository,
  StorageObjectRepositoryError,
  type StorageObjectStatus
} from "../storageObjectRepository.ts";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SCAN_LIMIT = 1_000;

type StorageObjectRow = QueryResultRow & {
  id: string;
  status: StorageObjectStatus;
  driver: StorageDriver;
  object_key: string;
  size_bytes: string | number | null;
  sha256: Buffer | null;
  media_type: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  ready_at: Date | null;
  delete_requested_at: Date | null;
  deleted_at: Date | null;
  upload_expires_at: Date | null;
  cleanup_tombstone: boolean;
  cleanup_generation: string | number;
  cleanup_not_before: Date | null;
  cleanup_lease_owner: string | null;
  cleanup_lease_token: string | null;
  cleanup_lease_expires_at: Date | null;
};

type TransitionRow = StorageObjectRow & {
  outcome: "updated" | "missing" | "date_order" | "upload_expired" | "state_conflict";
};

const COLUMNS = `id, status, driver, object_key, size_bytes, sha256, media_type, last_error,
  created_at, updated_at, ready_at, delete_requested_at, deleted_at, upload_expires_at,
  cleanup_tombstone, cleanup_generation, cleanup_not_before,
  cleanup_lease_owner, cleanup_lease_token, cleanup_lease_expires_at`;
const NULL_TRANSITION_COLUMNS = `NULL::uuid AS id, NULL::text AS status, NULL::text AS driver,
  NULL::text AS object_key, NULL::bigint AS size_bytes, NULL::bytea AS sha256,
  NULL::text AS media_type, NULL::text AS last_error, NULL::timestamptz AS created_at,
  NULL::timestamptz AS updated_at, NULL::timestamptz AS ready_at,
  NULL::timestamptz AS delete_requested_at, NULL::timestamptz AS deleted_at,
  NULL::timestamptz AS upload_expires_at, NULL::boolean AS cleanup_tombstone,
  NULL::bigint AS cleanup_generation, NULL::timestamptz AS cleanup_not_before,
  NULL::text AS cleanup_lease_owner, NULL::uuid AS cleanup_lease_token,
  NULL::timestamptz AS cleanup_lease_expires_at`;

export class PostgresStorageObjectRepository implements StorageObjectRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async createStaging(input: CreateStagingStorageObject) {
    assertId(input.id);
    assertDriver(input.driver);
    const parsed = assertStorageKey(input.objectKey);
    if (parsed.id !== input.id) throw invalidContent();
    const createdAt = ownDate(input.createdAt);
    const uploadExpiresAt = ownDate(input.uploadExpiresAt);
    if (uploadExpiresAt.getTime() <= createdAt.getTime()) throw invalidContent();
    const result = await this.executor.query<StorageObjectRow>(
      `INSERT INTO platform.storage_objects (id, status, driver, object_key, created_at, updated_at, upload_expires_at)
       VALUES ($1, 'staging', $2, $3, $4, $4, $5)
       RETURNING ${COLUMNS}`,
      [input.id, input.driver, input.objectKey, createdAt, uploadExpiresAt]
    );
    return mapStorageObject(result.rows[0]!);
  }

  async findById(id: string) {
    assertId(id);
    const result = await this.executor.query<StorageObjectRow>(
      `SELECT ${COLUMNS} FROM platform.storage_objects WHERE id = $1`, [id]
    );
    return result.rows[0] ? mapStorageObject(result.rows[0]) : undefined;
  }

  async markReady(id: string, content: ReadyStorageObjectContent) {
    assertId(id);
    const owned = ownReadyContent(content);
    const result = await this.executor.query<TransitionRow>(
      `WITH existing AS MATERIALIZED (
         SELECT status, created_at AS prior_at, upload_expires_at
         FROM platform.storage_objects WHERE id = $1
       ), updated AS (
         UPDATE platform.storage_objects
         SET status = 'ready', size_bytes = $2, sha256 = $3, media_type = $4,
           ready_at = $5, updated_at = $5
         WHERE id = $1 AND status = 'staging' AND created_at <= $5 AND upload_expires_at > $5
         RETURNING ${COLUMNS}
       ), classified AS (
         SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM existing) THEN 'missing'
           WHEN EXISTS (
             SELECT 1 FROM existing WHERE status = 'staging' AND prior_at > $5
           ) THEN 'date_order'
           WHEN EXISTS (
             SELECT 1 FROM existing WHERE status = 'staging' AND upload_expires_at <= $5
           ) THEN 'upload_expired'
           ELSE 'state_conflict'
         END AS outcome
         WHERE NOT EXISTS (SELECT 1 FROM updated)
       )
       SELECT 'updated'::text AS outcome, ${COLUMNS} FROM updated
       UNION ALL
       SELECT outcome, ${NULL_TRANSITION_COLUMNS} FROM classified`,
      [id, owned.sizeBytes, owned.sha256, owned.mediaType, owned.readyAt]
    );
    return transitionResult(result.rows[0]!, "staging");
  }

  async markDeletePending(id: string, requestedAt: Date) {
    assertId(id);
    const ownedDate = ownDate(requestedAt);
    const result = await this.executor.query<TransitionRow>(
      `WITH existing AS MATERIALIZED (
         SELECT status, ready_at AS prior_at
         FROM platform.storage_objects WHERE id = $1
       ), updated AS (
         UPDATE platform.storage_objects
         SET status = 'delete_pending', delete_requested_at = $2, updated_at = $2
         WHERE id = $1 AND status = 'ready' AND ready_at <= $2
         RETURNING ${COLUMNS}
       ), classified AS (
         SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM existing) THEN 'missing'
           WHEN EXISTS (
             SELECT 1 FROM existing WHERE status = 'ready' AND prior_at > $2
           ) THEN 'date_order'
           ELSE 'state_conflict'
         END AS outcome
         WHERE NOT EXISTS (SELECT 1 FROM updated)
       )
       SELECT 'updated'::text AS outcome, ${COLUMNS} FROM updated
       UNION ALL
       SELECT outcome, ${NULL_TRANSITION_COLUMNS} FROM classified`,
      [id, ownedDate]
    );
    return transitionResult(result.rows[0]!, "ready");
  }

  async listStaleStaging(expiredAt: Date, limit: number) {
    const cutoff = ownDate(expiredAt);
    assertLimit(limit);
    const result = await this.executor.query<StorageObjectRow>(
      `SELECT ${COLUMNS} FROM platform.storage_objects
       WHERE status = 'staging' AND upload_expires_at <= $1
       ORDER BY upload_expires_at, id LIMIT $2`,
      [cutoff, limit]
    );
    return result.rows.map(mapStorageObject);
  }

  async listReadyOrphans(readyBefore: Date, limit: number) {
    const cutoff = ownDate(readyBefore);
    assertLimit(limit);
    const result = await this.executor.query<StorageObjectRow>(
      `SELECT ${COLUMNS.replaceAll(/\b(id|status|driver|object_key|size_bytes|sha256|media_type|last_error|created_at|updated_at|ready_at|delete_requested_at|deleted_at|upload_expires_at|cleanup_tombstone|cleanup_generation|cleanup_not_before|cleanup_lease_owner|cleanup_lease_token|cleanup_lease_expires_at)\b/g, "object.$1")}
       FROM platform.storage_objects object
       WHERE object.status='ready' AND object.ready_at <= $1
         AND NOT EXISTS (SELECT 1 FROM platform.drawing_revisions revision WHERE revision.original_object_id=object.id)
         AND NOT EXISTS (SELECT 1 FROM platform.signature_assets signature WHERE signature.object_id=object.id)
         AND NOT EXISTS (SELECT 1 FROM platform.render_artifacts artifact WHERE artifact.object_id=object.id)
         AND NOT EXISTS (SELECT 1 FROM platform.print_archive_events archive WHERE archive.object_id=object.id)
       ORDER BY object.ready_at,object.id LIMIT $2 FOR UPDATE OF object SKIP LOCKED`,
      [cutoff, limit]
    );
    return result.rows.map(mapStorageObject);
  }

  async listDeletePending(dueAt: Date, limit: number) {
    ownDate(dueAt);
    assertLimit(limit);
    const result = await this.executor.query<StorageObjectRow>(
       `SELECT ${COLUMNS} FROM platform.storage_objects
       WHERE status = 'delete_pending' AND cleanup_tombstone = false
       ORDER BY delete_requested_at, id LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapStorageObject);
  }

  async prepareCleanup(input: PrepareStorageCleanup) {
    const owned = ownCleanup(input);
    const result = owned.expectedStatus === "staging"
      ? await this.executor.query<StorageObjectRow>(
        `WITH transitioned AS (
           UPDATE platform.storage_objects
           SET status = 'delete_pending', delete_requested_at = $4, updated_at = $4,
             cleanup_tombstone = (driver = 's3'),
             cleanup_generation = 0,
             cleanup_not_before = CASE WHEN driver = 's3' THEN $4 ELSE NULL END
           WHERE id = $1 AND status = 'staging' AND driver = $2 AND object_key = $3
             AND created_at <= $4 AND upload_expires_at <= $4 AND $5 = 0
           RETURNING ${COLUMNS}
         )
         SELECT ${COLUMNS} FROM transitioned
         UNION ALL
         SELECT ${COLUMNS} FROM platform.storage_objects
         WHERE id = $1 AND status = 'delete_pending' AND driver = $2 AND object_key = $3
           AND cleanup_generation = $5
           AND NOT EXISTS (SELECT 1 FROM transitioned)
         LIMIT 1`,
        [owned.id, owned.driver, owned.objectKey, owned.requestedAt, owned.cleanupGeneration]
      )
      : await this.executor.query<StorageObjectRow>(
        `SELECT ${COLUMNS} FROM platform.storage_objects
         WHERE id = $1 AND status = 'delete_pending' AND driver = $2 AND object_key = $3
           AND cleanup_generation = $4
           AND (cleanup_tombstone = false OR cleanup_not_before <= $5)`,
        [owned.id, owned.driver, owned.objectKey, owned.cleanupGeneration, owned.requestedAt]
      );
    return result.rows[0] ? mapStorageObject(result.rows[0]) : undefined;
  }

  async completeCleanup(input: CompleteStorageCleanup) {
    const owned = ownCompleteCleanup(input);
    const result = await this.executor.query<StorageObjectRow>(
      `UPDATE platform.storage_objects
       SET status = 'deleted', deleted_at = $4, updated_at = $4
       WHERE id = $1 AND status = 'delete_pending' AND driver = $2 AND object_key = $3
         AND cleanup_tombstone = false AND cleanup_generation = $5
         AND delete_requested_at <= $4
       RETURNING ${COLUMNS}`,
      [owned.id, owned.driver, owned.objectKey, owned.deletedAt, owned.expectedGeneration]
    );
    return result.rows[0] ? mapStorageObject(result.rows[0]) : undefined;
  }

  async claimCleanupReap(input: ClaimStorageCleanupReap) {
    const owned = ownClaimCleanupReap(input);
    const leaseToken = randomUUID();
    const leaseExpiresAt = addMilliseconds(owned.now, owned.leaseDurationMs);
    const result = await this.executor.query<StorageObjectRow>(
      `WITH candidate AS MATERIALIZED (
         SELECT id AS candidate_id FROM platform.storage_objects
         WHERE status = 'delete_pending' AND cleanup_tombstone = true
           AND cleanup_not_before <= $2
           AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at <= $2)
           AND ($5::uuid IS NULL OR id = $5)
         ORDER BY cleanup_not_before, delete_requested_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE platform.storage_objects object
       SET cleanup_generation = object.cleanup_generation + 1,
         cleanup_lease_owner = $1, cleanup_lease_token = $3,
         cleanup_lease_expires_at = $4, updated_at = $2
       FROM candidate
       WHERE object.id = candidate.candidate_id
       RETURNING ${COLUMNS}`,
      [owned.workerId, owned.now, leaseToken, leaseExpiresAt, owned.id ?? null]
    );
    return result.rows[0] ? mapStorageObject(result.rows[0]) : null;
  }

  async scheduleCleanupReap(input: ScheduleStorageCleanupReap) {
    const owned = ownScheduleCleanupReap(input);
    const result = await this.executor.query<StorageObjectRow>(
      `UPDATE platform.storage_objects
       SET cleanup_not_before = $7, last_error = $8, updated_at = $6,
         cleanup_lease_owner = NULL, cleanup_lease_token = NULL, cleanup_lease_expires_at = NULL
       WHERE id = $1 AND status = 'delete_pending' AND driver = $2 AND object_key = $3
         AND cleanup_tombstone = true AND cleanup_generation = $5
         AND cleanup_lease_owner = $4 AND cleanup_lease_token = $9
         AND cleanup_lease_expires_at > $6
         AND delete_requested_at <= $6 AND $7 > $6
       RETURNING ${COLUMNS}`,
      [owned.id, owned.driver, owned.objectKey, owned.workerId, owned.expectedGeneration,
        owned.scheduledAt, owned.nextCleanupAt, owned.lastError, owned.leaseToken]
    );
    return result.rows[0] ? mapStorageObject(result.rows[0]) : undefined;
  }

  async releaseCleanupReap(input: ReleaseStorageCleanupReap) {
    const owned = ownReleaseCleanupReap(input);
    const result = await this.executor.query<StorageObjectRow>(
      `UPDATE platform.storage_objects
       SET cleanup_lease_owner = NULL, cleanup_lease_token = NULL,
         cleanup_lease_expires_at = NULL, updated_at = $5
       WHERE id = $1 AND status = 'delete_pending' AND cleanup_tombstone = true
         AND cleanup_lease_owner = $2 AND cleanup_lease_token = $3
         AND cleanup_generation = $4 AND updated_at <= $5
       RETURNING ${COLUMNS}`,
      [owned.id, owned.workerId, owned.leaseToken, owned.expectedGeneration, owned.releasedAt]
    );
    return result.rows[0] ? mapStorageObject(result.rows[0]) : undefined;
  }

}

function ownCleanup(input: PrepareStorageCleanup) {
  if (!input || typeof input !== "object") throw invalidContent();
  assertId(input.id);
  assertDriver(input.driver);
  const key = assertStorageKey(input.objectKey);
  if (key.id !== input.id || (input.expectedStatus !== "staging" && input.expectedStatus !== "delete_pending")) throw invalidContent();
  return {
    id: input.id,
    expectedStatus: input.expectedStatus,
    driver: input.driver,
    objectKey: input.objectKey,
    requestedAt: ownDate(input.requestedAt),
    cleanupGeneration: ownGeneration(input.cleanupGeneration)
  };
}

function ownCompleteCleanup(input: CompleteStorageCleanup) {
  if (!input || typeof input !== "object") throw invalidContent();
  assertId(input.id);
  assertDriver(input.driver);
  const key = assertStorageKey(input.objectKey);
  if (key.id !== input.id) throw invalidContent();
  return {
    id: input.id,
    driver: input.driver,
    objectKey: input.objectKey,
    deletedAt: ownDate(input.deletedAt),
    expectedGeneration: ownGeneration(input.expectedGeneration)
  };
}

function ownScheduleCleanupReap(input: ScheduleStorageCleanupReap) {
  if (!input || typeof input !== "object") throw invalidContent();
  assertId(input.id);
  assertDriver(input.driver);
  const key = assertStorageKey(input.objectKey);
  const scheduledAt = ownDate(input.scheduledAt);
  const nextCleanupAt = ownDate(input.nextCleanupAt);
  assertWorkerId(input.workerId);
  assertLeaseToken(input.leaseToken);
  if (key.id !== input.id || input.driver !== "s3" || nextCleanupAt.getTime() <= scheduledAt.getTime() ||
      (input.lastError !== null && (typeof input.lastError !== "string" || !input.lastError || input.lastError !== input.lastError.trim() ||
        input.lastError.length > 2_000 || /[\u0000-\u001f\u007f]/.test(input.lastError)))) {
    throw invalidContent();
  }
  return {
    id: input.id,
    driver: input.driver,
    objectKey: input.objectKey,
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    expectedGeneration: ownGeneration(input.expectedGeneration),
    scheduledAt,
    nextCleanupAt,
    lastError: input.lastError
  };
}

function ownClaimCleanupReap(input: ClaimStorageCleanupReap) {
  if (!input || typeof input !== "object") throw invalidContent();
  assertWorkerId(input.workerId);
  if (input.id !== undefined) assertId(input.id);
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1 || input.leaseDurationMs > 3_600_000) throw invalidContent();
  return { workerId: input.workerId, now: ownDate(input.now), leaseDurationMs: input.leaseDurationMs, id: input.id };
}

function ownReleaseCleanupReap(input: ReleaseStorageCleanupReap) {
  if (!input || typeof input !== "object") throw invalidContent();
  assertId(input.id);
  assertWorkerId(input.workerId);
  assertLeaseToken(input.leaseToken);
  return {
    id: input.id,
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    expectedGeneration: ownGeneration(input.expectedGeneration),
    releasedAt: ownDate(input.releasedAt)
  };
}

function transitionResult(row: TransitionRow, expectedStatus: StorageObjectStatus): StorageObject {
  if (row.outcome === "updated") return mapStorageObject(row);
  if (row.outcome === "missing") {
    throw new StorageObjectRepositoryError("STORAGE_OBJECT_NOT_FOUND", "Storage object metadata was not found");
  }
  if (row.outcome === "date_order") {
    throw new StorageObjectRepositoryError(
      "INVALID_STORAGE_OBJECT_DATE_ORDER",
      "Storage object lifecycle timestamp is before the prior transition"
    );
  }
  if (row.outcome === "upload_expired") {
    throw new StorageObjectRepositoryError("STORAGE_OBJECT_UPLOAD_EXPIRED", "Storage upload deadline has expired");
  }
  throw new StorageObjectRepositoryError(
    "STORAGE_OBJECT_STATE_CONFLICT",
    `Storage object is not in expected ${expectedStatus} state`
  );
}

function mapStorageObject(row: StorageObjectRow): StorageObject {
  return {
    id: row.id,
    status: row.status,
    driver: row.driver,
    objectKey: row.object_key,
    sizeBytes: mapSize(row.size_bytes),
    sha256: row.sha256 === null ? null : Buffer.from(row.sha256),
    mediaType: row.media_type,
    lastError: row.last_error,
    createdAt: cloneDate(row.created_at),
    updatedAt: cloneDate(row.updated_at),
    readyAt: row.ready_at === null ? null : cloneDate(row.ready_at),
    deleteRequestedAt: row.delete_requested_at === null ? null : cloneDate(row.delete_requested_at),
    deletedAt: row.deleted_at === null ? null : cloneDate(row.deleted_at),
    uploadExpiresAt: row.upload_expires_at === null ? null : cloneDate(row.upload_expires_at),
    cleanupTombstone: row.cleanup_tombstone,
    cleanupGeneration: mapGeneration(row.cleanup_generation),
    cleanupNotBefore: row.cleanup_not_before === null ? null : cloneDate(row.cleanup_not_before),
    cleanupLeaseOwner: row.cleanup_lease_owner,
    cleanupLeaseToken: row.cleanup_lease_token,
    cleanupLeaseExpiresAt: row.cleanup_lease_expires_at === null ? null : cloneDate(row.cleanup_lease_expires_at)
  };
}

function addMilliseconds(date: Date, milliseconds: number) {
  const value = date.getTime() + milliseconds;
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw invalidContent();
  return new Date(value);
}

function assertWorkerId(value: string) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) throw invalidContent();
}

function assertLeaseToken(value: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw invalidContent();
}

function mapGeneration(value: string | number) {
  const generation = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) throw invalidContent();
  return generation;
}

function ownGeneration(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidContent();
  return value;
}

function mapSize(value: string | number | null) {
  if (value === null) return null;
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new StorageObjectRepositoryError("STORAGE_OBJECT_SIZE_OUT_OF_RANGE", "Storage object size is outside the safe integer range");
  }
  return size;
}

function ownReadyContent(content: ReadyStorageObjectContent): ReadyStorageObjectContent {
  if (!Number.isSafeInteger(content.sizeBytes) || content.sizeBytes < 0 || !Buffer.isBuffer(content.sha256) || content.sha256.length !== 32) {
    throw invalidContent();
  }
  if (
    typeof content.mediaType !== "string" ||
    !content.mediaType ||
    content.mediaType !== content.mediaType.trim() ||
    content.mediaType.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(content.mediaType)
  ) {
    throw invalidContent();
  }
  return {
    sizeBytes: content.sizeBytes,
    sha256: Buffer.from(content.sha256),
    mediaType: content.mediaType,
    readyAt: ownDate(content.readyAt)
  };
}

function assertId(id: string) {
  if (typeof id !== "string" || !UUID_V7_PATTERN.test(id)) {
    throw new StorageObjectRepositoryError("INVALID_STORAGE_OBJECT_ID", "Invalid storage object identifier");
  }
}

function assertDriver(driver: StorageDriver) {
  if (driver !== "filesystem" && driver !== "s3") {
    throw new StorageObjectRepositoryError("INVALID_STORAGE_OBJECT_DRIVER", "Invalid storage object driver");
  }
}

function assertLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT) {
    throw new StorageObjectRepositoryError("INVALID_STORAGE_OBJECT_LIMIT", "Invalid storage object scan limit");
  }
}

function ownDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new StorageObjectRepositoryError("INVALID_STORAGE_OBJECT_DATE", "Invalid storage object date");
  }
  return new Date(value.getTime());
}

function cloneDate(value: Date) {
  return new Date(value.getTime());
}

function invalidContent() {
  return new StorageObjectRepositoryError("INVALID_STORAGE_OBJECT_CONTENT", "Invalid storage object content metadata");
}
