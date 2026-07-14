import { v7 as uuidV7 } from "uuid";
import type { QueryResultRow } from "pg";
import {
  createDocumentDraftRequestSchema,
  reviewDecisionRequestSchema,
  submitRevisionRequestSchema,
  type CreateDocumentDraftRequest,
  type ReviewDecisionRequest,
  type SubmitRevisionRequest
} from "../../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import type { QueryExecutor } from "../../platform/database/queryExecutor.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { PostgresAuditRepository } from "../identity/repositories/postgres/PostgresAuditRepository.ts";
import { PostgresOutboxPublisher } from "../../platform/jobs/outboxPublisher.ts";

type ProjectRole = "manager" | "designer" | "supervisor" | "process" | "viewer";
type ApprovalAction = "submit" | "review" | "read";

type AccessRow = QueryResultRow & {
  role: ProjectRole;
  platform_role: "admin" | "member";
};

type RevisionRow = QueryResultRow & {
  id: string;
  project_id: string;
  document_id: string;
  revision_code: string;
  original_object_id: string;
  source: "web_upload" | "webdav_import" | "migration";
  status: "draft" | "submitted" | "approved" | "rejected" | "published" | "void";
  metadata_status: "complete" | "missing_material_code" | "missing_document_code" | "missing_required";
  material_code: string | null;
  version: number;
  created_by_user_id: string;
  submitted_at: Date | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  client_request_id: string | null;
};

