import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../database/queryExecutor.ts";
import {
  cloneJsonObject,
  type OutboxEvent,
  OutboxRepositoryError
} from "../jobTypes.ts";
import type { OutboxRepository } from "../outboxRepository.ts";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LIMIT = 1_000;

type OutboxRow = QueryResultRow & {
  id: string;
  event_type: string;
  payload_version: number;
  payload: unknown;
  created_at: Date;
  dispatched_at: Date | null;
};

type TransitionRow = OutboxRow & { outcome: "updated" | "missing" | "state_conflict" };
const COLUMNS = "id, event_type, payload_version, payload, created_at, dispatched_at";
const NULL_COLUMNS = "NULL::uuid AS id, NULL::text AS event_type, NULL::integer AS payload_version, NULL::jsonb AS payload, NULL::timestamptz AS created_at, NULL::timestamptz AS dispatched_at";

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async claimUndispatched(limit: number) {
    assertLimit(limit);
    const result = await this.executor.query<OutboxRow>(
      `SELECT ${COLUMNS}
       FROM platform.outbox_events
       WHERE dispatched_at IS NULL
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapOutboxEvent);
  }

  async markDispatched(id: string, dispatchedAt: Date) {
    assertId(id);
    const ownedDate = ownDate(dispatchedAt);
    const result = await this.executor.query<TransitionRow>(
      `WITH existing AS MATERIALIZED (
         SELECT id FROM platform.outbox_events WHERE id = $1
       ), updated AS (
         UPDATE platform.outbox_events
         SET dispatched_at = $2
         WHERE id = $1 AND dispatched_at IS NULL AND created_at <= $2
         RETURNING ${COLUMNS}
       ), classified AS (
         SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM existing) THEN 'missing' ELSE 'state_conflict' END AS outcome
         WHERE NOT EXISTS (SELECT 1 FROM updated)
       )
       SELECT 'updated'::text AS outcome, ${COLUMNS} FROM updated
       UNION ALL
       SELECT outcome, ${NULL_COLUMNS} FROM classified`,
      [id, ownedDate]
    );
    const row = result.rows[0];
    if (!row) throw new OutboxRepositoryError("INVALID_OUTBOX_ROW", "Outbox transition returned no outcome");
    if (row.outcome === "updated") return mapOutboxEvent(row);
    if (row.outcome === "missing") throw new OutboxRepositoryError("OUTBOX_EVENT_NOT_FOUND", "Outbox event was not found");
    throw new OutboxRepositoryError("OUTBOX_EVENT_STATE_CONFLICT", "Outbox event cannot be marked dispatched");
  }
}

function mapOutboxEvent(row: OutboxRow): OutboxEvent {
  assertId(row.id);
  if (!isValidText(row.event_type, 128) || !Number.isSafeInteger(row.payload_version) || row.payload_version < 1) {
    throw invalidRow();
  }
  return Object.freeze({
    id: row.id,
    eventType: row.event_type,
    payloadVersion: row.payload_version,
    payload: cloneJsonObject(row.payload, invalidRow),
    createdAt: cloneDate(row.created_at),
    dispatchedAt: row.dispatched_at === null ? null : cloneDate(row.dispatched_at)
  });
}

function assertId(id: string) {
  if (typeof id !== "string" || !UUID_V7_PATTERN.test(id)) throw new OutboxRepositoryError("INVALID_OUTBOX_ID", "Invalid outbox event identifier");
}

function assertLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new OutboxRepositoryError("INVALID_OUTBOX_LIMIT", "Invalid outbox claim limit");
}

function ownDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new OutboxRepositoryError("INVALID_OUTBOX_DATE", "Invalid outbox event date");
  return new Date(value.getTime());
}

function cloneDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalidRow();
  return new Date(value.getTime());
}

function invalidRow() {
  return new OutboxRepositoryError("INVALID_OUTBOX_ROW", "Invalid outbox event row");
}

function isValidText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && !!value && value === value.trim() &&
    value.length <= maximumLength && !/[\u0000-\u001f\u007f]/.test(value);
}
