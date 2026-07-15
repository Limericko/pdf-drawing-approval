import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import { cloneJsonObject, type JsonObject } from "./jobTypes.ts";

const MAX_WORKER_ID = 255;

export type WorkerHeartbeat = {
  readonly workerId: string;
  readonly startedAt: Date;
  readonly heartbeatAt: Date;
  readonly metadata: JsonObject;
};

type HeartbeatRow = QueryResultRow & {
  worker_id: string;
  started_at: Date;
  heartbeat_at: Date;
  metadata: unknown;
};

export class WorkerHeartbeatRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async record(input: { workerId: string; startedAt: Date; heartbeatAt: Date; metadata: Record<string, unknown> }) {
    const owned = ownHeartbeat(input);
    const result = await this.executor.query<HeartbeatRow>(
      `INSERT INTO platform.worker_heartbeats (worker_id, started_at, heartbeat_at, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (worker_id) DO UPDATE
       SET heartbeat_at = EXCLUDED.heartbeat_at, metadata = EXCLUDED.metadata
       WHERE platform.worker_heartbeats.heartbeat_at <= EXCLUDED.heartbeat_at
       RETURNING worker_id, started_at, heartbeat_at, metadata`,
      [owned.workerId, owned.startedAt, owned.heartbeatAt, owned.metadata]
    );
    if (!result.rows[0]) throw new WorkerHeartbeatError("HEARTBEAT_TIME_CONFLICT");
    return mapHeartbeat(result.rows[0]);
  }
}

export class WorkerHeartbeatError extends Error {
  constructor(readonly code: "INVALID_WORKER_HEARTBEAT" | "HEARTBEAT_TIME_CONFLICT" | "INVALID_WORKER_HEARTBEAT_ROW") {
    super(code);
    this.name = "WorkerHeartbeatError";
  }
}

function ownHeartbeat(input: { workerId: string; startedAt: Date; heartbeatAt: Date; metadata: Record<string, unknown> }) {
  if (!input || typeof input !== "object" || typeof input.workerId !== "string" || !input.workerId ||
      input.workerId !== input.workerId.trim() || input.workerId.length > MAX_WORKER_ID || /[\u0000-\u001f\u007f]/.test(input.workerId)) throw invalid();
  const startedAt = ownDate(input.startedAt);
  const heartbeatAt = ownDate(input.heartbeatAt);
  if (heartbeatAt.getTime() < startedAt.getTime()) throw invalid();
  const metadata = cloneJsonObject(input.metadata, invalid);
  return { workerId: input.workerId, startedAt, heartbeatAt, metadata };
}

function mapHeartbeat(row: HeartbeatRow): WorkerHeartbeat {
  if (!row || typeof row.worker_id !== "string") throw new WorkerHeartbeatError("INVALID_WORKER_HEARTBEAT_ROW");
  return Object.freeze({
    workerId: row.worker_id,
    startedAt: ownRowDate(row.started_at),
    heartbeatAt: ownRowDate(row.heartbeat_at),
    metadata: cloneJsonObject(row.metadata, () => new WorkerHeartbeatError("INVALID_WORKER_HEARTBEAT_ROW"))
  });
}

function ownDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalid();
  return new Date(value.getTime());
}

function ownRowDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new WorkerHeartbeatError("INVALID_WORKER_HEARTBEAT_ROW");
  return new Date(value.getTime());
}

function invalid() {
  return new WorkerHeartbeatError("INVALID_WORKER_HEARTBEAT");
}