type DocumentRow = QueryResultRow & {
  id: string;
  project_id: string;
  document_code: string;
  name: string;
  version: number;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

type ApprovalRow = QueryResultRow & {
  id: string;
  project_id: string;
  revision_id: string;
  status: "pending" | "approved" | "rejected" | "void";
  requires_signature: boolean;
  version: number;
  created_by_user_id: string;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  client_request_id: string | null;
};

type DecisionRow = QueryResultRow & {
  id: string;
  project_id: string;
  approval_case_id: string;
  reviewer_role: "supervisor" | "process";
  assigned_user_id: string;
  status: "pending" | "approved" | "rejected";
  comment: string | null;
  client_request_id: string | null;
  version: number;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const outbox = new PostgresOutboxPublisher({ createId: uuidV7, clock: () => new Date() });

export class ApprovalServiceError extends Error {
  constructor(readonly code:
    | "APPROVAL_INPUT_INVALID"
    | "APPROVAL_FORBIDDEN"
    | "APPROVAL_NOT_FOUND"
    | "APPROVAL_OBJECT_NOT_READY"
    | "APPROVAL_STATE_CONFLICT"
    | "APPROVAL_IDEMPOTENCY_CONFLICT"
    | "OPEN_HIGH_SEVERITY_ISSUES"
    | "APPROVAL_DEPENDENCY_UNAVAILABLE",
  options?: ErrorOptions) {
    super(code, options);
    this.name = "ApprovalServiceError";
  }
}

export function createApprovalService(options: { readonly pool: PlatformPool }) {
  if (!options?.pool) throw invalid();
  return Object.freeze({
    async createDraft(input: {
      readonly projectId: string;
      readonly actorUserId: string;
      readonly requestId: string;
      readonly draft: CreateDocumentDraftRequest;
    }) {
      const owned = ownCreateDraft(input);
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await requireAccess(transaction, owned.projectId, owned.actorUserId, "submit");
          await requireReadyPdfObject(transaction, owned.draft.originalObjectId);

          const existing = await findRevisionByClientRequest(transaction, owned.draft.idempotencyKey);
          if (existing) return assertDraftRetry(transaction, existing, owned);

          const documentId = uuidV7();
          await transaction.query(
            `INSERT INTO platform.documents
              (id,project_id,document_code,name,created_by_user_id)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (project_id,document_code) DO NOTHING`,
            [documentId, owned.projectId, owned.draft.documentCode, owned.draft.name, owned.actorUserId]
          );
          const document = await findDocumentByCode(transaction, owned.projectId, owned.draft.documentCode);
          if (!document) throw dependency();

          const revisionId = uuidV7();
          const inserted = await transaction.query<RevisionRow>(
            `INSERT INTO platform.drawing_revisions
              (id,project_id,document_id,revision_code,original_object_id,source,status,metadata_status,
               material_code,client_request_id,created_by_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [revisionId, owned.projectId, document.id, owned.draft.revisionCode,
              owned.draft.originalObjectId, owned.draft.source,
              owned.draft.materialCode ? "complete" : "missing_material_code",
              owned.draft.materialCode, owned.draft.idempotencyKey, owned.actorUserId]
          );
          const revision = inserted.rows[0] ?? await findRevisionByClientRequest(
            transaction, owned.draft.idempotencyKey
          );
          if (!revision) throw dependency();
          if (!inserted.rows[0]) return assertDraftRetry(transaction, revision, owned);

          await appendAudit(transaction, {
            actorUserId: owned.actorUserId,
            action: "document.revision.draft_created",
            targetType: "drawing_revision",
            targetId: revision.id,
            requestId: owned.requestId,
            metadata: { projectId: owned.projectId, documentId: document.id }
          });
          return Object.freeze({ document: mapDocument(document), revision: mapRevision(revision) });
        });
      } catch (error) {
        throw ownedError(error);
      }
    },

    async submitRevision(input: {
      readonly projectId: string;
      readonly revisionId: string;
      readonly actorUserId: string;
      readonly requestId: string;
      readonly submission: SubmitRevisionRequest;
    }) {
      const owned = ownSubmit(input);
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await requireAccess(transaction, owned.projectId, owned.actorUserId, "submit");
          const existing = await findApprovalByClientRequest(transaction, owned.submission.idempotencyKey);
          if (existing) {
            if (existing.project_id !== owned.projectId || existing.revision_id !== owned.revisionId) {
              throw idempotencyConflict();
            }
            return loadApproval(transaction, existing.id, owned.projectId);
          }

          const revision = await lockRevision(transaction, owned.projectId, owned.revisionId);
          if (!revision) throw notFound();
          if (revision.status !== "draft" || revision.version !== owned.submission.version) throw conflict();
          if (revision.created_by_user_id !== owned.actorUserId &&
              !(await isProjectManager(transaction, owned.projectId, owned.actorUserId))) throw forbidden();
          await requireReviewer(transaction, owned.projectId, owned.submission.supervisorUserId, "supervisor");
          await requireReviewer(transaction, owned.projectId, owned.submission.processUserId, "process");

          const approvalId = uuidV7();
          const inserted = await transaction.query<ApprovalRow>(
            `INSERT INTO platform.approval_cases
              (id,project_id,revision_id,status,requires_signature,client_request_id,created_by_user_id)
             VALUES ($1,$2,$3,'pending',$4,$5,$6)
             ON CONFLICT DO NOTHING RETURNING *`,
            [approvalId, owned.projectId, owned.revisionId, owned.submission.requiresSignature,
              owned.submission.idempotencyKey, owned.actorUserId]
          );
          if (!inserted.rows[0]) {
            const winner = await findApprovalByClientRequest(transaction, owned.submission.idempotencyKey);
            if (!winner || winner.project_id !== owned.projectId || winner.revision_id !== owned.revisionId) {
              throw idempotencyConflict();
            }
            return loadApproval(transaction, winner.id, owned.projectId);
          }

          await transaction.query(
            `INSERT INTO platform.review_decisions
              (id,project_id,approval_case_id,reviewer_role,assigned_user_id,status)
             VALUES ($1,$2,$3,'supervisor',$4,'pending'),($5,$2,$3,'process',$6,'pending')`,
            [uuidV7(), owned.projectId, approvalId, owned.submission.supervisorUserId,
              uuidV7(), owned.submission.processUserId]
          );
          for (const placement of owned.submission.placements) {
            await transaction.query(
              `INSERT INTO platform.signature_placements
                (id,project_id,approval_case_id,signer_role,page_number,x_ratio,y_ratio,width_ratio,height_ratio)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [uuidV7(), owned.projectId, approvalId, placement.signerRole, placement.pageNumber,
                placement.xRatio, placement.yRatio, placement.widthRatio, placement.heightRatio]
            );
          }
          await transaction.query(
            `UPDATE platform.drawing_revisions
             SET status='submitted',submitted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
             WHERE id=$1`,
            [owned.revisionId]
          );
          await appendAudit(transaction, {
            actorUserId: owned.actorUserId,
            action: "approval.submit",
            targetType: "approval_case",
            targetId: approvalId,
            requestId: owned.requestId,
            metadata: { projectId: owned.projectId, revisionId: owned.revisionId }
          });
          return loadApproval(transaction, approvalId, owned.projectId);
        });
      } catch (error) {
        throw ownedError(error);
      }
    },

    async decide(input: {
      readonly projectId: string;
      readonly approvalId: string;
      readonly actorUserId: string;
      readonly requestId: string;
      readonly reviewerRole: "supervisor" | "process";
      readonly decision: ReviewDecisionRequest;
    }) {
      const owned = ownDecision(input);
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await requireAccess(transaction, owned.projectId, owned.actorUserId, "review");
          const retry = await findDecisionByClientRequest(transaction, owned.decision.idempotencyKey);
          if (retry) {
            if (retry.project_id !== owned.projectId || retry.approval_case_id !== owned.approvalId ||
                retry.reviewer_role !== owned.reviewerRole || retry.status !== owned.decision.decision ||
                retry.comment !== owned.decision.comment) throw idempotencyConflict();
            return loadApproval(transaction, owned.approvalId, owned.projectId);
          }

          const approval = await lockApproval(transaction, owned.projectId, owned.approvalId);
          if (!approval) throw notFound();
          if (approval.status !== "pending") throw conflict();
          const decision = await lockDecision(transaction, owned.approvalId, owned.reviewerRole);
          if (!decision) throw notFound();
          const manager = await isProjectManager(transaction, owned.projectId, owned.actorUserId);
          if (decision.assigned_user_id !== owned.actorUserId && !manager) throw forbidden();
          if (decision.status !== "pending" || decision.version !== owned.decision.version) throw conflict();
          if (owned.decision.decision === "approved" && await countBlockingIssues(transaction, owned.approvalId) > 0) {
            throw new ApprovalServiceError("OPEN_HIGH_SEVERITY_ISSUES");
          }

          const updated = await transaction.query(
            `UPDATE platform.review_decisions
             SET status=$1,comment=$2,client_request_id=$3,decided_at=clock_timestamp(),
               version=version+1,updated_at=clock_timestamp()
             WHERE id=$4 AND version=$5`,
            [owned.decision.decision, owned.decision.comment, owned.decision.idempotencyKey,
              decision.id, owned.decision.version]
          );
          if (updated.rowCount !== 1) throw conflict();

          if (owned.decision.decision === "rejected") {
            await finishApproval(transaction, approval, "rejected");
          } else {
            const pending = await transaction.query<{ pending: number }>(
              `SELECT count(*) FILTER (WHERE status <> 'approved')::int AS pending
               FROM platform.review_decisions WHERE approval_case_id=$1`,
              [approval.id]
            );
            if (pending.rows[0]?.pending === 0) {
              await finishApproval(transaction, approval, "approved");
              await outbox.publishIdempotent(transaction, {
                eventType: "approval.completed",
                payloadVersion: 1,
                payload: { projectId: owned.projectId, approvalId: approval.id, revisionId: approval.revision_id }
              }, `approval.completed:${approval.id}`);
            }
          }
          await appendAudit(transaction, {
            actorUserId: owned.actorUserId,
            action: `approval.${owned.reviewerRole}.${owned.decision.decision}`,
            targetType: "approval_case",
            targetId: approval.id,
            requestId: owned.requestId,
            metadata: { projectId: owned.projectId, reviewerRole: owned.reviewerRole }
          });
          return loadApproval(transaction, approval.id, owned.projectId);
        });
      } catch (error) {
        throw ownedError(error);
      }
    },

    async getApproval(input: { readonly projectId: string; readonly approvalId: string; readonly actorUserId: string }) {
      const projectId = ownId(input?.projectId);
      const approvalId = ownId(input?.approvalId);
      const actorUserId = ownId(input?.actorUserId);
      try {
        await requireAccess(options.pool, projectId, actorUserId, "read");
        return await loadApproval(options.pool, approvalId, projectId);
      } catch (error) {
        throw ownedError(error);
      }
    },

    async listApprovals(input: { readonly projectId: string; readonly actorUserId: string;
      readonly page: number; readonly pageSize: number }) {
      const projectId = ownId(input?.projectId);
      const actorUserId = ownId(input?.actorUserId);
      const page = ownPositiveInt(input?.page, 100_000);
      const pageSize = ownPositiveInt(input?.pageSize, 100);
      try {
        await requireAccess(options.pool, projectId, actorUserId, "read");
        const count = await options.pool.query<{ total: number }>(
          "SELECT count(*)::int AS total FROM platform.approval_cases WHERE project_id=$1",
          [projectId]
        );
        const rows = await options.pool.query<{ id: string }>(
          `SELECT id FROM platform.approval_cases WHERE project_id=$1
           ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
          [projectId, pageSize, (page - 1) * pageSize]
        );
        const items = await Promise.all(rows.rows.map(({ id }) => loadApproval(options.pool, id, projectId)));
        const total = count.rows[0]?.total ?? 0;
        return Object.freeze({ items, page: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) } });
      } catch (error) {
        throw ownedError(error);
      }
    }
  });
}

async function requireAccess(executor: QueryExecutor, projectId: string, userId: string, action: ApprovalAction) {
  const result = await executor.query<AccessRow>(
    `SELECT pm.role,u.platform_role FROM platform.project_members pm
     INNER JOIN platform.projects p ON p.id=pm.project_id AND p.status='active'
     INNER JOIN platform.users u ON u.id=pm.user_id AND u.status='active'
     WHERE pm.project_id=$1 AND pm.user_id=$2 AND pm.status='active'`,
    [projectId, userId]
  );
  const access = result.rows[0];
  if (!access) throw notFound();
  const allowed = action === "read" || access.role === "manager" ||
    (action === "submit" && access.role === "designer") ||
    (action === "review" && ["supervisor", "process"].includes(access.role));
  if (!allowed) throw forbidden();
  return access;
}

async function isProjectManager(executor: QueryExecutor, projectId: string, userId: string) {
  const result = await executor.query<{ allowed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM platform.project_members pm
      INNER JOIN platform.users u ON u.id=pm.user_id AND u.status='active'
      WHERE pm.project_id=$1 AND pm.user_id=$2 AND pm.status='active' AND pm.role='manager') AS allowed`,
    [projectId, userId]
  );
  return result.rows[0]?.allowed === true;
}

async function requireReviewer(executor: QueryExecutor, projectId: string, userId: string,
  role: "supervisor" | "process") {
  const result = await executor.query<{ allowed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM platform.project_members pm
      INNER JOIN platform.users u ON u.id=pm.user_id AND u.status='active'
      WHERE pm.project_id=$1 AND pm.user_id=$2 AND pm.status='active' AND pm.role=$3) AS allowed`,
    [projectId, userId, role]
  );
  if (!result.rows[0]?.allowed) throw forbidden();
}

async function requireReadyPdfObject(executor: QueryExecutor, objectId: string) {
  const result = await executor.query<{ ready: boolean }>(
    `SELECT status='ready' AND media_type='application/pdf' AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AS ready
     FROM platform.storage_objects WHERE id=$1`,
    [objectId]
  );
  if (!result.rows[0]?.ready) throw new ApprovalServiceError("APPROVAL_OBJECT_NOT_READY");
}

function findDocumentByCode(executor: QueryExecutor, projectId: string, code: string) {
  return executor.query<DocumentRow>(
    "SELECT * FROM platform.documents WHERE project_id=$1 AND document_code=$2",
    [projectId, code]
  ).then(({ rows }) => rows[0]);
}

function findRevisionByClientRequest(executor: QueryExecutor, clientRequestId: string) {
  return executor.query<RevisionRow>(
    "SELECT * FROM platform.drawing_revisions WHERE client_request_id=$1",
    [clientRequestId]
  ).then(({ rows }) => rows[0]);
}

function findApprovalByClientRequest(executor: QueryExecutor, clientRequestId: string) {
  return executor.query<ApprovalRow>(
    "SELECT * FROM platform.approval_cases WHERE client_request_id=$1",
    [clientRequestId]
  ).then(({ rows }) => rows[0]);
}

function findDecisionByClientRequest(executor: QueryExecutor, clientRequestId: string) {
  return executor.query<DecisionRow>(
    "SELECT * FROM platform.review_decisions WHERE client_request_id=$1",
    [clientRequestId]
  ).then(({ rows }) => rows[0]);
}

function lockRevision(executor: QueryExecutor, projectId: string, revisionId: string) {
  return executor.query<RevisionRow>(
    "SELECT * FROM platform.drawing_revisions WHERE project_id=$1 AND id=$2 FOR UPDATE",
    [projectId, revisionId]
  ).then(({ rows }) => rows[0]);
}

function lockApproval(executor: QueryExecutor, projectId: string, approvalId: string) {
  return executor.query<ApprovalRow>(
    "SELECT * FROM platform.approval_cases WHERE project_id=$1 AND id=$2 FOR UPDATE",
    [projectId, approvalId]
  ).then(({ rows }) => rows[0]);
}

function lockDecision(executor: QueryExecutor, approvalId: string, reviewerRole: "supervisor" | "process") {
  return executor.query<DecisionRow>(
    "SELECT * FROM platform.review_decisions WHERE approval_case_id=$1 AND reviewer_role=$2 FOR UPDATE",
    [approvalId, reviewerRole]
  ).then(({ rows }) => rows[0]);
}

async function countBlockingIssues(executor: QueryExecutor, approvalId: string) {
  const result = await executor.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM platform.issues
     WHERE approval_case_id=$1 AND status <> 'closed' AND severity IN ('high','critical')`,
    [approvalId]
  );
  return result.rows[0]?.count ?? 0;
}

