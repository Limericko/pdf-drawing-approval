import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { v7 as uuidV7 } from "uuid";
import {
  adminAuditQuerySchema,
  adminUserListQuerySchema,
  retryAdminJobRequestSchema,
  revokeAdminSessionsRequestSchema,
  setAdminUserStatusRequestSchema,
  updateAdminMembershipRequestSchema,
  type RetryAdminJobRequest,
  type RevokeAdminSessionsRequest,
  type SetAdminUserStatusRequest,
  type UpdateAdminMembershipRequest
} from "../../../shared/contracts/administration.ts";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import type { QueryExecutor } from "../../platform/database/queryExecutor.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { PostgresAuditRepository } from "../identity/repositories/postgres/PostgresAuditRepository.ts";

type UserRow = QueryResultRow & { id: string; email_normalized: string; display_name: string;
  platform_role: "admin" | "member"; status: "active" | "disabled"; mfa_status: "disabled" | "enabled";
  active_session_count: number; created_at: Date; updated_at: Date };
type MembershipRow = QueryResultRow & { id: string; project_id: string; user_id: string; role: string;
  status: string; created_at: Date; updated_at: Date };
type BackupRow = QueryResultRow & { id: string; provider: string; status: string; recovery_point_at: Date | null;
  started_at: Date; completed_at: Date | null; verification_status: string; error_code: string | null };
type DeadJobRow = QueryResultRow & { id: string; job_type: string; attempt_count: number; max_attempts: number;
  last_error_code: string | null; updated_at: Date };

export class AdministrationServiceError extends Error {
  constructor(readonly code: "ADMIN_INPUT_INVALID" | "ADMIN_FORBIDDEN" | "ADMIN_NOT_FOUND" |
    "ADMIN_STATE_CONFLICT" | "ADMIN_LAST_ADMIN" | "ADMIN_IDEMPOTENCY_CONFLICT" |
    "ADMIN_DEPENDENCY_UNAVAILABLE", options?: ErrorOptions) {
    super(code, options);
    this.name = "AdministrationServiceError";
  }
}

