import type { DatabaseConnection } from "../db.ts";
import type { SQLInputValue } from "node:sqlite";
import {
  type Approval,
  type ApprovalSource,
  type ApprovalStatus,
  type CreateApprovalInput,
  type PdmMetadataStatus,
  type PdmPublishStatus,
  deriveApprovalStatus,
  type ReviewInput,
  type SignatureStatus
} from "../domain/approvals.ts";

type ApprovalRow = {
  id: number;
  project_name: string;
  part_name: string;
  version: string;
  minor_version: string;
  major_version: string;
  original_file_path: string;
  current_file_path: string;
  status: ApprovalStatus;
  submitted_by: string | null;
  submitted_by_user_id: number | null;
  source: ApprovalSource;
  original_file_hash: string | null;
  signed_file_path: string | null;
  signed_file_hash: string | null;
  signed_at: string | null;
  signature_status: SignatureStatus;
  signature_error: string | null;
  document_code: string | null;
  material_code: string | null;
  drawing_name: string | null;
  pdm_revision_id: number | null;
  pdm_metadata_status: PdmMetadataStatus;
  pdm_publish_status: PdmPublishStatus;
  pdm_publish_error: string | null;
  submitted_at: string;
  supervisor_status: "pending" | "approved" | "rejected";
  supervisor_comment: string | null;
  supervisor_reviewed_at: string | null;
  process_status: "pending" | "approved" | "rejected";
  process_comment: string | null;
  process_reviewed_at: string | null;
  printed_at: string | null;
  archived_at: string | null;
};

export class ApprovalRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(input: CreateApprovalInput): Approval {
    const documentCode = blankToNull(input.documentCode);
    const materialCode = blankToNull(input.materialCode);
    const drawingName = blankToNull(input.drawingName) ?? input.partName;
    const pdmMetadataStatus = input.pdmMetadataStatus ?? derivePdmMetadataStatus(documentCode, materialCode, drawingName);
    const pdmPublishStatus = input.pdmPublishStatus ?? (materialCode ? "pending" : "metadata_pending");
    const result = this.db
      .prepare(
        `INSERT INTO approvals (
          project_name, part_name, version, minor_version, major_version,
          original_file_path, current_file_path, status, submitted_by,
          submitted_by_user_id, source, original_file_hash, signature_status,
          document_code, material_code, drawing_name, pdm_metadata_status,
          pdm_publish_status, pdm_publish_error
        ) VALUES (
          @projectName, @partName, @version, @minorVersion, @majorVersion,
          @originalFilePath, @currentFilePath, @status, @submittedBy,
          @submittedByUserId, @source, @originalFileHash, @signatureStatus,
          @documentCode, @materialCode, @drawingName, @pdmMetadataStatus,
          @pdmPublishStatus, @pdmPublishError
        )`
      )
      .run({
        ...input,
        status: input.status ?? "pending",
        submittedBy: input.submittedBy ?? null,
        submittedByUserId: input.submittedByUserId ?? null,
        source: input.source ?? "folder_watch",
        originalFileHash: input.originalFileHash ?? null,
        signatureStatus: input.signatureStatus ?? "not_required",
        documentCode,
        materialCode,
        drawingName,
        pdmMetadataStatus,
        pdmPublishStatus,
        pdmPublishError: input.pdmPublishError ?? null
      });

