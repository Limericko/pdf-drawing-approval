import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../database/queryExecutor.ts";
import type {
  ClaimJobInput,
  CompleteJobInput,
  CreateJobResult,
  FailJobInput,
  JobRepository,
  RenewJobLeaseInput
} from "../jobRepository.ts";
import {
  cloneJsonObject,
  type CreateJob,
  type Job,
  JobRepositoryError,
  type JobStatus
} from "../jobTypes.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TEXT_LENGTH = 2_000;

type JobRow = QueryResultRow & {
  id: string;
  job_type: string;
  payload_version: number;
  payload: unknown;
  idempotency_key: string;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  next_run_at: Date;
  lease_expires_at: Date | null;
  lease_token: string | null;
  worker_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

type CreateRow = JobRow & { inserted: boolean };
type TransitionRow = JobRow & { outcome: "updated" | "missing" | "stale" | "date_order" };

const COLUMNS = `id, job_type, payload_version, payload, idempotency_key, status,
  attempt_count, max_attempts, next_run_at, lease_expires_at, lease_token, worker_id,
  last_error_code, last_error_message, created_at, updated_at, started_at, completed_at`;
const NULL_COLUMNS = `NULL::uuid AS id, NULL::text AS job_type, NULL::integer AS payload_version,
  NULL::jsonb AS payload, NULL::text AS idempotency_key, NULL::text AS status,
  NULL::integer AS attempt_count, NULL::integer AS max_attempts, NULL::timestamptz AS next_run_at,
  NULL::timestamptz AS lease_expires_at, NULL::uuid AS lease_token, NULL::text AS worker_id,
  NULL::text AS last_error_code, NULL::text AS last_error_message, NULL::timestamptz AS created_at,
  NULL::timestamptz AS updated_at, NULL::timestamptz AS started_at, NULL::timestamptz AS completed_at`;
const JOB_COLUMNS = `j.id, j.job_type, j.payload_version, j.payload, j.idempotency_key, j.status,
  j.attempt_count, j.max_attempts, j.next_run_at, j.lease_expires_at, j.lease_token, j.worker_id,
  j.last_error_code, j.last_error_message, j.created_at, j.updated_at, j.started_at, j.completed_at`;

type RepositoryOptions = { readonly createLeaseToken?: () => string };

export class PostgresJobRepository implements JobRepository {
  private readonly createLeaseToken: () => string;

  constructor(private readonly executor: QueryExecutor, options: RepositoryOptions = {}) {
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
  }

  async create(input: CreateJob): Promise<CreateJobResult> {
    const owned = ownCreateJob(input);
    const result = await this.executor.query<CreateRow>(
      `WITH inserted AS (
         INSERT INTO platform.jobs (
           id, job_type, payload_version, payload, idempotency_key, status,
           attempt_count, max_attempts, next_run_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $7, $8, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${COLUMNS}
       )
       SELECT true AS inserted, ${COLUMNS} FROM inserted
       UNION ALL
       SELECT false AS inserted, ${COLUMNS} FROM platform.jobs
       WHERE idempotency_key = $5 AND NOT EXISTS (SELECT 1 FROM inserted)`,
      [owned.id, owned.jobType, owned.payloadVersion, owned.payload, owned.idempotencyKey, owned.maxAttempts, owned.nextRunAt, owned.createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new JobRepositoryError("INVALID_JOB_ROW", "Job insert returned no outcome");
    const job = mapJob(row);
    if (!row.inserted && !sameIdempotentJob(job, owned)) {
      throw new JobRepositoryError("JOB_IDEMPOTENCY_CONFLICT", "Job idempotency key belongs to different content");
    }
    return Object.freeze({ created: row.inserted, job });
  }

  async findById(id: string) {
    assertJobId(id);
    const result = await this.executor.query<JobRow>(`SELECT ${COLUMNS} FROM platform.jobs WHERE id = $1`, [id]);
    return result.rows[0] ? mapJob(result.rows[0]) : undefined;
  }

  async claim(input: ClaimJobInput) {
    const owned = ownClaim(input);
    const leaseToken = this.createLeaseToken();
    assertLeaseToken(leaseToken);
    const leaseExpiresAt = addDuration(owned.now, owned.leaseDurationMs);
    const result = await this.executor.query<JobRow>(
      `WITH exhausted AS MATERIALIZED (
         UPDATE platform.jobs
         SET status = 'dead', worker_id = NULL, lease_expires_at = NULL, lease_token = NULL,
           last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
           last_error_message = 'Job lease expired after maximum attempts',
           updated_at = $2, completed_at = $2
         WHERE status = 'running' AND lease_expires_at <= $2 AND attempt_count >= max_attempts
         RETURNING id
       ), next_job AS MATERIALIZED (
         SELECT j.id
         FROM platform.jobs j
         CROSS JOIN (SELECT count(*) FROM exhausted) exhausted_done
         WHERE (j.status = 'pending' AND j.next_run_at <= $2)
            OR (j.status = 'running' AND j.lease_expires_at <= $2 AND j.attempt_count < j.max_attempts)
         ORDER BY j.next_run_at, j.created_at, j.id
         FOR UPDATE OF j SKIP LOCKED
         LIMIT 1
       )
       UPDATE platform.jobs j
       SET status = 'running', worker_id = $1, lease_expires_at = $3, lease_token = $4,
         attempt_count = j.attempt_count + 1, updated_at = $2,
         started_at = COALESCE(j.started_at, $2), completed_at = NULL
       FROM next_job
       WHERE j.id = next_job.id
       RETURNING ${JOB_COLUMNS}`,
      [owned.workerId, owned.now, leaseExpiresAt, leaseToken]
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async renewLease(input: RenewJobLeaseInput) {
    const owned = ownRenew(input);
    const leaseExpiresAt = addDuration(owned.now, owned.leaseDurationMs);
    return this.fencedTransition(
      `SET lease_expires_at = $5, updated_at = $4
       WHERE id = $1 AND worker_id = $2 AND lease_token = $3 AND status = 'running'
         AND lease_expires_at > $4 AND updated_at <= $4`,
      [owned.id, owned.workerId, owned.leaseToken, owned.now, leaseExpiresAt]
    );
  }

  async succeed(input: CompleteJobInput) {
    const owned = ownComplete(input);
    return this.fencedTransition(
      `SET status = 'succeeded', worker_id = NULL, lease_expires_at = NULL, lease_token = NULL,
         updated_at = $4, completed_at = $4
       WHERE id = $1 AND worker_id = $2 AND lease_token = $3 AND status = 'running' AND updated_at <= $4`,
      [owned.id, owned.workerId, owned.leaseToken, owned.completedAt]
    );
  }

  async fail(input: FailJobInput) {
    const owned = ownFailure(input);
    const nextRunAt = owned.kind === "transient" ? owned.nextRunAt! : owned.failedAt;
    const forceDead = owned.kind === "permanent";
    return this.fencedTransition(
      `SET status = CASE WHEN $7 OR attempt_count >= max_attempts THEN 'dead' ELSE 'pending' END,
         worker_id = NULL, lease_expires_at = NULL, lease_token = NULL,
         last_error_code = $5, last_error_message = $6,
         next_run_at = CASE WHEN $7 OR attempt_count >= max_attempts THEN $4 ELSE $8 END,
         updated_at = $4,
         completed_at = CASE WHEN $7 OR attempt_count >= max_attempts THEN $4 ELSE NULL END
       WHERE id = $1 AND worker_id = $2 AND lease_token = $3 AND status = 'running' AND updated_at <= $4`,
      [owned.id, owned.workerId, owned.leaseToken, owned.failedAt, owned.errorCode, owned.errorMessage, forceDead, nextRunAt]
    );
  }

  private async fencedTransition(setAndWhere: string, values: readonly unknown[]) {
    const result = await this.executor.query<TransitionRow>(
      `WITH existing AS MATERIALIZED (
         SELECT worker_id, lease_token, status, updated_at FROM platform.jobs WHERE id = $1
       ), updated AS (
         UPDATE platform.jobs ${setAndWhere}
         RETURNING ${COLUMNS}
       ), classified AS (
         SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM existing) THEN 'missing'
           WHEN EXISTS (
             SELECT 1 FROM existing
             WHERE worker_id = $2 AND lease_token = $3 AND status = 'running' AND updated_at > $4
           ) THEN 'date_order'
           ELSE 'stale'
         END AS outcome
         WHERE NOT EXISTS (SELECT 1 FROM updated)
       )
       SELECT 'updated'::text AS outcome, ${COLUMNS} FROM updated
       UNION ALL
       SELECT outcome, ${NULL_COLUMNS} FROM classified`,
      values
    );
    const row = result.rows[0];
    if (!row) throw invalidRow();
    if (row.outcome === "updated") return mapJob(row);
    if (row.outcome === "missing") throw new JobRepositoryError("JOB_NOT_FOUND", "Job was not found");
    if (row.outcome === "date_order") throw new JobRepositoryError("INVALID_JOB_DATE_ORDER", "Job transition date is before its current state");
    throw new JobRepositoryError("STALE_LEASE", "Job lease is stale");
  }
}

function mapJob(row: JobRow): Job {
  assertJobId(row.id);
  if (
    !isValidText(row.job_type, 128) ||
    !Number.isSafeInteger(row.payload_version) || row.payload_version < 1 ||
    !isValidText(row.idempotency_key, 512) ||
    !["pending", "running", "succeeded", "dead"].includes(row.status) ||
    !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
    !Number.isSafeInteger(row.max_attempts) || row.max_attempts < 1 ||
    (row.worker_id !== null && !isValidText(row.worker_id, 255)) ||
    (row.last_error_code !== null && !isValidText(row.last_error_code, 128)) ||
    (row.last_error_message !== null && !isValidText(row.last_error_message, MAX_TEXT_LENGTH))
  ) throw invalidRow();
  if (row.lease_token !== null) assertLeaseToken(row.lease_token);
  return Object.freeze({
    id: row.id,
    jobType: row.job_type,
    payloadVersion: row.payload_version,
    payload: cloneJsonObject(row.payload, invalidRow),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextRunAt: cloneDate(row.next_run_at),
    leaseExpiresAt: nullableDate(row.lease_expires_at),
    leaseToken: row.lease_token,
    workerId: row.worker_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: cloneDate(row.created_at),
    updatedAt: cloneDate(row.updated_at),
    startedAt: nullableDate(row.started_at),
    completedAt: nullableDate(row.completed_at)
  });
}

function ownCreateJob(input: CreateJob): CreateJob {
  if (!input || typeof input !== "object") throw invalidInput();
  assertJobId(input.id);
  assertText(input.jobType, 128);
  assertText(input.idempotencyKey, 512);
  if (!Number.isSafeInteger(input.payloadVersion) || input.payloadVersion < 1 || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) throw invalidInput();
  return Object.freeze({
    id: input.id,
    jobType: input.jobType,
    payloadVersion: input.payloadVersion,
    payload: cloneJsonObject(input.payload, invalidInput),
    idempotencyKey: input.idempotencyKey,
    maxAttempts: input.maxAttempts,
    nextRunAt: ownDate(input.nextRunAt),
    createdAt: ownDate(input.createdAt)
  });
}

function ownClaim(input: ClaimJobInput) {
  if (!input || typeof input !== "object") throw invalidInput();
  assertText(input.workerId, 255);
  return { workerId: input.workerId, now: ownDate(input.now), leaseDurationMs: ownDuration(input.leaseDurationMs) };
}

function ownRenew(input: RenewJobLeaseInput) {
  const lease = ownLease(input);
  return { ...lease, now: ownDate(input.now), leaseDurationMs: ownDuration(input.leaseDurationMs) };
}

function ownComplete(input: CompleteJobInput) {
  return { ...ownLease(input), completedAt: ownDate(input.completedAt) };
}

function ownFailure(input: FailJobInput) {
  const lease = ownLease(input);
  const failedAt = ownDate(input.failedAt);
  if (input.kind !== "transient" && input.kind !== "permanent") throw invalidInput();
  assertText(input.errorCode, 128);
  assertText(input.errorMessage, MAX_TEXT_LENGTH);
  let nextRunAt: Date | undefined;
  if (input.kind === "transient") {
    nextRunAt = ownDate(input.nextRunAt);
    if (nextRunAt.getTime() < failedAt.getTime()) throw new JobRepositoryError("INVALID_JOB_DATE_ORDER", "Retry date is before failure date");
  } else if (input.nextRunAt !== undefined) {
    throw invalidInput();
  }
  return { ...lease, failedAt, kind: input.kind, errorCode: input.errorCode, errorMessage: input.errorMessage, nextRunAt };
}

function ownLease(input: { id: string; workerId: string; leaseToken: string }) {
  if (!input || typeof input !== "object") throw invalidInput();
  assertJobId(input.id);
  assertText(input.workerId, 255);
  assertLeaseToken(input.leaseToken);
  return { id: input.id, workerId: input.workerId, leaseToken: input.leaseToken };
}

function sameIdempotentJob(existing: Job, requested: CreateJob) {
  return existing.jobType === requested.jobType &&
    existing.payloadVersion === requested.payloadVersion &&
    existing.maxAttempts === requested.maxAttempts &&
    sameJsonValue(existing.payload, requested.payload);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]));
}

function addDuration(now: Date, durationMs: number) {
  const value = now.getTime() + durationMs;
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) throw new JobRepositoryError("INVALID_JOB_DATE", "Invalid job lease date");
  return new Date(value);
}

function ownDuration(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput();
  return value;
}

function assertJobId(value: string) {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) throw new JobRepositoryError("INVALID_JOB_ID", "Invalid job identifier");
}

function assertLeaseToken(value: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalidInput();
}

function assertText(value: string, maximumLength: number) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximumLength || /[\u0000-\u001f\u007f]/.test(value)) throw invalidInput();
}

function ownDate(value: Date | undefined) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new JobRepositoryError("INVALID_JOB_DATE", "Invalid job date");
  return new Date(value.getTime());
}

function cloneDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalidRow();
  return new Date(value.getTime());
}

function nullableDate(value: Date | null) {
  return value === null ? null : cloneDate(value);
}

function invalidInput() {
  return new JobRepositoryError("INVALID_JOB_INPUT", "Invalid job input");
}

function invalidRow() {
  return new JobRepositoryError("INVALID_JOB_ROW", "Invalid job row");
}

function isValidText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && !!value && value === value.trim() &&
    value.length <= maximumLength && !/[\u0000-\u001f\u007f]/.test(value);
}