async function finishApproval(executor: QueryExecutor, approval: ApprovalRow, status: "approved" | "rejected") {
  await executor.query(
    `UPDATE platform.approval_cases
     SET status=$1,completed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
     WHERE id=$2`,
    [status, approval.id]
  );
  await executor.query(
    `UPDATE platform.drawing_revisions
     SET status=$1,version=version+1,updated_at=clock_timestamp() WHERE id=$2`,
    [status, approval.revision_id]
  );
}

async function loadApproval(executor: QueryExecutor, approvalId: string, projectId: string) {
  const cases = await executor.query<ApprovalRow>(
    "SELECT * FROM platform.approval_cases WHERE id=$1 AND project_id=$2",
    [approvalId, projectId]
  );
  const approval = cases.rows[0];
  if (!approval) throw notFound();
  const revisions = await executor.query<RevisionRow>(
    "SELECT * FROM platform.drawing_revisions WHERE id=$1 AND project_id=$2",
    [approval.revision_id, projectId]
  );
  const revision = revisions.rows[0];
  if (!revision) throw dependency();
  const documents = await executor.query<DocumentRow>(
    "SELECT * FROM platform.documents WHERE id=$1 AND project_id=$2",
    [revision.document_id, projectId]
  );
  const document = documents.rows[0];
  if (!document) throw dependency();
  const decisions = await executor.query<DecisionRow>(
    `SELECT * FROM platform.review_decisions WHERE approval_case_id=$1
     ORDER BY CASE reviewer_role WHEN 'supervisor' THEN 1 ELSE 2 END`,
    [approvalId]
  );
  if (decisions.rows.length !== 2) throw dependency();
  const artifacts = await executor.query<{ id: string; kind: "annotated_review" | "signed_pdf";
    generation: number; status: "pending" | "processing" | "ready" | "failed"; object_id: string | null;
    error_code: string | null; ready_at: Date | null }>(
    `SELECT id,kind,generation,status,object_id,error_code,ready_at FROM platform.render_artifacts
     WHERE approval_case_id=$1 ORDER BY kind,generation DESC,id DESC`, [approvalId]
  );
  return Object.freeze({
    id: approval.id,
    projectId: approval.project_id,
    revisionId: approval.revision_id,
    status: approval.status,
    requiresSignature: approval.requires_signature,
    version: approval.version,
    createdByUserId: approval.created_by_user_id,
    completedAt: cloneDate(approval.completed_at),
    createdAt: cloneDate(approval.created_at)!,
    updatedAt: cloneDate(approval.updated_at)!,
    document: mapDocument(document),
    revision: mapRevision(revision),
    decisions: decisions.rows.map(mapDecision),
    artifacts: artifacts.rows.map((artifact) => Object.freeze({ id: artifact.id, kind: artifact.kind,
      generation: artifact.generation, status: artifact.status, objectId: artifact.object_id,
      errorCode: artifact.error_code, readyAt: cloneDate(artifact.ready_at) }))
  });
}