    return this.getById(Number(result.lastInsertRowid))!;
  }

  list(filters: { status?: ApprovalStatus; signatureStatus?: SignatureStatus; reviewerRole?: "supervisor" | "process" } = {}): Approval[] {
    const { where, params } = buildListWhere(filters);
    const rows = this.db.prepare(`SELECT * FROM approvals ${where} ORDER BY submitted_at DESC, id DESC`).all(params) as ApprovalRow[];
    return rows.map(mapApproval);
  }

  listPaged(
    filters: {
      status?: ApprovalStatus;
      signatureStatus?: SignatureStatus;
      reviewerRole?: "supervisor" | "process";
      keyword?: string;
      page: number;
      pageSize: number;
    }
  ): { items: Approval[]; total: number; page: number; pageSize: number } {
    const pageSize = clampInteger(filters.pageSize, 1, 100, 20);
    const page = clampInteger(filters.page, 1, 100000, 1);
    const { where, params } = buildListWhere(filters);
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM approvals ${where}`).get(params) as { total: number };
    const rows = this.db
      .prepare(`SELECT * FROM approvals ${where} ORDER BY submitted_at DESC, id DESC LIMIT @limit OFFSET @offset`)
      .all({
        ...params,
        limit: pageSize,
        offset: (page - 1) * pageSize
      }) as ApprovalRow[];
    return { items: rows.map(mapApproval), total: totalRow.total, page, pageSize };
  }

  getById(id: number): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  }

  findVersion(projectName: string, partName: string, version: string): Approval | null {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE project_name = ? AND part_name = ? AND version = ?")
      .get(projectName, partName, version) as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  }

  findByCurrentFilePath(currentFilePath: string): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE current_file_path = ?").get(currentFilePath) as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  }

  listHistory(projectName: string, partName: string): Approval[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE project_name = ? AND part_name = ? ORDER BY submitted_at DESC, id DESC")
      .all(projectName, partName) as ApprovalRow[];
    return rows.map(mapApproval);
  }

  listVersions(projectName: string, partName: string, excludeId?: number): Approval[] {
    const conditions = ["project_name = @projectName", "part_name = @partName"];
    const params: Record<string, SQLInputValue> = { projectName, partName };
    if (excludeId !== undefined) {
      conditions.push("id != @excludeId");
      params.excludeId = excludeId;
    }

    const rows = this.db
      .prepare(`SELECT * FROM approvals WHERE ${conditions.join(" AND ")} ORDER BY submitted_at DESC, id DESC`)
      .all(params) as ApprovalRow[];
    return rows.map(mapApproval);
  }

  review(id: number, input: ReviewInput): Approval {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error("APPROVAL_NOT_FOUND");
    }

    if (existing.status !== "pending") {
      throw new Error("APPROVAL_NOT_REVIEWABLE");
    }

    if (input.decision === "rejected" && !input.comment?.trim() && !input.allowEmptyRejectComment) {
      throw new Error("REJECT_COMMENT_REQUIRED");
    }

    const supervisorStatus = input.role === "supervisor" ? input.decision : existing.supervisorStatus;
    const processStatus = input.role === "process" ? input.decision : existing.processStatus;
    const status = deriveApprovalStatus(supervisorStatus, processStatus);
    const now = new Date().toISOString();

    if (input.role === "supervisor") {
      this.db
        .prepare(
          `UPDATE approvals SET
            supervisor_status = @decision,
            supervisor_comment = @comment,
            supervisor_reviewed_at = @now,
            status = @status
          WHERE id = @id`
        )
        .run({ id, decision: input.decision, comment: input.comment ?? null, now, status });
    } else {
      this.db
        .prepare(
          `UPDATE approvals SET
            process_status = @decision,
            process_comment = @comment,
            process_reviewed_at = @now,
            status = @status
          WHERE id = @id`
        )
        .run({ id, decision: input.decision, comment: input.comment ?? null, now, status });
    }

    return this.getById(id)!;
  }

  updateFilePath(id: number, currentFilePath: string): Approval {
    this.db.prepare("UPDATE approvals SET current_file_path = ? WHERE id = ?").run(currentFilePath, id);
    return this.getById(id)!;
  }

  updateSignedFilePath(id: number, signedFilePath: string): Approval {
    this.db.prepare("UPDATE approvals SET signed_file_path = ? WHERE id = ?").run(signedFilePath, id);
    return this.getById(id)!;
  }

  rebindFile(id: number, currentFilePath: string, status: ApprovalStatus = "pending"): Approval {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error("APPROVAL_NOT_FOUND");
    }

    this.db.prepare("UPDATE approvals SET current_file_path = ?, status = ? WHERE id = ?").run(currentFilePath, status, id);
    return this.getById(id)!;
  }

  markFileMissing(id: number): Approval | null {
    const result = this.db.prepare("UPDATE approvals SET status = 'file_missing' WHERE id = ? AND status = 'pending'").run(id);
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  markInvalidPdf(id: number): Approval {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error("APPROVAL_NOT_FOUND");
    }

    this.db.prepare("UPDATE approvals SET status = 'invalid_pdf' WHERE id = ?").run(id);
    return this.getById(id)!;
  }

  voidApproval(id: number): Approval {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error("APPROVAL_NOT_FOUND");
    }

    this.db.prepare("UPDATE approvals SET status = 'voided' WHERE id = ?").run(id);
    return this.getById(id)!;
  }

  setSignatureStatus(id: number, status: SignatureStatus, error?: string | null): Approval {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error("APPROVAL_NOT_FOUND");
    }

    this.db
      .prepare("UPDATE approvals SET signature_status = ?, signature_error = ? WHERE id = ?")
      .run(status, error ?? null, id);
    return this.getById(id)!;
  }

  setSignedFile(id: number, signedFilePath: string, signedFileHash: string): Approval {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error("APPROVAL_NOT_FOUND");
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE approvals SET
          signed_file_path = ?,
          signed_file_hash = ?,
          signed_at = ?,
          signature_status = 'generated',
          signature_error = NULL
        WHERE id = ?`
      )
      .run(signedFilePath, signedFileHash, now, id);
    return this.getById(id)!;
  }

  markPrinted(id: number): Approval {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error("APPROVAL_NOT_FOUND");
    }
    if (existing.status !== "approved_for_print") {
      throw new Error("APPROVAL_NOT_PRINTABLE");
    }
    if (existing.signatureStatus !== "not_required" && (existing.signatureStatus !== "generated" || !existing.signedFilePath)) {
      throw new Error("SIGNED_PDF_REQUIRED");
    }

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE approvals SET status = 'printed_archived', printed_at = ?, archived_at = ? WHERE id = ?")
      .run(now, now, id);
    return this.getById(id)!;
  }

  delete(id: number): Approval {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error("APPROVAL_NOT_FOUND");
    }

    this.db.prepare("DELETE FROM approval_comments WHERE approval_id = ?").run(id);
    this.db.prepare("DELETE FROM approval_annotations WHERE approval_id = ?").run(id);
    this.db.prepare("DELETE FROM signature_placements WHERE approval_id = ?").run(id);
    this.db.prepare("DELETE FROM approvals WHERE id = ?").run(id);
    return existing;
  }
}

