import type { DatabaseConnection } from "../db.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type {
  PdmDrawingRevision,
  PdmMetadataStatus,
  PdmPart,
  PdmPartRepository,
  PdmPublishStatus
} from "../repositories/pdmParts.ts";

export type PdmReleaseResult = {
  status: "published" | "metadata_pending" | "failed" | "skipped" | "not_found";
  part?: PdmPart;
  revision?: PdmDrawingRevision;
  reason?: string;
  error?: string;
};

export type PdmMetadataRepairResult = {
  approvalId: number;
  documentCode: string | null;
  materialCode: string | null;
  drawingName: string;
  metadataStatus: PdmMetadataStatus;
  publishStatus: PdmPublishStatus;
};

type ApprovalPdmRow = {
  id: number;
  document_code: string | null;
  material_code: string | null;
  drawing_name: string | null;
  pdm_revision_id: number | null;
  pdm_metadata_status: PdmMetadataStatus;
  pdm_publish_status: PdmPublishStatus;
  pdm_publish_error: string | null;
};

export class PdmReleaseService {
  constructor(
    private readonly deps: {
      db: DatabaseConnection;
      approvals: ApprovalRepository;
      pdmParts: PdmPartRepository;
      operationLogs: OperationLogRepository;
    }
  ) {}

  publishApproval(approvalId: number): PdmReleaseResult {
    const approval = this.deps.approvals.getById(approvalId);
    if (!approval) return { status: "not_found", reason: "APPROVAL_NOT_FOUND" };

    const metadata = this.getApprovalPdmRow(approvalId);
    const documentCode = blankToNull(metadata?.document_code);
    const materialCode = blankToNull(metadata?.material_code);
    const drawingName = blankToNull(metadata?.drawing_name) ?? approval.partName;
    const metadataStatus = deriveMetadataStatus(documentCode, materialCode, drawingName);

    if (!materialCode) {
      const message = "缺少管家婆物料号，需补录后才能发布到 PDM 零件库";
      this.updateApprovalPdmState(approvalId, {
        documentCode,
        materialCode: null,
        drawingName,
        metadataStatus,
        publishStatus: "metadata_pending",
        publishError: message,
        revisionId: null
      });
      this.deps.operationLogs.create({
        actorUsername: "system",
        action: "pdm.metadata_pending",
        targetType: "approval",
        targetId: approvalId,
        message: "PDM 发布等待补录物料号",
        metadata: { metadataStatus, publishStatus: "metadata_pending" }
      });
      return { status: "metadata_pending", reason: "missing_material_code", error: message };
    }

    if (approval.status !== "approved_for_print" && approval.status !== "printed_archived") {
      return { status: "skipped", reason: "approval_not_approved_for_print" };
    }

    if (approval.signatureStatus !== "generated" && approval.signatureStatus !== "not_required") {
      return { status: "skipped", reason: "signed_pdf_not_ready" };
    }

    try {
      return this.transaction(() => {
        const part = this.deps.pdmParts.createOrUpdatePart({
          materialCode,
          name: drawingName,
          createdFromApprovalId: approval.id
        });
        this.deps.pdmParts.recordUsage({ materialCode, projectName: approval.projectName, approvalId: approval.id });
        const revision = this.deps.pdmParts.publishRevision({
          partId: part.id,
          materialCode,
          documentCode,
          drawingName,
          version: approval.version,
          minorVersion: approval.minorVersion,
          majorVersion: approval.majorVersion,
          approvalId: approval.id,
          originalFilePath: approval.originalFilePath,
          originalFileHash: approval.originalFileHash,
          signedFilePath: approval.signedFilePath,
          signedFileHash: approval.signedFileHash,
          annotatedFilePath: null
        });
        this.updateApprovalPdmState(approvalId, {
          documentCode,
          materialCode,
          drawingName,
          metadataStatus,
          publishStatus: "published",
          publishError: null,
          revisionId: revision.id
        });
        const currentPart = this.deps.pdmParts.getPartById(part.id)!;
        this.deps.operationLogs.create({
          actorUsername: "system",
          action: "pdm.revision_published",
          targetType: "approval",
          targetId: approvalId,
          message: "系统已发布图纸版本到 PDM",
          metadata: {
            partId: currentPart.id,
            revisionId: revision.id,
            materialCode,
            version: approval.version,
            metadataStatus
          }
        });
        return { status: "published", part: currentPart, revision };
      });
    } catch (error) {
      const message = publishErrorMessage(error);
      this.updateApprovalPdmState(approvalId, {
        documentCode,
        materialCode,
        drawingName,
        metadataStatus,
        publishStatus: "failed",
        publishError: message,
        revisionId: null
      });
      this.deps.operationLogs.create({
        actorUsername: "system",
        action: "pdm.publish_failed",
        targetType: "approval",
        targetId: approvalId,
        message: "系统发布图纸版本到 PDM 失败",
        metadata: { error: message, materialCode, version: approval.version }
      });
      return { status: "failed", error: message };
    }
  }