async function assertDraftRetry(
  executor: QueryExecutor,
  revision: RevisionRow,
  owned: ReturnType<typeof ownCreateDraft>
) {
  if (revision.project_id !== owned.projectId || revision.revision_code !== owned.draft.revisionCode ||
      revision.original_object_id !== owned.draft.originalObjectId || revision.source !== owned.draft.source ||
      revision.material_code !== owned.draft.materialCode) throw idempotencyConflict();
  const result = await executor.query<DocumentRow>(
    "SELECT * FROM platform.documents WHERE id=$1 AND project_id=$2",
    [revision.document_id, revision.project_id]
  );
  const document = result.rows[0];
  if (!document || document.document_code !== owned.draft.documentCode || document.name !== owned.draft.name) {
    throw idempotencyConflict();
  }
  return Object.freeze({ document: mapDocument(document), revision: mapRevision(revision) });
}

function mapDocument(row: DocumentRow) {
  return Object.freeze({ id: row.id, projectId: row.project_id, documentCode: row.document_code, name: row.name,
    version: row.version, createdByUserId: row.created_by_user_id, createdAt: cloneDate(row.created_at)!,
    updatedAt: cloneDate(row.updated_at)! });
}

function mapRevision(row: RevisionRow) {
  return Object.freeze({ id: row.id, projectId: row.project_id, documentId: row.document_id,
    revisionCode: row.revision_code, originalObjectId: row.original_object_id, source: row.source,
    status: row.status, metadataStatus: row.metadata_status, materialCode: row.material_code,
    version: row.version, createdByUserId: row.created_by_user_id, submittedAt: cloneDate(row.submitted_at),
    publishedAt: cloneDate(row.published_at), createdAt: cloneDate(row.created_at)!, updatedAt: cloneDate(row.updated_at)! });
}