export function createAdministrationService(options: {
  readonly pool: PlatformPool;
  readonly storageHealth: () => Promise<void>;
  readonly clock?: () => Date;
}) {
  if (!options?.pool || typeof options.storageHealth !== "function") throw new Error("ADMIN_SERVICE_OPTIONS_REQUIRED");
  const clock = options.clock ?? (() => new Date());
  return Object.freeze({
    async listUsers(input: { actorUserId: string; page: number; pageSize: number; status?: string; keyword?: string }) {
      const actorUserId = ownId(input?.actorUserId);
      const parsed = adminUserListQuerySchema.safeParse({ page: input?.page, pageSize: input?.pageSize,
        ...(input?.status ? { status: input.status } : {}), ...(input?.keyword ? { keyword: input.keyword } : {}) });
      if (!parsed.success) throw invalid();
      try {
        await requireAdmin(options.pool, actorUserId);
        const keyword = parsed.data.keyword ? `%${escapeLike(parsed.data.keyword)}%` : null;
        const values = [parsed.data.status ?? null, keyword];
        const where = `($1::text IS NULL OR user_account.status=$1) AND ($2::text IS NULL OR
          user_account.email_normalized ILIKE $2 ESCAPE '\\' OR user_account.display_name ILIKE $2 ESCAPE '\\')`;
        const count = await options.pool.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM platform.users user_account WHERE ${where}`, values
        );
        const rows = await options.pool.query<UserRow>(userSelect(`${where}
          ORDER BY user_account.created_at DESC,user_account.id DESC LIMIT $3 OFFSET $4`),
        [...values, parsed.data.pageSize, (parsed.data.page - 1) * parsed.data.pageSize]);
        const total = count.rows[0]?.total ?? 0;
        return { items: rows.rows.map(mapUser), page: { page: parsed.data.page, pageSize: parsed.data.pageSize,
          total, pageCount: Math.ceil(total / parsed.data.pageSize) } };
      } catch (error) { throw owned(error); }
    },

    async setUserStatus(input: { actorUserId: string; targetUserId: string; requestId: string;
      update: SetAdminUserStatusRequest }) {
      const ownedInput = ownMutation(input, setAdminUserStatusRequestSchema);
      return mutate(options.pool, ownedInput, "user_status", async (transaction) => {
        await requireAdmin(transaction, ownedInput.actorUserId);
        const target = await lockUser(transaction, ownedInput.targetUserId);
        if (target.updated_at.toISOString() !== ownedInput.update.expectedUpdatedAt) throw conflict();
        const changed = target.status !== ownedInput.update.status;
        if (changed && ownedInput.update.status === "disabled" && target.platform_role === "admin") {
          const admins = await transaction.query<{ id: string }>(
            "SELECT id FROM platform.users WHERE platform_role='admin' AND status='active' ORDER BY id FOR UPDATE"
          );
          if (admins.rows.length <= 1) throw new AdministrationServiceError("ADMIN_LAST_ADMIN");
        }
        if (changed) {
          await transaction.query("UPDATE platform.users SET status=$1,updated_at=clock_timestamp() WHERE id=$2",
            [ownedInput.update.status, target.id]);
          if (ownedInput.update.status === "disabled") {
            await transaction.query(
              "UPDATE platform.sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL", [target.id]
            );
            await transaction.query(
              "UPDATE platform.project_members SET status='disabled',updated_at=clock_timestamp() WHERE user_id=$1 AND status='active'",
              [target.id]
            );
          }
        }
        await audit(transaction, ownedInput, "administration.user.status", target.id,
          { reason: ownedInput.update.reason, oldStatus: target.status, newStatus: ownedInput.update.status });
        return changed;
      });
    },

    async updateMembership(input: { actorUserId: string; projectId: string; membershipId: string; requestId: string;
      update: UpdateAdminMembershipRequest }) {
      const ownedInput = { ...ownMutation({ actorUserId: input.actorUserId, targetUserId: input.membershipId,
        requestId: input.requestId, update: input.update }, updateAdminMembershipRequestSchema),
        projectId: ownId(input?.projectId), membershipId: ownId(input?.membershipId) };
      return mutate(options.pool, { ...ownedInput, targetUserId: ownedInput.membershipId }, "membership_update",
        async (transaction) => {
          await requireAdmin(transaction, ownedInput.actorUserId);
          const result = await transaction.query<MembershipRow>(
            `SELECT id,project_id,user_id,role,status,created_at,updated_at FROM platform.project_members
             WHERE id=$1 AND project_id=$2 FOR UPDATE`, [ownedInput.membershipId, ownedInput.projectId]
          );
          const membership = result.rows[0];
          if (!membership) throw notFound();
          if (membership.updated_at.toISOString() !== ownedInput.update.expectedUpdatedAt) throw conflict();
          const changed = membership.role !== ownedInput.update.role || membership.status !== ownedInput.update.status;
          if (changed) await transaction.query(
            "UPDATE platform.project_members SET role=$1,status=$2,updated_at=clock_timestamp() WHERE id=$3",
            [ownedInput.update.role, ownedInput.update.status, membership.id]
          );
          await audit(transaction, ownedInput, "administration.membership.update", membership.id,
            { projectId: ownedInput.projectId, reason: ownedInput.update.reason,
              oldStatus: `${membership.role}:${membership.status}`,
              newStatus: `${ownedInput.update.role}:${ownedInput.update.status}` });
          return changed;
        });
    },

    async revokeUserSessions(input: { actorUserId: string; targetUserId: string; requestId: string;
      update: RevokeAdminSessionsRequest }) {
      const ownedInput = ownMutation(input, revokeAdminSessionsRequestSchema);
      return mutate(options.pool, ownedInput, "session_revoke", async (transaction) => {
        await requireAdmin(transaction, ownedInput.actorUserId);
        await lockUser(transaction, ownedInput.targetUserId);
        const result = await transaction.query(
          "UPDATE platform.sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL",
          [ownedInput.targetUserId]
        );
        const changed = (result.rowCount ?? 0) > 0;
        await audit(transaction, ownedInput, "administration.sessions.revoke", ownedInput.targetUserId,
          { reason: ownedInput.update.reason, count: result.rowCount ?? 0 });
        return changed;
      });
    },

    async retryDeadJob(input: { actorUserId: string; jobId: string; requestId: string;
      update: RetryAdminJobRequest }) {
      const ownedInput = { ...ownMutation({ ...input, targetUserId: input.jobId }, retryAdminJobRequestSchema),
        targetUserId: ownId(input?.jobId) };
      return mutate(options.pool, ownedInput, "job_retry", async (transaction) => {
        await requireAdmin(transaction, ownedInput.actorUserId);
        const job = await transaction.query<{ id: string; status: string }>(
          "SELECT id,status FROM platform.jobs WHERE id=$1 FOR UPDATE", [ownedInput.targetUserId]
        );
        if (!job.rows[0]) throw notFound();
        if (job.rows[0].status !== "dead") throw conflict();
        await transaction.query(
          `UPDATE platform.jobs SET status='pending',attempt_count=0,next_run_at=clock_timestamp(),
             lease_expires_at=NULL,lease_token=NULL,worker_id=NULL,last_error_code=NULL,last_error_message=NULL,
             started_at=NULL,completed_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, [ownedInput.targetUserId]
        );
        await audit(transaction, ownedInput, "administration.job.retry", ownedInput.targetUserId,
          { reason: ownedInput.update.reason, jobId: ownedInput.targetUserId });
        return true;
      });
    },

    async getDiagnostics(input: { actorUserId: string }) {
      const actorUserId = ownId(input?.actorUserId);
      try {
        await requireAdmin(options.pool, actorUserId);
        const [worker, queue, deadJobs, render, backup, storage] = await Promise.all([
          options.pool.query<{ last_heartbeat_at: Date | null }>(
            "SELECT last_heartbeat_at FROM platform.worker_health"),
          options.pool.query<{ pending: number; running: number; dead: number }>(
            `SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
              count(*) FILTER (WHERE status='running')::int AS running,
              count(*) FILTER (WHERE status='dead')::int AS dead FROM platform.jobs`),
          options.pool.query<DeadJobRow>(
            `SELECT id,job_type,attempt_count,max_attempts,last_error_code,updated_at
             FROM platform.jobs WHERE status='dead' ORDER BY updated_at DESC,id DESC LIMIT 50`),
          options.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM platform.render_artifacts WHERE status='failed'"),
          options.pool.query<BackupRow>(
            `SELECT id,provider,status,recovery_point_at,started_at,completed_at,verification_status,error_code
             FROM platform.backup_runs ORDER BY started_at DESC,id DESC LIMIT 1`),
          options.storageHealth().then(() => "healthy" as const, () => "unhealthy" as const)
        ]);
        const heartbeat = worker.rows[0]?.last_heartbeat_at ?? null;
        const age = heartbeat ? clock().getTime() - heartbeat.getTime() : Infinity;
        return { postgres: "healthy" as const, storage,
          worker: { status: heartbeat ? age <= 120_000 ? "healthy" as const : "stale" as const : "missing" as const,
            lastHeartbeatAt: heartbeat ? new Date(heartbeat) : null },
          queue: queue.rows[0] ?? { pending: 0, running: 0, dead: 0 },
          deadJobs: deadJobs.rows.map((job) => ({ id: job.id, jobType: safeText(job.job_type, 128),
            attemptCount: job.attempt_count, maxAttempts: job.max_attempts,
            errorCode: job.last_error_code ? safeText(job.last_error_code, 128) : null,
            updatedAt: new Date(job.updated_at) })),
          renderFailures: render.rows[0]?.count ?? 0,
          latestBackup: backup.rows[0] ? mapBackup(backup.rows[0]) : null };
      } catch (error) { throw owned(error); }
    },

    async listBackups(input: { actorUserId: string }) {
      const actorUserId = ownId(input?.actorUserId);
      try {
        await requireAdmin(options.pool, actorUserId);
        const result = await options.pool.query<BackupRow>(
          `SELECT id,provider,status,recovery_point_at,started_at,completed_at,verification_status,error_code
           FROM platform.backup_runs ORDER BY started_at DESC,id DESC LIMIT 100`
        );
        return { items: result.rows.map(mapBackup) };
      } catch (error) { throw owned(error); }
    },

    async listAudit(input: { actorUserId: string; page: number; pageSize: number; projectId?: string;
      filterActorUserId?: string; action?: string; from?: string; to?: string }) {
      const actorUserId = ownId(input?.actorUserId);
      const parsed = adminAuditQuerySchema.safeParse({ page: input.page, pageSize: input.pageSize,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.filterActorUserId ? { actorUserId: input.filterActorUserId } : {}),
        ...(input.action ? { action: input.action } : {}), ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}) });
      if (!parsed.success) throw invalid();
      try {
        await requireAdmin(options.pool, actorUserId);
        const values = [parsed.data.actorUserId ?? null, parsed.data.projectId ?? null,
          parsed.data.action ?? null, parsed.data.from ?? null, parsed.data.to ?? null] as unknown[];
        const where = `($1::uuid IS NULL OR actor_user_id=$1) AND
          ($2::uuid IS NULL OR metadata->>'projectId'=$2::text) AND
          ($3::text IS NULL OR action=$3) AND ($4::timestamptz IS NULL OR occurred_at >= $4) AND
          ($5::timestamptz IS NULL OR occurred_at <= $5)`;
        const count = await options.pool.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM platform.audit_events WHERE ${where}`, values
        );
        values.push(parsed.data.pageSize, (parsed.data.page - 1) * parsed.data.pageSize);
        const rows = await options.pool.query<QueryResultRow & { id: string; occurred_at: Date; actor_user_id: string | null;
          actor_type: string; action: string; target_type: string; target_id: string | null; request_id: string;
          result: "success" | "failure"; metadata: Record<string, unknown> }>(
          `SELECT id,occurred_at,actor_user_id,actor_type,action,target_type,target_id,request_id,result,metadata
           FROM platform.audit_events WHERE ${where} ORDER BY occurred_at DESC,id DESC LIMIT $6 OFFSET $7`, values
        );
        const total = count.rows[0]?.total ?? 0;
        return { items: rows.rows.map((row) => ({ id: row.id, occurredAt: new Date(row.occurred_at),
          actorUserId: row.actor_user_id, actorType: safeText(row.actor_type, 64), action: safeText(row.action, 160),
          targetType: safeText(row.target_type, 160), targetId: row.target_id,
          requestId: safeText(row.request_id, 128), result: row.result, metadata: safeMetadata(row.metadata) })),
          page: { page: parsed.data.page, pageSize: parsed.data.pageSize, total,
            pageCount: Math.ceil(total / parsed.data.pageSize) } };
      } catch (error) { throw owned(error); }
    }
  });
}

type OwnedMutation<T> = { actorUserId: string; targetUserId: string; requestId: string; update: T };

async function mutate<T extends { idempotencyKey: string }>(pool: PlatformPool, input: OwnedMutation<T>, action: string,
  operation: (transaction: QueryExecutor) => Promise<boolean>) {
  try {
    return await withTransaction(pool, async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.update.idempotencyKey]);
      const payloadHash = hash(input.update);
      const retry = await transaction.query<{ actor_user_id: string; action: string; target_id: string;
        payload_hash: Buffer; result_changed: boolean }>(
        `SELECT actor_user_id,action,target_id,payload_hash,result_changed FROM platform.admin_mutation_requests
         WHERE client_request_id=$1`, [input.update.idempotencyKey]
      );
      if (retry.rows[0]) {
        if (retry.rows[0].actor_user_id !== input.actorUserId || retry.rows[0].action !== action ||
            retry.rows[0].target_id !== input.targetUserId || !retry.rows[0].payload_hash.equals(payloadHash)) {
          throw idempotency();
        }
        return { targetId: input.targetUserId, changed: retry.rows[0].result_changed };
      }
      const changed = await operation(transaction);
      await transaction.query(
        `INSERT INTO platform.admin_mutation_requests
          (id,actor_user_id,action,target_id,client_request_id,payload_hash,result_changed)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuidV7(), input.actorUserId, action, input.targetUserId, input.update.idempotencyKey, payloadHash, changed]
      );
      return { targetId: input.targetUserId, changed };
    });
  } catch (error) { throw owned(error); }
}

