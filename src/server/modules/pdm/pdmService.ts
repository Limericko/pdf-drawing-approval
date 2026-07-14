import { createHash } from "node:crypto";
import { v7 as uuidV7 } from "uuid";
import type { QueryResultRow } from "pg";
import {
  pdmPartListQuerySchema,
  retryPdmPublishRequestSchema,
  updatePdmMetadataRequestSchema,
  voidPdmRevisionRequestSchema,
  type RetryPdmPublishRequest,
  type UpdatePdmMetadataRequest,
  type VoidPdmRevisionRequest
} from "../../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import type { QueryExecutor } from "../../platform/database/queryExecutor.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { PostgresAuditRepository } from "../identity/repositories/postgres/PostgresAuditRepository.ts";

type ProjectRole = "manager" | "designer" | "supervisor" | "process" | "viewer";
type AccessRow = QueryResultRow & { role: ProjectRole };

type PublishRow = QueryResultRow & {
  approval_id: string;
  project_id: string;
  approval_status: "pending" | "approved" | "rejected" | "void";
  requires_signature: boolean;
  revision_id: string;
  revision_status: string;
  revision_code: string;
  original_object_id: string;
  material_code: string | null;
  metadata_status: string;
  created_by_user_id: string;
  document_id: string;
  document_code: string;
  document_name: string;
};