function mapDecision(row: DecisionRow) {
  return Object.freeze({ id: row.id, projectId: row.project_id, approvalCaseId: row.approval_case_id,
    reviewerRole: row.reviewer_role, assignedUserId: row.assigned_user_id, status: row.status,
    comment: row.comment, version: row.version, decidedAt: cloneDate(row.decided_at),
    createdAt: cloneDate(row.created_at)!, updatedAt: cloneDate(row.updated_at)! });
}

async function appendAudit(executor: QueryExecutor, input: {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  metadata: Record<string, unknown>;
}) {
  await new PostgresAuditRepository(executor).append({ ...input, actorType: "user", result: "success" });
}

function ownCreateDraft(input: { projectId: string; actorUserId: string; requestId: string;
  draft: CreateDocumentDraftRequest }) {
  const parsed = createDocumentDraftRequestSchema.safeParse(input?.draft);
  if (!parsed.success) throw invalid();
  return { projectId: ownId(input?.projectId), actorUserId: ownId(input?.actorUserId),
    requestId: ownRequestId(input?.requestId), draft: parsed.data } as const;
}

function ownSubmit(input: { projectId: string; revisionId: string; actorUserId: string; requestId: string;
  submission: SubmitRevisionRequest }) {
  const parsed = submitRevisionRequestSchema.safeParse(input?.submission);
  if (!parsed.success) throw invalid();
  return { projectId: ownId(input?.projectId), revisionId: ownId(input?.revisionId),
    actorUserId: ownId(input?.actorUserId), requestId: ownRequestId(input?.requestId), submission: parsed.data } as const;
}

