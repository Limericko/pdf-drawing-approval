import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { v7 as uuidV7 } from "uuid";
import {
  createIssueRequestSchema,
  forceCloseIssueRequestSchema,
  issueListQuerySchema,
  reviewIssueRequestSchema,
  startIssueRequestSchema,
  submitIssueRequestSchema,
  type CreateIssueRequest,
  type ForceCloseIssueRequest,
  type ReviewIssueRequest,
  type StartIssueRequest,
  type SubmitIssueRequest
} from "../../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import type { QueryExecutor } from "../../platform/database/queryExecutor.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { PostgresAuditRepository } from "../identity/repositories/postgres/PostgresAuditRepository.ts";

type ProjectRole = "manager" | "designer" | "supervisor" | "process" | "viewer";
type IssueStatus = "open" | "in_progress" | "review" | "closed";
type IssueRow = QueryResultRow & {
  id: string; project_id: string; approval_case_id: string; annotation_id: string | null;
  creator_user_id: string; assignee_user_id: string; title: string; description: string;
  severity: "low" | "medium" | "high" | "critical"; status: IssueStatus; due_at: Date | null;
  version: number; created_at: Date; updated_at: Date; client_request_hash?: Buffer;
  annotation_project_id?: string | null; annotation_approval_case_id?: string | null;
  annotation_author_user_id?: string | null; annotation_kind?: "pin" | "rect" | "arrow" | "circle" | "text" | "ink" | "cloud" | null;
  annotation_page_number?: number | null; annotation_geometry?: Record<string, unknown> | null;
  annotation_style?: Record<string, unknown> | null; annotation_message?: string | null;
  annotation_resolved?: boolean | null; annotation_version?: number | null;
  annotation_created_at?: Date | null; annotation_updated_at?: Date | null;
};

export class IssueServiceError extends Error {
  constructor(readonly code: "ISSUE_INPUT_INVALID" | "ISSUE_FORBIDDEN" | "ISSUE_NOT_FOUND" |
    "ISSUE_STATE_CONFLICT" | "ISSUE_IDEMPOTENCY_CONFLICT" | "ISSUE_DEPENDENCY_UNAVAILABLE",
  options?: ErrorOptions) {
    super(code, options);
    this.name = "IssueServiceError";
  }
}

