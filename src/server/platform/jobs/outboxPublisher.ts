import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import type { CleanupIntent, CleanupIntentPublisher } from "../storage/cleanupIntentPublisher.ts";
import { assertStorageKey } from "../storage/storageKey.ts";
import {
  cloneJsonObject,
  type OutboxEvent,
  OutboxRepositoryError,
  type PublishOutboxEvent
} from "./jobTypes.ts";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type PublisherOptions = {
  readonly createId: () => string;
  readonly clock: () => Date;
};

type PublishedRow = QueryResultRow & {
  id: string;
  event_type: string;
  payload_version: number;
  payload: unknown;
  created_at: Date;
  dispatched_at: Date | null;
};

const PUBLISHED_COLUMNS = "id, event_type, payload_version, payload, created_at, dispatched_at";

export interface OutboxPublisher {
  publish(executor: QueryExecutor, event: PublishOutboxEvent): Promise<OutboxEvent>;
  publishIdempotent(executor: QueryExecutor, event: PublishOutboxEvent, idempotencyKey: string): Promise<OutboxEvent>;
}

export class PostgresOutboxPublisher implements OutboxPublisher {
  constructor(private readonly options: PublisherOptions) {}

  async publish(executor: QueryExecutor, event: PublishOutboxEvent): Promise<OutboxEvent> {
    if (!executor || typeof executor.query !== "function") throw invalidEvent();
    const owned = ownEvent(event);
    const id = this.options.createId();
    assertOutboxId(id);
    const createdAt = ownDate(this.options.clock());
    const result = await executor.query<PublishedRow>(
      `INSERT INTO platform.outbox_events (id, event_type, payload_version, payload, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PUBLISHED_COLUMNS}`,
      [id, owned.eventType, owned.payloadVersion, owned.payload, createdAt]
    );
    if (result.rows.length !== 1 || result.rows[0]?.id !== id) {
      throw new OutboxRepositoryError("INVALID_OUTBOX_ROW", "Outbox insert returned an invalid row");
    }
    return mapPublishedEvent(result.rows[0]);
  }

  async publishIdempotent(executor: QueryExecutor, event: PublishOutboxEvent, idempotencyKey: string): Promise<OutboxEvent> {
    if (!executor || typeof executor.query !== "function") throw invalidEvent();
    const owned = ownEvent(event);
    const ownedKey = ownIdempotencyKey(idempotencyKey);
    const id = this.options.createId();
    assertOutboxId(id);
    const createdAt = ownDate(this.options.clock());
    const inserted = await executor.query<PublishedRow>(
      `INSERT INTO platform.outbox_events
         (id, event_type, payload_version, payload, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING ${PUBLISHED_COLUMNS}`,
      [id, owned.eventType, owned.payloadVersion, owned.payload, ownedKey, createdAt]
    );
    if (inserted.rows[0]) return mapPublishedEvent(inserted.rows[0]);

    const winner = await executor.query<PublishedRow>(
      `SELECT ${PUBLISHED_COLUMNS} FROM platform.outbox_events WHERE idempotency_key = $1`,
      [ownedKey]
    );
    const row = winner.rows[0];
    if (!row) throw new OutboxRepositoryError("INVALID_OUTBOX_ROW", "Idempotent outbox insert returned no winner");
    const existing = mapPublishedEvent(row);
    if (existing.eventType !== owned.eventType || existing.payloadVersion !== owned.payloadVersion || !sameJsonValue(existing.payload, owned.payload)) {
      throw new OutboxRepositoryError("OUTBOX_IDEMPOTENCY_CONFLICT", "Outbox idempotency key belongs to different content");
    }
    return existing;
  }
}

export class CleanupIntentOutboxPublisher implements CleanupIntentPublisher {
  constructor(private readonly publisher: OutboxPublisher) {}

