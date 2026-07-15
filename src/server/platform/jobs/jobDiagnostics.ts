import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../database/queryExecutor.ts";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type TransactionRunner = <T>(callback: (executor: QueryExecutor) => Promise<T>) => Promise<T>;

type DiagnosticsOptions = {
  readonly executor: QueryExecutor;
  readonly transactionRunner: TransactionRunner;
  readonly clock: () => Date;
  readonly createId: () => string;
};

type SummaryRow = QueryResultRow & { pending_count: string; running_count: string; dead_count: string; oldest_created_at: Date | null };
type HeartbeatRow = QueryResultRow & { worker_id: string; started_at: Date; heartbeat_at: Date };
type DeadRow = QueryResultRow & { id: string; job_type: string; attempt_count: number; max_attempts: number; last_error_code: string | null; updated_at: Date };

export class JobDiagnostics {
  constructor(private readonly options: DiagnosticsOptions) {}

  async summary() {
    const now = ownDate(this.options.clock());
    const [jobs, heartbeats] = await Promise.all([
      this.options.executor.query<SummaryRow>(
        `SELECT
           count(*) FILTER (WHERE status = 'pending')::text AS pending_count,
           count(*) FILTER (WHERE status = 'running')::text AS running_count,
           count(*) FILTER (WHERE status = 'dead')::text AS dead_count,
           min(created_at) FILTER (WHERE status IN ('pending', 'running')) AS oldest_created_at
         FROM platform.jobs`
      ),
      this.options.executor.query<HeartbeatRow>(
        `SELECT worker_id, started_at, heartbeat_at FROM platform.worker_heartbeats
         ORDER BY heartbeat_at DESC, worker_id LIMIT 100`
      )
    ]);
    const row = jobs.rows[0];
    if (!row) throw invalidRow();
    const pendingCount = count(row.pending_count);
    const runningCount = count(row.running_count);
    const deadCount = count(row.dead_count);
    const oldest = row.oldest_created_at === null ? null : ownRowDate(row.oldest_created_at);
    return Object.freeze({
      queueDepth: pendingCount + runningCount,
      pendingCount,
      runningCount,
      deadCount,
      oldestJobAgeMs: oldest === null ? null : Math.max(0, now.getTime() - oldest.getTime()),
      workers: heartbeats.rows.map((heartbeat) => Object.freeze({
        workerId: safeWorkerId(heartbeat.worker_id),
        startedAt: ownRowDate(heartbeat.started_at),
        heartbeatAt: ownRowDate(heartbeat.heartbeat_at)
      }))
    });
  }

  async listDead(limit = 50) {
    assertLimit(limit);
    const result = await this.options.executor.query<DeadRow>(
      `SELECT id, job_type, attempt_count, max_attempts, last_error_code, updated_at
       FROM platform.jobs WHERE status = 'dead'
       ORDER BY updated_at DESC, id LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => Object.freeze({
      id: assertId(row.id),
      jobType: safeText(row.job_type, 128),
      attemptCount: safeCount(row.attempt_count),
      maxAttempts: safeCount(row.max_attempts),
      errorCode: nullableText(row.last_error_code, 128),
      updatedAt: ownRowDate(row.updated_at)
    }));
  }

  async retryDead(input: { jobId: string; reason: string; actor: string; requestId: string }) {
    const owned = ownRetry(input);
    const now = ownDate(this.options.clock());
    const auditId = assertId(this.options.createId());
    return this.options.transactionRunner(async (transaction) => {
      const result = await transaction.query<{ id: string; old_attempt_count: number }>(
        `WITH candidate AS MATERIALIZED (
           SELECT id, attempt_count FROM platform.jobs WHERE id = $1 AND status = 'dead' FOR UPDATE
         ), updated AS (
           UPDATE platform.jobs j
           SET status = 'pending', attempt_count = 0, next_run_at = $2,
             lease_expires_at = NULL, lease_token = NULL, worker_id = NULL,
             last_error_code = NULL, last_error_message = NULL,
             updated_at = $2, completed_at = NULL
           FROM candidate c WHERE j.id = c.id
           RETURNING j.id, c.attempt_count AS old_attempt_count
         )
         SELECT id, old_attempt_count FROM updated`,
        [owned.jobId, now]
      );
      if (!result.rows[0]) throw new JobDiagnosticsError("DEAD_JOB_RETRY_CONFLICT");
      await transaction.query(
        `INSERT INTO platform.audit_events (
           id, occurred_at, actor_type, action, target_type, target_id, request_id, result, metadata
         ) VALUES ($1, $2, 'operator', 'job.dead.retry', 'job', $3, $4, 'success',
           jsonb_build_object('actor', $5::text, 'reason', $6::text, 'oldAttemptCount', $7::integer))`,
        [auditId, now, owned.jobId, owned.requestId, owned.actor, owned.reason, result.rows[0].old_attempt_count]
      );
      return Object.freeze({ id: result.rows[0].id, oldAttemptCount: result.rows[0].old_attempt_count, status: "pending" as const });
    });
  }
}

export class JobDiagnosticsError extends Error {
  constructor(readonly code: "INVALID_JOB_DIAGNOSTICS_INPUT" | "INVALID_JOB_DIAGNOSTICS_ROW" | "DEAD_JOB_RETRY_CONFLICT") {
    super(code);
    this.name = "JobDiagnosticsError";
  }
}

function ownRetry(input: { jobId: string; reason: string; actor: string; requestId: string }) {
  if (!input || typeof input !== "object") throw invalid();
  return {
    jobId: assertId(input.jobId),
    reason: inputText(input.reason, 500),
    actor: inputText(input.actor, 255),
    requestId: inputText(input.requestId, 255)
  };
}

function assertId(value: string) {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) throw invalid();
  return value;
}

function inputText(value: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value;
}

function safeText(value: string, maximum: number) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw invalidRow();
  return value;
}

function nullableText(value: string | null, maximum: number) {
  return value === null ? null : safeText(value, maximum);
}

function safeWorkerId(value: string) { return safeText(value, 255); }
function safeCount(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw invalidRow(); return value; }
function count(value: string) { const parsed = Number(value); return safeCount(parsed); }
function assertLimit(value: number) { if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw invalid(); }
function ownDate(value: Date) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalid(); return new Date(value); }
function ownRowDate(value: Date) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalidRow(); return new Date(value); }
function invalid() { return new JobDiagnosticsError("INVALID_JOB_DIAGNOSTICS_INPUT"); }
function invalidRow() { return new JobDiagnosticsError("INVALID_JOB_DIAGNOSTICS_ROW"); }