async function requireAdmin(executor: QueryExecutor, userId: string) {
  const result = await executor.query<{ allowed: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM platform.users WHERE id=$1 AND platform_role='admin' AND status='active') AS allowed",
    [userId]
  );
  if (!result.rows[0]?.allowed) throw forbidden();
}

async function lockUser(executor: QueryExecutor, userId: string) {
  const result = await executor.query<UserRow>(userSelect("user_account.id=$1 FOR UPDATE OF user_account"), [userId]);
  if (!result.rows[0]) throw notFound();
  return result.rows[0];
}

function userSelect(suffix: string) {
  return `SELECT user_account.id,user_account.email_normalized,user_account.display_name,user_account.platform_role,
    user_account.status,user_account.mfa_status,user_account.created_at,user_account.updated_at,
    (SELECT count(*)::int FROM platform.sessions session WHERE session.user_id=user_account.id
      AND session.revoked_at IS NULL AND session.idle_expires_at > clock_timestamp()
      AND session.absolute_expires_at > clock_timestamp()) AS active_session_count
    FROM platform.users user_account WHERE ${suffix}`;
}

function mapUser(row: UserRow) { return { id: row.id, emailNormalized: row.email_normalized,
  displayName: row.display_name, platformRole: row.platform_role, status: row.status, mfaStatus: row.mfa_status,
  activeSessionCount: row.active_session_count, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) }; }