type LinkRow = QueryResultRow & {
  id: string;
  project_id: string;
  part_id: string;
  revision_id: string;
  material_code: string | null;
  release_status: "pending_metadata" | "pending" | "published" | "failed" | "void";
  void_reason: string | null;
  version: number;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type PartSummaryRow = QueryResultRow & {
  id: string;
  project_id: string;
  part_number: string;
  name: string;
  current_revision_id: string | null;
  version: number;
  updated_at: Date;
  current_revision_code: string | null;
  release_status: LinkRow["release_status"] | null;
  material_code: string | null;
};

type PartRevisionRow = LinkRow & {
  revision_code: string;
  document_id: string;
  document_code: string;
  approval_case_id: string;
  original_object_id: string;
  signed_object_id: string | null;
  annotated_object_id: string | null;
};

type MutationRow = QueryResultRow & {
  part_revision_link_id: string;
  action: "metadata_update" | "publish_retry" | "void";
  payload_hash: Buffer;
  result_version: number;
};

export class PdmServiceError extends Error {
  constructor(readonly code:
    | "PDM_INPUT_INVALID"
    | "PDM_FORBIDDEN"
    | "PDM_NOT_FOUND"
    | "PDM_STATE_CONFLICT"
    | "PDM_IDEMPOTENCY_CONFLICT"
    | "PDM_SOURCE_NOT_READY"
    | "PDM_DEPENDENCY_UNAVAILABLE",
  options?: ErrorOptions) {
    super(code, options);
    this.name = "PdmServiceError";
  }
}

export function createPdmService(options: { readonly pool: PlatformPool }) {
  if (!options?.pool) throw invalid();
  return Object.freeze({
    async publishApprovedRevision(input: {
      readonly projectId: string;
      readonly approvalId: string;
      readonly requestId: string;
      readonly actorUserId?: string | null;
    }) {
      const projectId = ownId(input?.projectId);
      const approvalId = ownId(input?.approvalId);
      const requestId = ownRequestId(input?.requestId);
      const actorUserId = input?.actorUserId == null ? null : ownId(input.actorUserId);
      try {
        return await withTransaction(options.pool, async (transaction) => {
          if (actorUserId) await requireAccess(transaction, projectId, actorUserId, "edit");
          const result = await publishInTransaction(transaction, projectId, approvalId);
          if (result.changed) {
            await appendAudit(transaction, {
              actorUserId,
              actorType: actorUserId ? "user" : "worker",
              action: "pdm.revision.publish",
              targetType: "part_revision",
              targetId: result.link.id,
              requestId,
              metadata: { projectId, revisionId: result.link.revision_id, partId: result.link.part_id,
                newStatus: result.link.release_status }
            });
          }
          return loadPartDetail(transaction, projectId, result.link.part_id);
        });
      } catch (error) {
        throw ownedError(error);
      }
    },

    async updateMetadata(input: {
      readonly projectId: string;
      readonly linkId: string;
      readonly actorUserId: string;
      readonly requestId: string;
      readonly update: UpdatePdmMetadataRequest;
    }) {
      const owned = ownMutation(input, updatePdmMetadataRequestSchema, "metadata_update");
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await lockIdempotencyKey(transaction, owned.update.idempotencyKey);
          const link = await lockLink(transaction, owned.projectId, owned.linkId);
          if (!link) throw notFound();
          const payloadHash = hashPayload({ materialCode: owned.update.materialCode, version: owned.update.version });
          if (await isMutationRetry(transaction, link.id, "metadata_update",
              owned.update.idempotencyKey, payloadHash)) {
            return loadPartDetail(transaction, owned.projectId, link.part_id);
          }
          await requireLinkEditor(transaction, link, owned.actorUserId);
          if (link.release_status === "published" || link.release_status === "void" ||
              link.version !== owned.update.version) throw conflict();

          await transaction.query(
            `UPDATE platform.part_revision_links
             SET material_code=$1,release_status='pending',version=version+1,updated_at=clock_timestamp()
             WHERE id=$2`,
            [owned.update.materialCode, link.id]
          );
          await transaction.query(
            `UPDATE platform.drawing_revisions
             SET material_code=$1,metadata_status='complete',version=version+1,updated_at=clock_timestamp()
             WHERE id=$2`,
            [owned.update.materialCode, link.revision_id]
          );
          const approval = await approvalIdForRevision(transaction, link.revision_id);
          const published = await publishInTransaction(transaction, owned.projectId, approval);
          await recordMutation(transaction, owned.projectId, link.id, "metadata_update",
            owned.update.idempotencyKey, payloadHash, published.link.version);
          await appendAudit(transaction, {
            actorUserId: owned.actorUserId,
            actorType: "user",
            action: "pdm.metadata.update",
            targetType: "part_revision",
            targetId: link.id,
            requestId: owned.requestId,
            metadata: { projectId: owned.projectId, revisionId: link.revision_id, partId: link.part_id }
          });
          return loadPartDetail(transaction, owned.projectId, link.part_id);
        });
      } catch (error) {
        throw ownedError(error);
      }
    },

    async retryPublish(input: {
      readonly projectId: string;
      readonly linkId: string;
      readonly actorUserId: string;
      readonly requestId: string;
      readonly retry: RetryPdmPublishRequest;
    }) {
      const owned = ownMutation({ ...input, update: input.retry }, retryPdmPublishRequestSchema, "publish_retry");
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await lockIdempotencyKey(transaction, owned.update.idempotencyKey);
          const link = await lockLink(transaction, owned.projectId, owned.linkId);
          if (!link) throw notFound();
          const payloadHash = hashPayload({ version: owned.update.version });
          if (await isMutationRetry(transaction, link.id, "publish_retry",
              owned.update.idempotencyKey, payloadHash)) {
            return loadPartDetail(transaction, owned.projectId, link.part_id);
          }
          await requireLinkEditor(transaction, link, owned.actorUserId);
          if (link.release_status === "void" || link.version !== owned.update.version) throw conflict();
          const approval = await approvalIdForRevision(transaction, link.revision_id);
          const published = await publishInTransaction(transaction, owned.projectId, approval);
          await recordMutation(transaction, owned.projectId, link.id, "publish_retry",
            owned.update.idempotencyKey, payloadHash, published.link.version);
          await appendAudit(transaction, {
            actorUserId: owned.actorUserId,
            actorType: "user",
            action: "pdm.revision.retry",
            targetType: "part_revision",
            targetId: link.id,
            requestId: owned.requestId,
            metadata: { projectId: owned.projectId, revisionId: link.revision_id, partId: link.part_id,
              newStatus: published.link.release_status }
          });
          return loadPartDetail(transaction, owned.projectId, link.part_id);
        });
      } catch (error) {
        throw ownedError(error);
      }
    },

    async voidRevision(input: {
      readonly projectId: string;
      readonly linkId: string;
      readonly actorUserId: string;
      readonly requestId: string;
      readonly update: VoidPdmRevisionRequest;
    }) {
      const owned = ownMutation(input, voidPdmRevisionRequestSchema, "void");
      try {
        return await withTransaction(options.pool, async (transaction) => {
          await lockIdempotencyKey(transaction, owned.update.idempotencyKey);
          const link = await lockLink(transaction, owned.projectId, owned.linkId);
          if (!link) throw notFound();
          const payloadHash = hashPayload({ reason: owned.update.reason, version: owned.update.version });
          if (await isMutationRetry(transaction, link.id, "void", owned.update.idempotencyKey, payloadHash)) {
            return loadPartDetail(transaction, owned.projectId, link.part_id);
          }
          await requireAccess(transaction, owned.projectId, owned.actorUserId, "void");
          if (link.release_status === "void" || link.version !== owned.update.version) throw conflict();
          const updated = await transaction.query<LinkRow>(
            `UPDATE platform.part_revision_links
             SET release_status='void',void_reason=$1,version=version+1,updated_at=clock_timestamp()
             WHERE id=$2 RETURNING *`,
            [owned.update.reason, link.id]
          );
          const nextCurrent = await transaction.query<{ revision_id: string }>(
            `SELECT revision_id FROM platform.part_revision_links
             WHERE part_id=$1 AND id<>$2 AND release_status='published'
             ORDER BY released_at DESC,id DESC LIMIT 1`,
            [link.part_id, link.id]
          );
          await transaction.query(
            `UPDATE platform.parts SET current_revision_id=$1,version=version+1,updated_at=clock_timestamp()
             WHERE id=$2 AND current_revision_id=$3`,
            [nextCurrent.rows[0]?.revision_id ?? null, link.part_id, link.revision_id]
          );
          await recordMutation(transaction, owned.projectId, link.id, "void", owned.update.idempotencyKey,
            payloadHash, updated.rows[0]!.version);
          await appendAudit(transaction, {
            actorUserId: owned.actorUserId,
            actorType: "user",
            action: "pdm.revision.void",
            targetType: "part_revision",
            targetId: link.id,
            requestId: owned.requestId,
            metadata: { projectId: owned.projectId, revisionId: link.revision_id,
              partId: link.part_id, reason: owned.update.reason }
          });
          return loadPartDetail(transaction, owned.projectId, link.part_id);
        });
      } catch (error) {
        throw ownedError(error);
      }
    },

    async listParts(input: { readonly projectId: string; readonly actorUserId: string;
      readonly page: number; readonly pageSize: number; readonly keyword?: string;
      readonly releaseStatus?: LinkRow["release_status"]; readonly sort?: "updated_desc" | "part_number_asc" }) {
      const projectId = ownId(input?.projectId);
      const actorUserId = ownId(input?.actorUserId);
      const parsed = pdmPartListQuerySchema.safeParse({ page: input?.page, pageSize: input?.pageSize,
        ...(input?.keyword ? { keyword: input.keyword } : {}),
        ...(input?.releaseStatus ? { releaseStatus: input.releaseStatus } : {}),
        ...(input?.sort ? { sort: input.sort } : {}) });
      if (!parsed.success) throw invalid();
      try {
        await requireAccess(options.pool, projectId, actorUserId, "read");
        const keyword = parsed.data.keyword ? `%${escapeLike(parsed.data.keyword)}%` : null;
        const count = await options.pool.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM platform.parts part
           LEFT JOIN LATERAL (
             SELECT candidate.* FROM platform.part_revision_links candidate
             WHERE candidate.part_id=part.id
             ORDER BY (candidate.revision_id=part.current_revision_id) DESC,candidate.updated_at DESC,candidate.id DESC
             LIMIT 1
           ) link ON true
           WHERE part.project_id=$1
             AND ($2::text IS NULL OR part.part_number ILIKE $2 ESCAPE '\\' OR part.name ILIKE $2 ESCAPE '\\')
             AND ($3::text IS NULL OR link.release_status=$3)`,
          [projectId, keyword, parsed.data.releaseStatus ?? null]
        );
        const orderBy = parsed.data.sort === "part_number_asc"
          ? "part.part_number ASC,part.id ASC"
          : "part.updated_at DESC,part.id DESC";
        const result = await options.pool.query<PartSummaryRow>(partSummarySelect(
          `WHERE part.project_id=$1 AND ($2::text IS NULL OR part.part_number ILIKE $2 ESCAPE '\\'
             OR part.name ILIKE $2 ESCAPE '\\') AND ($3::text IS NULL OR link.release_status=$3)
           ORDER BY ${orderBy} LIMIT $4 OFFSET $5`
        ), [projectId, keyword, parsed.data.releaseStatus ?? null, parsed.data.pageSize,
          (parsed.data.page - 1) * parsed.data.pageSize]);
        const total = count.rows[0]?.total ?? 0;
        return Object.freeze({ items: result.rows.map(mapPartSummary), page: { page: parsed.data.page,
          pageSize: parsed.data.pageSize, total, pageCount: Math.ceil(total / parsed.data.pageSize) } });
      } catch (error) {
        throw ownedError(error);
      }
    },

    async getPart(input: { readonly projectId: string; readonly partId: string; readonly actorUserId: string }) {
      const projectId = ownId(input?.projectId);
      const partId = ownId(input?.partId);
      const actorUserId = ownId(input?.actorUserId);
      try {
        await requireAccess(options.pool, projectId, actorUserId, "read");
        return await loadPartDetail(options.pool, projectId, partId);
      } catch (error) {
        throw ownedError(error);
      }
    }
  });
}

async function publishInTransaction(executor: QueryExecutor, projectId: string, approvalId: string) {
  await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [approvalId]);
  const sourceResult = await executor.query<PublishRow>(
    `SELECT approval.id AS approval_id,approval.project_id,approval.status AS approval_status,
       approval.requires_signature,revision.id AS revision_id,revision.status AS revision_status,
       revision.revision_code,revision.original_object_id,revision.material_code,revision.metadata_status,
       revision.created_by_user_id,document.id AS document_id,document.document_code,document.name AS document_name
     FROM platform.approval_cases approval
     INNER JOIN platform.drawing_revisions revision ON revision.id=approval.revision_id
     INNER JOIN platform.documents document ON document.id=revision.document_id
     INNER JOIN platform.storage_objects source ON source.id=revision.original_object_id AND source.status='ready'
     WHERE approval.id=$1 AND approval.project_id=$2`,
    [approvalId, projectId]
  );
  const source = sourceResult.rows[0];
  if (!source) throw new PdmServiceError("PDM_SOURCE_NOT_READY");
  if (source.approval_status !== "approved" || !["approved", "published"].includes(source.revision_status)) {
    throw conflict();
  }

  const existing = await executor.query<LinkRow>(
    "SELECT * FROM platform.part_revision_links WHERE revision_id=$1 FOR UPDATE",
    [source.revision_id]
  );
  let link = existing.rows[0];
  let changed = false;
  if (!link) {
    await executor.query(
      `INSERT INTO platform.parts (id,project_id,part_number,name)
       VALUES ($1,$2,$3,$4) ON CONFLICT (project_id,part_number) DO NOTHING`,
      [uuidV7(), projectId, source.document_code, source.document_name]
    );
    const part = await executor.query<{ id: string }>(
      "SELECT id FROM platform.parts WHERE project_id=$1 AND part_number=$2",
      [projectId, source.document_code]
    );
    const partId = part.rows[0]?.id;
    if (!partId) throw dependency();
    const created = await executor.query<LinkRow>(
      `INSERT INTO platform.part_revision_links
        (id,project_id,part_id,revision_id,material_code,release_status)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (revision_id) DO NOTHING RETURNING *`,
      [uuidV7(), projectId, partId, source.revision_id, source.material_code,
        source.metadata_status === "complete" && source.material_code ? "pending" : "pending_metadata"]
    );
    link = created.rows[0] ?? (await executor.query<LinkRow>(
      "SELECT * FROM platform.part_revision_links WHERE revision_id=$1 FOR UPDATE",
      [source.revision_id]
    )).rows[0];
    changed = Boolean(created.rows[0]);
  }
  if (!link) throw dependency();
  if (link.release_status === "void") throw conflict();
  if (link.release_status === "published") return { link, source, changed };

  if (source.metadata_status !== "complete" || !source.material_code || !link.material_code) {
    if (link.release_status !== "pending_metadata") {
      link = (await executor.query<LinkRow>(
        `UPDATE platform.part_revision_links
         SET release_status='pending_metadata',version=version+1,updated_at=clock_timestamp()
         WHERE id=$1 RETURNING *`, [link.id]
      )).rows[0]!;
      changed = true;
    }
    return { link, source, changed };
  }

  const artifacts = await executor.query<{ signed_object_id: string | null; annotated_object_id: string | null }>(
    `SELECT
       (SELECT object_id FROM platform.render_artifacts WHERE approval_case_id=$1
         AND kind='signed_pdf' AND status='ready' ORDER BY generation DESC LIMIT 1) AS signed_object_id,
       (SELECT object_id FROM platform.render_artifacts WHERE approval_case_id=$1
         AND kind='annotated_review' AND status='ready' ORDER BY generation DESC LIMIT 1) AS annotated_object_id`,
    [approvalId]
  );
  const signedObjectId = artifacts.rows[0]?.signed_object_id ?? null;
  if (source.requires_signature && !signedObjectId) {
    if (link.release_status !== "pending") {
      link = (await executor.query<LinkRow>(
        `UPDATE platform.part_revision_links
         SET release_status='pending',version=version+1,updated_at=clock_timestamp()
         WHERE id=$1 RETURNING *`, [link.id]
      )).rows[0]!;
      changed = true;
    }
    return { link, source, changed };
  }

  link = (await executor.query<LinkRow>(
    `UPDATE platform.part_revision_links
     SET release_status='published',released_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
     WHERE id=$1 RETURNING *`, [link.id]
  )).rows[0]!;
  changed = true;
  await executor.query(
    `UPDATE platform.parts SET current_revision_id=$1,version=version+1,updated_at=clock_timestamp()
     WHERE id=$2`, [source.revision_id, link.part_id]
  );
  if (source.revision_status !== "published") {
    await executor.query(
      `UPDATE platform.drawing_revisions
       SET status='published',published_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
       WHERE id=$1`, [source.revision_id]
    );
  }
  await executor.query(
    `INSERT INTO platform.part_usages
      (id,project_id,part_id,used_in_project_id,first_approval_case_id,last_approval_case_id)
     VALUES ($1,$2,$3,$2,$4,$4)
     ON CONFLICT (part_id,used_in_project_id) DO UPDATE
       SET last_approval_case_id=EXCLUDED.last_approval_case_id,updated_at=clock_timestamp()`,
    [uuidV7(), projectId, link.part_id, approvalId]
  );
  return { link, source, changed };
}

async function loadPartDetail(executor: QueryExecutor, projectId: string, partId: string) {
  const parts = await executor.query<PartSummaryRow>(partSummarySelect(
    "WHERE part.project_id=$1 AND part.id=$2"
  ), [projectId, partId]);
  const part = parts.rows[0];
  if (!part) throw notFound();
  const revisions = await executor.query<PartRevisionRow>(
    `SELECT link.*,revision.revision_code,revision.document_id,document.document_code,
       approval.id AS approval_case_id,revision.original_object_id,
       (SELECT object_id FROM platform.render_artifacts WHERE approval_case_id=approval.id
         AND kind='signed_pdf' AND status='ready' ORDER BY generation DESC LIMIT 1) AS signed_object_id,
       (SELECT object_id FROM platform.render_artifacts WHERE approval_case_id=approval.id
         AND kind='annotated_review' AND status='ready' ORDER BY generation DESC LIMIT 1) AS annotated_object_id
     FROM platform.part_revision_links link
     INNER JOIN platform.drawing_revisions revision ON revision.id=link.revision_id
     INNER JOIN platform.documents document ON document.id=revision.document_id
     INNER JOIN platform.approval_cases approval ON approval.revision_id=revision.id
     WHERE link.project_id=$1 AND link.part_id=$2
     ORDER BY coalesce(link.released_at,link.created_at) DESC,link.id DESC`,
    [projectId, partId]
  );
  const usages = await executor.query<{
    project_id: string; project_name: string; first_approval_case_id: string;
    last_approval_case_id: string; updated_at: Date;
  }>(
    `SELECT usage.used_in_project_id AS project_id,project.name AS project_name,
       usage.first_approval_case_id,usage.last_approval_case_id,usage.updated_at
     FROM platform.part_usages usage
     INNER JOIN platform.projects project ON project.id=usage.used_in_project_id
     WHERE usage.part_id=$1 ORDER BY project.name,project.id`,
    [partId]
  );
  return Object.freeze({
    part: mapPartSummary(part),
    revisions: revisions.rows.map(mapPartRevision),
    usages: usages.rows.map((usage) => ({ projectId: usage.project_id, projectName: usage.project_name,
      firstApprovalCaseId: usage.first_approval_case_id, lastApprovalCaseId: usage.last_approval_case_id,
      updatedAt: cloneDate(usage.updated_at)! }))
  });
}

function partSummarySelect(suffix: string) {
  return `SELECT part.id,part.project_id,part.part_number,part.name,part.current_revision_id,
    part.version,part.updated_at,revision.revision_code AS current_revision_code,
    link.release_status,link.material_code
    FROM platform.parts part
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM platform.part_revision_links candidate
      WHERE candidate.part_id=part.id
      ORDER BY (candidate.revision_id=part.current_revision_id) DESC,candidate.updated_at DESC,candidate.id DESC
      LIMIT 1
    ) link ON true
    LEFT JOIN platform.drawing_revisions revision ON revision.id=link.revision_id
    ${suffix}`;
}

function mapPartSummary(row: PartSummaryRow) {
  return Object.freeze({ id: row.id, projectId: row.project_id, partNumber: row.part_number,
    name: row.name, currentRevisionId: row.current_revision_id,
    currentRevisionCode: row.current_revision_code, releaseStatus: row.release_status,
    materialCode: row.material_code, version: row.version, updatedAt: cloneDate(row.updated_at)! });
}

function mapPartRevision(row: PartRevisionRow) {
  return Object.freeze({ linkId: row.id, revisionId: row.revision_id, revisionCode: row.revision_code,
    documentId: row.document_id, documentCode: row.document_code, approvalCaseId: row.approval_case_id,
    originalObjectId: row.original_object_id, signedObjectId: row.signed_object_id,
    annotatedObjectId: row.annotated_object_id, materialCode: row.material_code,
    releaseStatus: row.release_status, voidReason: row.void_reason, version: row.version,
    releasedAt: cloneDate(row.released_at), createdAt: cloneDate(row.created_at)!,
    updatedAt: cloneDate(row.updated_at)! });
}

async function requireAccess(executor: QueryExecutor, projectId: string, userId: string,
  action: "read" | "edit" | "void") {
  const result = await executor.query<AccessRow>(
    `SELECT membership.role FROM platform.project_members membership
     INNER JOIN platform.projects project ON project.id=membership.project_id AND project.status='active'
     INNER JOIN platform.users actor ON actor.id=membership.user_id AND actor.status='active'
     WHERE membership.project_id=$1 AND membership.user_id=$2 AND membership.status='active'`,
    [projectId, userId]
  );
  const role = result.rows[0]?.role;
  if (!role) throw notFound();
  if (action === "void" && role !== "manager") throw forbidden();
  if (action === "edit" && !["manager", "designer"].includes(role)) throw forbidden();
  return role;
}

async function requireLinkEditor(executor: QueryExecutor, link: LinkRow, userId: string) {
  const role = await requireAccess(executor, link.project_id, userId, "edit");
  if (role === "manager") return;
  const revision = await executor.query<{ created_by_user_id: string }>(
    "SELECT created_by_user_id FROM platform.drawing_revisions WHERE id=$1",
    [link.revision_id]
  );
  if (revision.rows[0]?.created_by_user_id !== userId) throw forbidden();
}

function lockLink(executor: QueryExecutor, projectId: string, linkId: string) {
  return executor.query<LinkRow>(
    "SELECT * FROM platform.part_revision_links WHERE project_id=$1 AND id=$2 FOR UPDATE",
    [projectId, linkId]
  ).then(({ rows }) => rows[0]);
}

async function approvalIdForRevision(executor: QueryExecutor, revisionId: string) {
  const result = await executor.query<{ id: string }>(
    "SELECT id FROM platform.approval_cases WHERE revision_id=$1",
    [revisionId]
  );
  if (!result.rows[0]) throw notFound();
  return result.rows[0].id;
}

async function lockIdempotencyKey(executor: QueryExecutor, key: string) {
  await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
}

async function isMutationRetry(executor: QueryExecutor, linkId: string,
  action: MutationRow["action"], clientRequestId: string, payloadHash: Buffer) {
  const result = await executor.query<MutationRow>(
    `SELECT part_revision_link_id,action,payload_hash,result_version
     FROM platform.pdm_mutation_requests WHERE client_request_id=$1`,
    [clientRequestId]
  );
  const row = result.rows[0];
  if (!row) return false;
  if (row.part_revision_link_id !== linkId || row.action !== action || !row.payload_hash.equals(payloadHash)) {
    throw idempotencyConflict();
  }
  return true;
}

async function recordMutation(executor: QueryExecutor, projectId: string, linkId: string,
  action: MutationRow["action"], clientRequestId: string, payloadHash: Buffer, resultVersion: number) {
  await executor.query(
    `INSERT INTO platform.pdm_mutation_requests
      (id,project_id,part_revision_link_id,action,client_request_id,payload_hash,result_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uuidV7(), projectId, linkId, action, clientRequestId, payloadHash, resultVersion]
  );
}