export function createIssueService(options: { readonly pool: PlatformPool }) {
  if (!options?.pool) throw new Error("ISSUE_SERVICE_POOL_REQUIRED");
  return Object.freeze({
    async createIssue(input: { readonly projectId: string; readonly approvalId: string;
      readonly actorUserId: string; readonly requestId: string; readonly issue: CreateIssueRequest }) {
      const owned = ownCreate(input);
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await lockKey(transaction, owned.issue.idempotencyKey);
          const payloadHash = hash(owned.issue);
          const retry = await transaction.query<IssueRow>(
            `SELECT ${ISSUE_COLUMNS},client_request_hash FROM platform.issues
             WHERE client_request_id=$1`, [owned.issue.idempotencyKey]
          );
          if (retry.rows[0]) {
            if (!retry.rows[0].client_request_hash?.equals(payloadHash) ||
                retry.rows[0].project_id !== owned.projectId || retry.rows[0].approval_case_id !== owned.approvalId) {
              throw idempotency();
            }
            return loadIssue(transaction, owned.projectId, retry.rows[0].id);
          }
          await requireRole(transaction, owned.projectId, owned.actorUserId, "create");
          const valid = await transaction.query<{ valid: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM platform.approval_cases WHERE id=$1 AND project_id=$2) AND
              EXISTS (SELECT 1 FROM platform.project_members membership
                INNER JOIN platform.users actor ON actor.id=membership.user_id AND actor.status='active'
                WHERE membership.project_id=$2 AND membership.user_id=$3 AND membership.status='active') AS valid`,
            [owned.approvalId, owned.projectId, owned.issue.assigneeUserId]
          );
          if (!valid.rows[0]?.valid) throw notFound();
          let annotationId: string | null = null;
          if (owned.issue.annotation) {
            annotationId = uuidV7();
            await transaction.query(
              `INSERT INTO platform.annotations
                (id,project_id,approval_case_id,author_user_id,kind,page_number,geometry,style,message)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [annotationId, owned.projectId, owned.approvalId, owned.actorUserId,
                owned.issue.annotation.kind, owned.issue.annotation.pageNumber,
                owned.issue.annotation.geometry, owned.issue.annotation.style, owned.issue.annotation.message]
            );
          }
          const issueId = uuidV7();
          const created = await transaction.query<IssueRow>(
            `INSERT INTO platform.issues
              (id,project_id,approval_case_id,annotation_id,creator_user_id,assignee_user_id,title,
               description,severity,due_at,client_request_id,client_request_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${ISSUE_COLUMNS}`,
            [issueId, owned.projectId, owned.approvalId, annotationId, owned.actorUserId,
              owned.issue.assigneeUserId, owned.issue.title, owned.issue.description, owned.issue.severity,
              owned.issue.dueAt, owned.issue.idempotencyKey, payloadHash]
          );
          await appendEvent(transaction, { issueId, actorUserId: owned.actorUserId, eventType: "created",
            fromStatus: null, toStatus: "open", note: null, idempotencyKey: owned.issue.idempotencyKey,
            payloadHash });
          await audit(transaction, owned.actorUserId, owned.requestId, "issue.create", issueId, owned.projectId);
          return loadIssue(transaction, owned.projectId, created.rows[0]!.id);
        });
      } catch (error) { throw ownedError(error); }
    },

    startIssue(input: TransitionInput<StartIssueRequest>) {
      return transition(options.pool, ownTransition(input, startIssueRequestSchema), "started", "in_progress");
    },
    submitIssue(input: TransitionInput<SubmitIssueRequest>) {
      return transition(options.pool, ownTransition(input, submitIssueRequestSchema), "submitted", "review");
    },
    reviewIssue(input: TransitionInput<ReviewIssueRequest>) {
      const owned = ownTransition(input, reviewIssueRequestSchema);
      return transition(options.pool, owned, owned.update.decision === "closed" ? "closed" : "returned",
        owned.update.decision === "closed" ? "closed" : "in_progress");
    },
    forceCloseIssue(input: TransitionInput<ForceCloseIssueRequest>) {
      return transition(options.pool, ownTransition(input, forceCloseIssueRequestSchema), "force_closed", "closed");
    },

    async getIssue(input: { readonly projectId: string; readonly issueId: string; readonly actorUserId: string }) {
      const projectId = ownId(input?.projectId);
      const issueId = ownId(input?.issueId);
      const actorUserId = ownId(input?.actorUserId);
      try {
        await requireRole(options.pool, projectId, actorUserId, "read");
        return await loadIssue(options.pool, projectId, issueId);
      } catch (error) { throw ownedError(error); }
    },

    async listIssues(input: { readonly projectId: string; readonly actorUserId: string; readonly page: number;
      readonly pageSize: number; readonly status?: IssueStatus; readonly severity?: IssueRow["severity"];
      readonly approvalCaseId?: string; readonly assigneeUserId?: string }) {
      const projectId = ownId(input?.projectId);
      const actorUserId = ownId(input?.actorUserId);
      const parsed = issueListQuerySchema.safeParse({ page: input.page, pageSize: input.pageSize,
        approvalCaseId: input.approvalCaseId, status: input.status, severity: input.severity,
        assigneeUserId: input.assigneeUserId });
      if (!parsed.success) throw invalid();
      try {
        await requireRole(options.pool, projectId, actorUserId, "read");
        const values = [projectId, parsed.data.status ?? null, parsed.data.severity ?? null,
          parsed.data.assigneeUserId ?? null, parsed.data.approvalCaseId ?? null] as unknown[];
        const where = `issue.project_id=$1 AND ($2::text IS NULL OR issue.status=$2) AND
          ($3::text IS NULL OR issue.severity=$3) AND ($4::uuid IS NULL OR issue.assignee_user_id=$4) AND
          ($5::uuid IS NULL OR issue.approval_case_id=$5)`;
        const count = await options.pool.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM platform.issues issue WHERE ${where}`, values
        );
        values.push(parsed.data.pageSize, (parsed.data.page - 1) * parsed.data.pageSize);
        const rows = await options.pool.query<IssueRow>(
          `SELECT ${ISSUE_SELECT_COLUMNS} FROM platform.issues issue
           LEFT JOIN platform.annotations annotation ON annotation.id=issue.annotation_id
             AND annotation.approval_case_id=issue.approval_case_id
           WHERE ${where}
           ORDER BY CASE issue.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
             coalesce(issue.due_at,'infinity'::timestamptz),issue.created_at,issue.id LIMIT $6 OFFSET $7`, values
        );
        const total = count.rows[0]?.total ?? 0;
        return { items: rows.rows.map(mapIssue), page: { page: parsed.data.page, pageSize: parsed.data.pageSize,
          total, pageCount: Math.ceil(total / parsed.data.pageSize) } };
      } catch (error) { throw ownedError(error); }
    }
  });
}

type TransitionInput<T> = { readonly projectId: string; readonly issueId: string; readonly actorUserId: string;
  readonly requestId: string; readonly update: T };
type OwnedTransition<T> = { projectId: string; issueId: string; actorUserId: string; requestId: string; update: T };

async function transition<T extends StartIssueRequest | SubmitIssueRequest | ReviewIssueRequest | ForceCloseIssueRequest>(
  pool: PlatformPool, owned: OwnedTransition<T>, eventType: "started" | "submitted" | "returned" | "closed" | "force_closed",
  toStatus: IssueStatus) {
  try {
    return await withTransaction(pool, async (transaction) => {
      await lockKey(transaction, owned.update.idempotencyKey);
      const payloadHash = hash(owned.update);
      const retry = await transaction.query<{ issue_id: string; client_request_hash: Buffer }>(
        "SELECT issue_id,client_request_hash FROM platform.issue_events WHERE client_request_id=$1",
        [owned.update.idempotencyKey]
      );
      if (retry.rows[0]) {
        if (retry.rows[0].issue_id !== owned.issueId || !retry.rows[0].client_request_hash.equals(payloadHash)) {
          throw idempotency();
        }
        return loadIssue(transaction, owned.projectId, owned.issueId);
      }
      const issue = await lockIssue(transaction, owned.projectId, owned.issueId);
      const role = await requireRole(transaction, owned.projectId, owned.actorUserId,
        eventType === "force_closed" ? "force" : eventType === "closed" || eventType === "returned" ? "review" : "work");
      if ((eventType === "started" || eventType === "submitted") && issue.assignee_user_id !== owned.actorUserId) {
        throw forbidden();
      }
      if (issue.version !== owned.update.version || !validTransition(issue.status, eventType)) throw conflict();
      const note = "resolutionSummary" in owned.update ? owned.update.resolutionSummary
        : "note" in owned.update ? owned.update.note : "reason" in owned.update ? owned.update.reason : null;
      const closed = toStatus === "closed";
      const result = await transaction.query<IssueRow>(
        `UPDATE platform.issues SET status=$1,version=version+1,
           resolution_summary=CASE WHEN $2='submitted' THEN $3 ELSE resolution_summary END,
           review_note=CASE WHEN $2 IN ('closed','returned') THEN $3 ELSE review_note END,
           forced_close_reason=CASE WHEN $2='force_closed' THEN $3 ELSE forced_close_reason END,
           submitted_for_review_at=CASE WHEN $2='submitted' THEN clock_timestamp() ELSE submitted_for_review_at END,
           closed_by_user_id=CASE WHEN $4 THEN $5::uuid ELSE NULL END,
           closed_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
         WHERE id=$6 RETURNING ${ISSUE_COLUMNS}`,
        [toStatus, eventType, note, closed, owned.actorUserId, issue.id]
      );
      await appendEvent(transaction, { issueId: issue.id, actorUserId: owned.actorUserId, eventType,
        fromStatus: issue.status, toStatus, note, idempotencyKey: owned.update.idempotencyKey, payloadHash });
      await audit(transaction, owned.actorUserId, owned.requestId, `issue.${eventType}`, issue.id, owned.projectId,
        { oldStatus: issue.status, newStatus: toStatus });
      void role;
      return loadIssue(transaction, owned.projectId, result.rows[0]!.id);
    });
  } catch (error) { throw ownedError(error); }
}

function validTransition(status: IssueStatus, eventType: string) {
  if (eventType === "started") return status === "open";
  if (eventType === "submitted") return status === "in_progress";
  if (eventType === "closed" || eventType === "returned") return status === "review";
  return eventType === "force_closed" && status !== "closed";
}

async function requireRole(executor: QueryExecutor, projectId: string, userId: string,
  action: "read" | "create" | "work" | "review" | "force") {
  const result = await executor.query<{ role: ProjectRole }>(
    `SELECT membership.role FROM platform.project_members membership
     INNER JOIN platform.projects project ON project.id=membership.project_id AND project.status='active'
     INNER JOIN platform.users actor ON actor.id=membership.user_id AND actor.status='active'
     WHERE membership.project_id=$1 AND membership.user_id=$2 AND membership.status='active'`, [projectId, userId]
  );
  const role = result.rows[0]?.role;
  if (!role) throw notFound();
  if (action === "create" && role === "viewer" || action === "review" && !["supervisor", "process", "manager"].includes(role) ||
      action === "force" && role !== "manager") throw forbidden();
  return role;
}

async function lockIssue(executor: QueryExecutor, projectId: string, issueId: string) {
  const result = await executor.query<IssueRow>(
    `SELECT ${ISSUE_COLUMNS} FROM platform.issues WHERE project_id=$1 AND id=$2 FOR UPDATE`, [projectId, issueId]
  );
  if (!result.rows[0]) throw notFound();
  return result.rows[0];
}

async function loadIssue(executor: QueryExecutor, projectId: string, issueId: string) {
  const result = await executor.query<IssueRow>(
    `SELECT ${ISSUE_SELECT_COLUMNS} FROM platform.issues issue
     LEFT JOIN platform.annotations annotation ON annotation.id=issue.annotation_id
       AND annotation.approval_case_id=issue.approval_case_id
     WHERE issue.project_id=$1 AND issue.id=$2`, [projectId, issueId]
  );
  if (!result.rows[0]) throw notFound();
  return mapIssue(result.rows[0]);
}

async function appendEvent(executor: QueryExecutor, input: { issueId: string; actorUserId: string;
  eventType: string; fromStatus: IssueStatus | null; toStatus: IssueStatus; note: string | null;
  idempotencyKey: string; payloadHash: Buffer }) {
  await executor.query(
    `INSERT INTO platform.issue_events
      (id,issue_id,actor_user_id,event_type,from_status,to_status,note,client_request_id,client_request_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uuidV7(), input.issueId, input.actorUserId, input.eventType, input.fromStatus, input.toStatus,
      input.note, input.idempotencyKey, input.payloadHash]
  );
}