function mapBackup(row: BackupRow) { return { id: row.id, provider: row.provider, status: row.status,
  recoveryPointAt: row.recovery_point_at ? new Date(row.recovery_point_at) : null, startedAt: new Date(row.started_at),
  completedAt: row.completed_at ? new Date(row.completed_at) : null, verificationStatus: row.verification_status,
  errorCode: row.error_code }; }

async function audit(executor: QueryExecutor, input: { actorUserId: string; requestId: string }, action: string,
  targetId: string, metadata: Record<string, string | number>) {
  await new PostgresAuditRepository(executor).appendOnly({ actorUserId: input.actorUserId, actorType: "user",
    action, targetType: "administration", targetId, requestId: input.requestId, result: "success", metadata });
}

function ownMutation<T>(input: { actorUserId: string; targetUserId: string; requestId: string; update: T },
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): OwnedMutation<T> {
  const parsed = schema.safeParse(input?.update);
  if (!parsed.success) throw invalid();
  return { actorUserId: ownId(input?.actorUserId), targetUserId: ownId(input?.targetUserId),
    requestId: ownRequestId(input?.requestId), update: parsed.data };
}
function safeMetadata(value: Record<string, unknown>) {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, candidate] of Object.entries(value ?? {})) {
    if (/password|secret|token|hash|key/i.test(key) || Object.keys(safe).length >= 50) continue;
    if (candidate === null || ["string", "number", "boolean"].includes(typeof candidate)) {
      safe[key.slice(0, 80)] = typeof candidate === "string" ? candidate.slice(0, 500) : candidate as number | boolean | null;
    }
  }
  return safe;
}
function safeText(value: string, maximum: number) { return typeof value === "string" ? value.slice(0, maximum) : "invalid"; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest(); }
function ownId(value: unknown) { const parsed = uuidV7Schema.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data; }
function ownRequestId(value: unknown) { if (typeof value !== "string" || !value || value !== value.trim() ||
  value.length > 128 || /[\r\n\0]/.test(value)) throw invalid(); return value; }
function escapeLike(value: string) { return value.replace(/[\\%_]/g, "\\$&"); }
function owned(error: unknown) { return error instanceof AdministrationServiceError ? error : dependency(error); }
function invalid() { return new AdministrationServiceError("ADMIN_INPUT_INVALID"); }
function forbidden() { return new AdministrationServiceError("ADMIN_FORBIDDEN"); }
function notFound() { return new AdministrationServiceError("ADMIN_NOT_FOUND"); }
function conflict() { return new AdministrationServiceError("ADMIN_STATE_CONFLICT"); }
function idempotency() { return new AdministrationServiceError("ADMIN_IDEMPOTENCY_CONFLICT"); }
function dependency(cause?: unknown) { return new AdministrationServiceError("ADMIN_DEPENDENCY_UNAVAILABLE", { cause }); }