  repairApprovalMetadata(
    approvalId: number,
    input: { documentCode?: string | null; materialCode?: string | null; drawingName?: string | null },
    actor: { actorUserId?: number | null; actorUsername?: string | null } = {}
  ): PdmMetadataRepairResult {
    const approval = this.deps.approvals.getById(approvalId);
    if (!approval) {
      throw new Error("APPROVAL_NOT_FOUND");
    }

    const documentCode = blankToNull(input.documentCode);
    const materialCode = blankToNull(input.materialCode);
    const drawingName = blankToNull(input.drawingName) ?? approval.partName;
    const metadataStatus = deriveMetadataStatus(documentCode, materialCode, drawingName);
    const publishStatus: PdmPublishStatus = materialCode ? "pending" : "metadata_pending";
    const publishError = materialCode ? null : "缺少管家婆物料号，需补录后才能发布到 PDM 零件库";

    this.updateApprovalPdmState(approvalId, {
      documentCode,
      materialCode,
      drawingName,
      metadataStatus,
      publishStatus,
      publishError,
      revisionId: null
    });
    this.deps.operationLogs.create({
      actorUserId: actor.actorUserId ?? null,
      actorUsername: actor.actorUsername ?? null,
      action: "pdm.metadata_repaired",
      targetType: "approval",
      targetId: approvalId,
      message: "已补录 PDM 元数据",
      metadata: { documentCode, materialCode, drawingName, metadataStatus, publishStatus }
    });

    return { approvalId, documentCode, materialCode, drawingName, metadataStatus, publishStatus };
  }

  private transaction<T>(callback: () => T): T {
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.deps.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.deps.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getApprovalPdmRow(approvalId: number): ApprovalPdmRow | null {
    const row = this.deps.db
      .prepare(
        `SELECT
          id, document_code, material_code, drawing_name, pdm_revision_id,
          pdm_metadata_status, pdm_publish_status, pdm_publish_error
        FROM approvals WHERE id = ?`
      )
      .get(approvalId) as ApprovalPdmRow | undefined;
    return row ?? null;
  }

  private updateApprovalPdmState(
    approvalId: number,
    input: {
      documentCode: string | null;
      materialCode: string | null;
      drawingName: string;
      metadataStatus: PdmMetadataStatus;
      publishStatus: PdmPublishStatus;
      publishError: string | null;
      revisionId: number | null;
    }
  ) {
    this.deps.db
      .prepare(
        `UPDATE approvals SET
          document_code = @documentCode,
          material_code = @materialCode,
          drawing_name = @drawingName,
          pdm_revision_id = @revisionId,
          pdm_metadata_status = @metadataStatus,
          pdm_publish_status = @publishStatus,
          pdm_publish_error = @publishError
        WHERE id = @approvalId`
      )
      .run({
        approvalId,
        documentCode: input.documentCode,
        materialCode: input.materialCode,
        drawingName: input.drawingName,
        revisionId: input.revisionId,
        metadataStatus: input.metadataStatus,
        publishStatus: input.publishStatus,
        publishError: input.publishError
      });
  }
}

function deriveMetadataStatus(
  documentCode: string | null,
  materialCode: string | null,
  drawingName: string | null
): PdmMetadataStatus {
  if (!drawingName) return "missing_required";
  if (!materialCode) return "missing_material_code";
  if (!documentCode) return "missing_document_code";
  return "complete";
}

function publishErrorMessage(error: unknown) {
  if (error instanceof Error && error.message === "PDM_REVISION_EXISTS") {
    return "该物料号版本已存在，请确认是否重复提交或需要发布新版本";
  }
  return error instanceof Error ? error.message : "PDM_PUBLISH_FAILED";
}

function blankToNull(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