async function audit(executor: QueryExecutor, actorUserId: string, requestId: string, action: string,
  issueId: string, projectId: string, metadata: Record<string, string> = {}) {
  await new PostgresAuditRepository(executor).appendOnly({ actorUserId, actorType: "user", action,
    targetType: "issue", targetId: issueId, requestId, result: "success", metadata: { projectId, issueId, ...metadata } });
}

function ownCreate(input: { projectId: string; approvalId: string; actorUserId: string; requestId: string;
  issue: CreateIssueRequest }) {
  const parsed = createIssueRequestSchema.safeParse(input?.issue);
  if (!parsed.success) throw invalid();
  return { projectId: ownId(input?.projectId), approvalId: ownId(input?.approvalId),
    actorUserId: ownId(input?.actorUserId), requestId: ownRequestId(input?.requestId), issue: parsed.data };
}

function ownTransition<T>(input: TransitionInput<T>, schema: { safeParse(value: unknown):
  { success: true; data: T } | { success: false } }): OwnedTransition<T> {
  const parsed = schema.safeParse(input?.update);
  if (!parsed.success) throw invalid();
  return { projectId: ownId(input?.projectId), issueId: ownId(input?.issueId),
    actorUserId: ownId(input?.actorUserId), requestId: ownRequestId(input?.requestId), update: parsed.data };
}

