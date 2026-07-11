import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../database/queryExecutor.ts";
import type { StorageDriver } from "../storageAdapter.ts";
import { assertStorageKey } from "../storageKey.ts";
import {
  type CreateStagingStorageObject,
  type ReadyStorageObjectContent,
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
};

const COLUMNS = `id, status, driver, object_key, size_bytes, sha256, media_type, last_error,
  created_at, updated_at, ready_at, delete_requested_at, deleted_at`;

export class PostgresStorageObjectRepository implements StorageObjectRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async createStaging(input: CreateStagingStorageObject) {
    assertId(input.id);
    assertDriver(input.driver);
    const parsed = assertStorageKey(input.objectKey);
    if (parsed.id !== input.id) throw invalidContent();
    const createdAt = ownDate(input.createdAt);
    const result = await this.executor.query<StorageObjectRow>(
      `INSERT INTO platform.storage_objects (id, status, driver, object_key, created_at, updated_at)
       VALUES ($1, 'staging', $2, $3, $4, $4)
       RETURNING ${COLUMNS}`,
      [input.id, input.driver, input.objectKey, createdAt]
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
    const result = await this.executor.query<StorageObjectRow>(
      `UPDATE platform.storage_objects
       SET status = 'ready', size_bytes = $2, sha256 = $3, media_type = $4,
         ready_at = $5, updated_at = $5
       WHERE id = $1 AND status = 'staging' AND created_at <= $5
       RETURNING ${COLUMNS}`,
      [id, owned.sizeBytes, owned.sha256, owned.mediaType, owned.readyAt]
    );
    if (result.rows[0]) return mapStorageObject(result.rows[0]);
    return this.throwTransitionFailure(id, "staging", owned.readyAt, "created_at");
  }

  async markDeletePending(id: string, requestedAt: Date) {
    assertId(id);
    const ownedDate = ownDate(requestedAt);
    const result = await this.executor.query<StorageObjectRow>(
      `UPDATE platform.storage_objects
       SET status = 'delete_pending', delete_requested_at = $2, updated_at = $2
       WHERE id = $1 AND status = 'ready' AND ready_at <= $2
       RETURNING ${COLUMNS}`,
      [id, ownedDate]
    );
    if (result.rows[0]) return mapStorageObject(result.rows[0]);
    return this.throwTransitionFailure(id, "ready", ownedDate, "ready_at");
  }

  async listStaleStaging(createdBefore: Date, limit: number) {
    const cutoff = ownDate(createdBefore);
    assertLimit(limit);
    const result = await this.executor.query<StorageObjectRow>(
      `SELECT ${COLUMNS} FROM platform.storage_objects
       WHERE status = 'staging' AND created_at < $1
       ORDER BY created_at, id LIMIT $2`,
      [cutoff, limit]
    );
    return result.rows.map(mapStorageObject);
  }

  async listDeletePending(limit: number) {
    assertLimit(limit);
    const result = await this.executor.query<StorageObjectRow>(
      `SELECT ${COLUMNS} FROM platform.storage_objects
       WHERE status = 'delete_pending'
       ORDER BY delete_requested_at, id LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapStorageObject);
  }

  private async throwTransitionFailure(
    id: string,
    expectedStatus: StorageObjectStatus,
    attemptedAt: Date,
    priorTimestamp: "created_at" | "ready_at"
  ): Promise<never> {
    const existing = await this.executor.query<{ status: StorageObjectStatus; prior_at: Date | null }>(
      `SELECT status, ${priorTimestamp} AS prior_at FROM platform.storage_objects WHERE id = $1`, [id]
    );
    if (!existing.rows[0]) {
      throw new StorageObjectRepositoryError("STORAGE_OBJECT_NOT_FOUND", "Storage object metadata was not found");
    }
    if (
      existing.rows[0].status === expectedStatus &&
      existing.rows[0].prior_at !== null &&
      attemptedAt.getTime() < existing.rows[0].prior_at.getTime()
    ) {
      throw new StorageObjectRepositoryError(
        "INVALID_STORAGE_OBJECT_DATE_ORDER",
        "Storage object lifecycle timestamp is before the prior transition"
      );
    }
    throw new StorageObjectRepositoryError(
      "STORAGE_OBJECT_STATE_CONFLICT",
      `Storage object is not in expected ${expectedStatus} state`
    );
  }
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
    deletedAt: row.deleted_at === null ? null : cloneDate(row.deleted_at)
  };
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
  if (typeof content.mediaType !== "string" || !content.mediaType.trim() || content.mediaType.length > 255) {
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
