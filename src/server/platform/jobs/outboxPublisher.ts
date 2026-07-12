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

type PublishedRow = QueryResultRow & { id: string };

export interface OutboxPublisher {
  publish(executor: QueryExecutor, event: PublishOutboxEvent): Promise<OutboxEvent>;
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
       RETURNING id`,
      [id, owned.eventType, owned.payloadVersion, owned.payload, createdAt]
    );
    if (result.rows.length !== 1 || result.rows[0]?.id !== id) {
      throw new OutboxRepositoryError("INVALID_OUTBOX_ROW", "Outbox insert returned an invalid row");
    }
    return Object.freeze({ ...owned, id, createdAt: new Date(createdAt.getTime()), dispatchedAt: null });
  }
}

export class CleanupIntentOutboxPublisher implements CleanupIntentPublisher {
  constructor(private readonly publisher: OutboxPublisher) {}

  async publish(executor: QueryExecutor, intent: CleanupIntent): Promise<void> {
    const payload = ownCleanupIntent(intent);
    await this.publisher.publish(executor, {
      eventType: "storage_object_cleanup",
      payloadVersion: 1,
      payload
    });
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

function ownCleanupIntent(intent: CleanupIntent) {
  if (
    !intent || intent.type !== "storage_object_cleanup" || intent.payloadVersion !== 1 ||
    typeof intent.idempotencyKey !== "string" || !intent.idempotencyKey ||
    typeof intent.storageObjectId !== "string" || !UUID_V7_PATTERN.test(intent.storageObjectId) ||
    typeof intent.objectKey !== "string" ||
    !["staging", "delete_pending"].includes(intent.expectedStatus) ||
    !["filesystem", "s3"].includes(intent.driver)
  ) throw invalidEvent();
  const expectedIdempotencyKey = `storage-object-cleanup:${intent.storageObjectId}:${intent.expectedStatus}`;
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
    objectKey: intent.objectKey
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

function invalidEvent() {
  return new OutboxRepositoryError("INVALID_OUTBOX_EVENT", "Invalid outbox event");
}