function mapIssue(row: IssueRow) {
  return Object.freeze({ id: row.id, projectId: row.project_id, approvalCaseId: row.approval_case_id,
    annotationId: row.annotation_id, annotation: mapAnnotation(row), creatorUserId: row.creator_user_id,
    assigneeUserId: row.assignee_user_id,
    title: row.title, description: row.description, severity: row.severity, status: row.status,
    dueAt: row.due_at ? new Date(row.due_at) : null, version: row.version,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) });
}

const ISSUE_COLUMNS = `id,project_id,approval_case_id,annotation_id,creator_user_id,assignee_user_id,
  title,description,severity,status,due_at,version,created_at,updated_at`;
const ISSUE_SELECT_COLUMNS = `issue.id,issue.project_id,issue.approval_case_id,issue.annotation_id,
  issue.creator_user_id,issue.assignee_user_id,issue.title,issue.description,issue.severity,issue.status,
  issue.due_at,issue.version,issue.created_at,issue.updated_at,
  annotation.project_id AS annotation_project_id,
  annotation.approval_case_id AS annotation_approval_case_id,
  annotation.author_user_id AS annotation_author_user_id,
  annotation.kind AS annotation_kind,annotation.page_number AS annotation_page_number,
  annotation.geometry AS annotation_geometry,annotation.style AS annotation_style,
  annotation.message AS annotation_message,annotation.resolved AS annotation_resolved,
  annotation.version AS annotation_version,annotation.created_at AS annotation_created_at,
  annotation.updated_at AS annotation_updated_at`;