  async publish(executor: QueryExecutor, intent: CleanupIntent): Promise<void> {
    const idempotencyKey = intent?.idempotencyKey;
    const payload = ownCleanupIntent(intent);
    await this.publisher.publishIdempotent(executor, {
      eventType: "storage_object_cleanup",
      payloadVersion: 1,
      payload
    }, idempotencyKey!);
  }
}

function ownEvent(event: PublishOutboxEvent): PublishOutboxEvent {
  if (!event || typeof event !== "object") throw invalidEvent();
  assertName(event.eventType);
  assertPositiveInteger(event.payloadVersion);
  return Object.freeze({
    eventType: event.eventType,
    payloadVersion: event.payloadVersion,
    payload: cloneJsonObject(event.payload, invalidEvent)
  });
}

function ownIdempotencyKey(value: string) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw invalidEvent();
  return value;
}

function mapPublishedEvent(row: PublishedRow): OutboxEvent {
  assertOutboxId(row.id);
  assertName(row.event_type);
  assertPositiveInteger(row.payload_version);
  const createdAt = ownRowDate(row.created_at);
  const dispatchedAt = row.dispatched_at === null ? null : ownRowDate(row.dispatched_at);
  return Object.freeze({
    id: row.id,
    eventType: row.event_type,
    payloadVersion: row.payload_version,
    payload: cloneJsonObject(row.payload, invalidRow),
    createdAt,
    dispatchedAt
  });
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  return leftKeys.length === Object.keys(rightRecord).length && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]));
}

function ownCleanupIntent(intent: CleanupIntent) {
  if (
    !intent || intent.type !== "storage_object_cleanup" || intent.payloadVersion !== 1 ||
    typeof intent.idempotencyKey !== "string" || !intent.idempotencyKey ||
    typeof intent.storageObjectId !== "string" || !UUID_V7_PATTERN.test(intent.storageObjectId) ||
    typeof intent.objectKey !== "string" ||
    !["staging", "delete_pending"].includes(intent.expectedStatus) ||
    !["filesystem", "s3"].includes(intent.driver)
  ) throw invalidEvent();
  const hasGeneration = intent.cleanupGeneration !== undefined;
  if (hasGeneration && (intent.expectedStatus !== "delete_pending" ||
      !Number.isSafeInteger(intent.cleanupGeneration) || intent.cleanupGeneration! < 0)) throw invalidEvent();
  const expectedIdempotencyKey = `storage-object-cleanup:${intent.storageObjectId}:${intent.expectedStatus}${hasGeneration ? `:${intent.cleanupGeneration}` : ""}`;
  if (intent.idempotencyKey !== expectedIdempotencyKey) throw invalidEvent();
  try {
    if (assertStorageKey(intent.objectKey).id !== intent.storageObjectId) throw invalidEvent();
  } catch {
    throw invalidEvent();
  }
  return cloneJsonObject({
    idempotencyKey: intent.idempotencyKey,
    storageObjectId: intent.storageObjectId,
    expectedStatus: intent.expectedStatus,
    driver: intent.driver,
    objectKey: intent.objectKey,
    ...(hasGeneration ? { cleanupGeneration: intent.cleanupGeneration } : {})
  }, invalidEvent);
}

function assertOutboxId(value: string) {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) {
    throw new OutboxRepositoryError("INVALID_OUTBOX_ID", "Invalid outbox event identifier");
  }
}

function assertName(value: string) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalidEvent();
  }
}

function assertPositiveInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidEvent();
}

function ownDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new OutboxRepositoryError("INVALID_OUTBOX_DATE", "Invalid outbox event date");
  }
  return new Date(value.getTime());
}

function ownRowDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalidRow();
  return new Date(value.getTime());
}

function invalidRow() {
  return new OutboxRepositoryError("INVALID_OUTBOX_ROW", "Invalid outbox row");
}

function invalidEvent() {
  return new OutboxRepositoryError("INVALID_OUTBOX_EVENT", "Invalid outbox event");
}