function hashPayload(value: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

async function appendAudit(executor: QueryExecutor, input: {
  actorUserId: string | null;
  actorType: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  metadata: Record<string, string | number | boolean | null>;
}) {
  await new PostgresAuditRepository(executor).appendOnly({ ...input, result: "success" });
}

function ownMutation<T extends UpdatePdmMetadataRequest | VoidPdmRevisionRequest | RetryPdmPublishRequest>(
  input: { projectId: string; linkId: string; actorUserId: string; requestId: string; update: T },
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  _action: MutationRow["action"]
) {
  const parsed = schema.safeParse(input?.update);
  if (!parsed.success) throw invalid();
  return { projectId: ownId(input?.projectId), linkId: ownId(input?.linkId),
    actorUserId: ownId(input?.actorUserId), requestId: ownRequestId(input?.requestId), update: parsed.data };
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

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function cloneDate(value: Date | null) {
  return value ? new Date(value) : null;
}

function ownedError(error: unknown) {
  if (error instanceof PdmServiceError) return error;
  return dependency(error);
}

function invalid() { return new PdmServiceError("PDM_INPUT_INVALID"); }
function forbidden() { return new PdmServiceError("PDM_FORBIDDEN"); }
function notFound() { return new PdmServiceError("PDM_NOT_FOUND"); }
function conflict() { return new PdmServiceError("PDM_STATE_CONFLICT"); }
function idempotencyConflict() { return new PdmServiceError("PDM_IDEMPOTENCY_CONFLICT"); }
function dependency(cause?: unknown) {
  return new PdmServiceError("PDM_DEPENDENCY_UNAVAILABLE", { cause });
}