function mapAnnotation(row: IssueRow) {
  if (!row.annotation_id) return null;
  if (!row.annotation_project_id || !row.annotation_approval_case_id || !row.annotation_author_user_id ||
      !row.annotation_kind || !row.annotation_page_number || !row.annotation_geometry || !row.annotation_style ||
      !row.annotation_message || row.annotation_resolved === null || row.annotation_resolved === undefined ||
      !row.annotation_version || !row.annotation_created_at || !row.annotation_updated_at) {
    throw dependency();
  }
  return Object.freeze({ id: row.annotation_id, projectId: row.annotation_project_id,
    approvalCaseId: row.annotation_approval_case_id, authorUserId: row.annotation_author_user_id,
    kind: row.annotation_kind, pageNumber: row.annotation_page_number, geometry: row.annotation_geometry,
    style: row.annotation_style, message: row.annotation_message, resolved: row.annotation_resolved,
    version: row.annotation_version, createdAt: new Date(row.annotation_created_at),
    updatedAt: new Date(row.annotation_updated_at) });
}

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest(); }
async function lockKey(executor: QueryExecutor, key: string) {
  await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
}
function ownId(value: unknown) { const parsed = uuidV7Schema.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data; }
function ownRequestId(value: unknown) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 128 || /[\r\n\0]/.test(value)) throw invalid();
  return value;
}
function ownedError(error: unknown) { return error instanceof IssueServiceError ? error : dependency(error); }
function invalid() { return new IssueServiceError("ISSUE_INPUT_INVALID"); }
function forbidden() { return new IssueServiceError("ISSUE_FORBIDDEN"); }
function notFound() { return new IssueServiceError("ISSUE_NOT_FOUND"); }
function conflict() { return new IssueServiceError("ISSUE_STATE_CONFLICT"); }
function idempotency() { return new IssueServiceError("ISSUE_IDEMPOTENCY_CONFLICT"); }
function dependency(cause?: unknown) { return new IssueServiceError("ISSUE_DEPENDENCY_UNAVAILABLE", { cause }); }