function ownDecision(input: { projectId: string; approvalId: string; actorUserId: string; requestId: string;
  reviewerRole: "supervisor" | "process"; decision: ReviewDecisionRequest }) {
  const parsed = reviewDecisionRequestSchema.safeParse(input?.decision);
  if (!parsed.success || !["supervisor", "process"].includes(input?.reviewerRole)) throw invalid();
  return { projectId: ownId(input?.projectId), approvalId: ownId(input?.approvalId),
    actorUserId: ownId(input?.actorUserId), requestId: ownRequestId(input?.requestId),
    reviewerRole: input.reviewerRole, decision: parsed.data } as const;
}

function ownId(value: unknown) {
  const parsed = uuidV7Schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function ownRequestId(value: unknown) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 128 || /[\r\n\0]/.test(value)) {
    throw invalid();
  }
  return value;
}

function ownPositiveInt(value: unknown, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw invalid();
  return value as number;
}

function cloneDate(value: Date | null) {
  return value ? new Date(value) : null;
}

function ownedError(error: unknown) {
  if (error instanceof ApprovalServiceError) return error;
  return dependency(error);
}

function invalid() { return new ApprovalServiceError("APPROVAL_INPUT_INVALID"); }
function forbidden() { return new ApprovalServiceError("APPROVAL_FORBIDDEN"); }
function notFound() { return new ApprovalServiceError("APPROVAL_NOT_FOUND"); }
function conflict() { return new ApprovalServiceError("APPROVAL_STATE_CONFLICT"); }
function idempotencyConflict() { return new ApprovalServiceError("APPROVAL_IDEMPOTENCY_CONFLICT"); }
function dependency(cause?: unknown) {
  return new ApprovalServiceError("APPROVAL_DEPENDENCY_UNAVAILABLE", { cause });
}
