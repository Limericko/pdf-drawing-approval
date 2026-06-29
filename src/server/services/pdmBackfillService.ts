import fs from "node:fs/promises";
import type { DatabaseConnection } from "../db.ts";
import { sha256File } from "../files/fileHash.ts";
import { parseDrawingFileName } from "../files/parseDrawingFileName.ts";
import { hasPdfHeader } from "../files/pdfValidation.ts";
import type { Approval } from "../domain/approvals.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { PdmPartRepository } from "../repositories/pdmParts.ts";
import type { PdmReleaseService } from "./pdmReleaseService.ts";

export type PdmBackfillItem = {
  approvalId: number;
  status: "published" | "skipped" | "failed";
  reason?: string;
  materialCode?: string;
  version?: string;
};

export type PdmBackfillResult = {
  scanned: number;
  published: number;
  skipped: number;
  failed: number;
  items: PdmBackfillItem[];
};

const duplicateMaterialVersionMessage = "该物料号版本已存在，请确认是否重复提交或需要发布新版本";

export class PdmBackfillService {
  constructor(
    private readonly deps: {
      db: DatabaseConnection;
      approvals: ApprovalRepository;
      operationLogs: OperationLogRepository;
      pdmParts: PdmPartRepository;
      releaseService: PdmReleaseService;
    }
  ) {}

  async backfillApprovedDrawings(): Promise<PdmBackfillResult> {
    const candidates = this.deps.approvals
      .list()
      .filter((approval) => approval.status === "approved_for_print" || approval.status === "printed_archived")
      .sort((left, right) => left.id - right.id);
    const items: PdmBackfillItem[] = [];

    for (const approval of candidates) {
      items.push(await this.backfillOne(approval));
    }

    return {
      scanned: candidates.length,
      published: items.filter((item) => item.status === "published").length,
      skipped: items.filter((item) => item.status === "skipped").length,
      failed: items.filter((item) => item.status === "failed").length,
      items
    };
  }

  private async backfillOne(approval: Approval): Promise<PdmBackfillItem> {
    if (approval.pdmPublishStatus === "published" && approval.pdmRevisionId) {
      return this.skip(approval, "already_published");
    }

    const parsed = parseDrawingFileName(approval.originalFilePath) ?? parseDrawingFileName(approval.currentFilePath);
    if (!parsed || parsed.metadataStatus !== "complete" || !parsed.materialCode) {
      return this.skip(approval, "filename_not_standard_pdm");
    }

    const fileState = await this.validateCurrentPdf(approval.currentFilePath);
    if (fileState !== "ok") {
      return this.skip(approval, fileState);
    }

    if (this.deps.pdmParts.findRevisionByMaterialVersion(parsed.materialCode, parsed.version)) {
      this.markApprovalPdmFailure(approval, parsed, duplicateMaterialVersionMessage);
      return this.skip(approval, "duplicate_material_version", parsed.materialCode, parsed.version);
    }

    const originalFileHash = approval.originalFileHash ?? await sha256File(approval.currentFilePath);
    const signedFileHash = await this.backfillSignedHash(approval);
    this.prepareApprovalForPublish(approval, parsed, originalFileHash, signedFileHash);

    const result = this.deps.releaseService.publishApproval(approval.id);
    if (result.status === "published") {
      return {
        approvalId: approval.id,
        status: "published",
        materialCode: parsed.materialCode,
        version: parsed.version
      };
    }

    if (result.status === "failed") {
      return {
        approvalId: approval.id,
        status: "failed",
        reason: result.error ?? "pdm_publish_failed",
        materialCode: parsed.materialCode,
        version: parsed.version
      };
    }

    return this.skip(approval, result.reason ?? result.status, parsed.materialCode, parsed.version);
  }

  private async validateCurrentPdf(filePath: string): Promise<"ok" | "file_missing" | "invalid_pdf"> {
    try {
      await fs.access(filePath);
    } catch {
      return "file_missing";
    }

    try {
      return await hasPdfHeader(filePath) ? "ok" : "invalid_pdf";
    } catch {
      return "file_missing";
    }
  }

  private async backfillSignedHash(approval: Approval) {
    if (!approval.signedFilePath || approval.signedFileHash) return approval.signedFileHash;
    try {
      if (await hasPdfHeader(approval.signedFilePath)) {
        return await sha256File(approval.signedFilePath);
      }
    } catch {
      return approval.signedFileHash;
    }
    return approval.signedFileHash;
  }

  private prepareApprovalForPublish(
    approval: Approval,
    parsed: NonNullable<ReturnType<typeof parseDrawingFileName>>,
    originalFileHash: string,
    signedFileHash: string | null
  ) {
    this.deps.db
      .prepare(
        `UPDATE approvals SET
          part_name = @drawingName,
          version = @version,
          minor_version = @minorVersion,
          major_version = @majorVersion,
          document_code = @documentCode,
          material_code = @materialCode,
          drawing_name = @drawingName,
          original_file_hash = @originalFileHash,
          signed_file_hash = @signedFileHash,
          pdm_revision_id = NULL,
          pdm_metadata_status = 'complete',
          pdm_publish_status = 'pending',
          pdm_publish_error = NULL
        WHERE id = @approvalId`
      )
      .run({
        approvalId: approval.id,
        drawingName: parsed.drawingName,
        version: parsed.version,
        minorVersion: parsed.minorVersion,
        majorVersion: parsed.majorVersion,
        documentCode: parsed.documentCode,
        materialCode: parsed.materialCode,
        originalFileHash,
        signedFileHash
      });
    this.deps.operationLogs.create({
      actorUsername: "system",
      action: "pdm.backfill_prepared",
      targetType: "approval",
      targetId: approval.id,
      message: "历史审批记录已准备回填到 PDM",
      metadata: {
        materialCode: parsed.materialCode,
        documentCode: parsed.documentCode,
        drawingName: parsed.drawingName,
        version: parsed.version
      }
    });
  }

  private markApprovalPdmFailure(
    approval: Approval,
    parsed: NonNullable<ReturnType<typeof parseDrawingFileName>>,
    error: string
  ) {
    this.deps.db
      .prepare(
        `UPDATE approvals SET
          document_code = @documentCode,
          material_code = @materialCode,
          drawing_name = @drawingName,
          pdm_metadata_status = 'complete',
          pdm_publish_status = 'failed',
          pdm_publish_error = @error
        WHERE id = @approvalId`
      )
      .run({
        approvalId: approval.id,
        documentCode: parsed.documentCode,
        materialCode: parsed.materialCode,
        drawingName: parsed.drawingName,
        error
      });
    this.deps.operationLogs.create({
      actorUsername: "system",
      action: "pdm.backfill_skipped",
      targetType: "approval",
      targetId: approval.id,
      message: "PDM 历史回填跳过重复物料版本",
      metadata: { materialCode: parsed.materialCode, version: parsed.version, error }
    });
  }

  private skip(approval: Approval, reason: string, materialCode?: string, version?: string): PdmBackfillItem {
    if (reason !== "already_published") {
      this.deps.operationLogs.create({
        actorUsername: "system",
        action: "pdm.backfill_skipped",
        targetType: "approval",
        targetId: approval.id,
        message: "PDM 历史回填跳过记录",
        metadata: { reason, materialCode, version }
      });
    }
    return { approvalId: approval.id, status: "skipped", reason, materialCode, version };
  }
}