function buildListWhere(filters: {
  status?: ApprovalStatus;
  signatureStatus?: SignatureStatus;
  reviewerRole?: "supervisor" | "process";
  keyword?: string;
}) {
    const conditions: string[] = [];
    const params: Record<string, SQLInputValue> = {};

    if (filters.status) {
      conditions.push("status = @status");
      params.status = filters.status;
    }

    if (filters.signatureStatus) {
      conditions.push("signature_status = @signatureStatus");
      params.signatureStatus = filters.signatureStatus;
    }

    if (filters.reviewerRole === "supervisor") {
      conditions.push("status = 'pending'");
      conditions.push("supervisor_status = 'pending'");
    }

    if (filters.reviewerRole === "process") {
      conditions.push("status = 'pending'");
      conditions.push("process_status = 'pending'");
    }

    const keyword = filters.keyword?.trim();
    if (keyword) {
      conditions.push(
        `(project_name LIKE @keyword OR part_name LIKE @keyword OR version LIKE @keyword OR current_file_path LIKE @keyword
          OR document_code LIKE @keyword OR material_code LIKE @keyword OR drawing_name LIKE @keyword)`
      );
      params.keyword = `%${keyword}%`;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return { where, params };
}

function clampInteger(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    projectName: row.project_name,
    partName: row.part_name,
    version: row.version,
    minorVersion: row.minor_version,
    majorVersion: row.major_version,
    originalFilePath: row.original_file_path,
    currentFilePath: row.current_file_path,
    status: row.status,
    submittedBy: row.submitted_by,
    submittedByUserId: row.submitted_by_user_id,
    source: row.source,
    originalFileHash: row.original_file_hash,
    signedFilePath: row.signed_file_path,
    signedFileHash: row.signed_file_hash,
    signedAt: row.signed_at,
    signatureStatus: row.signature_status,
    signatureError: row.signature_error,
    documentCode: row.document_code,
    materialCode: row.material_code,
    drawingName: row.drawing_name,
    pdmRevisionId: row.pdm_revision_id,
    pdmMetadataStatus: row.pdm_metadata_status,
    pdmPublishStatus: row.pdm_publish_status,
    pdmPublishError: row.pdm_publish_error,
    submittedAt: row.submitted_at,
    supervisorStatus: row.supervisor_status,
    supervisorComment: row.supervisor_comment,
    supervisorReviewedAt: row.supervisor_reviewed_at,
    processStatus: row.process_status,
    processComment: row.process_comment,
    processReviewedAt: row.process_reviewed_at,
    printedAt: row.printed_at,
    archivedAt: row.archived_at
  };
}

function derivePdmMetadataStatus(
  documentCode: string | null,
  materialCode: string | null,
  drawingName: string | null
): PdmMetadataStatus {
  if (!drawingName) return "missing_required";
  if (!materialCode) return "missing_material_code";
  if (!documentCode) return "missing_document_code";
  return "complete";
}

function blankToNull(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
