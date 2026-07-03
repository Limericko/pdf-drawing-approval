import { describe, expect, it } from "vitest";
import { createDatabase, type DatabaseConnection } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { PdmPartRepository } from "../repositories/pdmParts.ts";
import { PdmReleaseService } from "./pdmReleaseService.ts";

function setup() {
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const pdmParts = new PdmPartRepository(db);
  const service = new PdmReleaseService({ db, approvals, operationLogs, pdmParts });
  return { db, approvals, operationLogs, pdmParts, service };
}

function createApprovedDrawing(
  context: ReturnType<typeof setup>,
  overrides: {
    projectName?: string;
    partName?: string;
    version?: string;
    documentCode?: string | null;
    materialCode?: string | null;
    drawingName?: string | null;
    submittedByUserId?: number | null;
    signatureStatus?: "generated" | "not_required";
  } = {}
) {
  const projectName = overrides.projectName ?? "项目A";
  const partName = overrides.partName ?? "400A按键";
  const version = overrides.version ?? "a0A0";
  const minorVersion = version.slice(0, 2);
  const majorVersion = version.slice(2);
  const approval = context.approvals.create({
    projectName,
    partName,
    version,
    minorVersion,
    majorVersion,
    originalFilePath: `02-审批中/${projectName}/${partName}-${version}.pdf`,
    currentFilePath: `02-审批中/${projectName}/${partName}-${version}.pdf`,
    status: "approved_for_print",
    submittedByUserId: overrides.submittedByUserId ?? 4,
    source: "web_upload",
    originalFileHash: `original-${projectName}-${version}`,
    signatureStatus: overrides.signatureStatus === "not_required" ? "not_required" : "ready"
  });
  if (overrides.signatureStatus !== "not_required") {
    context.approvals.setSignedFile(
      approval.id,
      `04-已通过待打印/${projectName}/${partName}-${version}-签审.pdf`,
      `signed-${projectName}-${version}`
    );
  }

  setPdmMetadata(context.db, approval.id, {
    documentCode: overrides.documentCode === undefined ? "MP300A000072" : overrides.documentCode,
    materialCode: overrides.materialCode === undefined ? "0102A00700883" : overrides.materialCode,
    drawingName: overrides.drawingName === undefined ? partName : overrides.drawingName
  });

  return context.approvals.getById(approval.id)!;
}

function setPdmMetadata(
  db: DatabaseConnection,
  approvalId: number,
  input: { documentCode?: string | null; materialCode?: string | null; drawingName?: string | null }
) {
  const metadataStatus = !input.materialCode ? "missing_material_code" : !input.documentCode ? "missing_document_code" : "complete";
  const publishStatus = !input.materialCode ? "metadata_pending" : "pending";
  db.prepare(
    `UPDATE approvals SET
      document_code = @documentCode,
      material_code = @materialCode,
      drawing_name = @drawingName,
      pdm_metadata_status = @metadataStatus,
      pdm_publish_status = @publishStatus,
      pdm_publish_error = NULL
    WHERE id = @approvalId`
  ).run({
    approvalId,
    documentCode: input.documentCode ?? null,
    materialCode: input.materialCode ?? null,
    drawingName: input.drawingName ?? null,
    metadataStatus,
    publishStatus
  });
}

function approvalPdmRow(db: DatabaseConnection, approvalId: number) {
  return db
    .prepare(
      `SELECT pdm_revision_id, pdm_metadata_status, pdm_publish_status, pdm_publish_error
       FROM approvals WHERE id = ?`
    )
    .get(approvalId) as {
    pdm_revision_id: number | null;
    pdm_metadata_status: string;
    pdm_publish_status: string;
    pdm_publish_error: string | null;
  };
}

describe("PdmReleaseService", () => {
  it("publishes an approved signed approval into the PDM revision library", () => {
    const context = setup();
    const approval = createApprovedDrawing(context);

    const result = context.service.publishApproval(approval.id);

    expect(result.status).toBe("published");
    expect(result.revision?.version).toBe("a0A0");
    expect(context.pdmParts.findPartByMaterialCode("0102A00700883")?.currentRevisionId).toBe(result.revision?.id);
    expect(approvalPdmRow(context.db, approval.id)).toMatchObject({
      pdm_revision_id: result.revision?.id,
      pdm_metadata_status: "complete",
      pdm_publish_status: "published",
      pdm_publish_error: null
    });
    expect(context.operationLogs.listForTarget("approval", approval.id).map((log) => log.action)).toContain(
      "pdm.revision_published"
    );
  });

  it("marks approved records as metadata pending when material code is missing", () => {
    const context = setup();
    const approval = createApprovedDrawing(context, { documentCode: null, materialCode: null });

    const result = context.service.publishApproval(approval.id);

    expect(result.status).toBe("metadata_pending");
    expect(context.pdmParts.findPartByMaterialCode("0102A00700883")).toBeNull();
    expect(approvalPdmRow(context.db, approval.id)).toMatchObject({
      pdm_revision_id: null,
      pdm_metadata_status: "missing_material_code",
      pdm_publish_status: "metadata_pending"
    });
    expect(approvalPdmRow(context.db, approval.id).pdm_publish_error).toContain("物料号");
    expect(context.operationLogs.listForTarget("approval", approval.id).map((log) => log.action)).toContain(
      "pdm.metadata_pending"
    );
  });

  it("allows publishing when document code is missing but material code is present", () => {
    const context = setup();
    const approval = createApprovedDrawing(context, { documentCode: null, materialCode: "0102A00700883" });

    const result = context.service.publishApproval(approval.id);

    expect(result.status).toBe("published");
    expect(result.revision?.documentCode).toBeNull();
    expect(approvalPdmRow(context.db, approval.id)).toMatchObject({
      pdm_metadata_status: "missing_document_code",
      pdm_publish_status: "published"
    });
  });

  it("fails duplicate material-version publishing without replacing the current revision", () => {
    const context = setup();
    const first = createApprovedDrawing(context, { projectName: "项目A", materialCode: "0102A00700883", version: "a0A0" });
    const second = createApprovedDrawing(context, { projectName: "项目B", materialCode: "0102A00700883", version: "a0A0" });
    const firstResult = context.service.publishApproval(first.id);

    const secondResult = context.service.publishApproval(second.id);

    expect(secondResult.status).toBe("failed");
    expect(approvalPdmRow(context.db, second.id)).toMatchObject({
      pdm_revision_id: null,
      pdm_publish_status: "failed"
    });
    expect(approvalPdmRow(context.db, second.id).pdm_publish_error).toContain("该物料号版本已存在");
    expect(context.pdmParts.findPartByMaterialCode("0102A00700883")?.currentRevisionId).toBe(firstResult.revision?.id);
    expect(context.pdmParts.listRevisions(firstResult.part!.id)).toHaveLength(1);
  });

  it("repairs metadata and retries publishing for a previously pending approval", () => {
    const context = setup();
    const approval = createApprovedDrawing(context, { documentCode: null, materialCode: null, drawingName: "400A按键" });
    expect(context.service.publishApproval(approval.id).status).toBe("metadata_pending");

    const repaired = context.service.repairApprovalMetadata(
      approval.id,
      { documentCode: "MP300A000072", materialCode: "0102A00700883", drawingName: "400A按键" },
      { actorUserId: 4, actorUsername: "designer" }
    );
    const published = context.service.publishApproval(approval.id);

    expect(repaired.metadataStatus).toBe("complete");
    expect(published.status).toBe("published");
    expect(approvalPdmRow(context.db, approval.id)).toMatchObject({
      pdm_metadata_status: "complete",
      pdm_publish_status: "published"
    });
    expect(context.operationLogs.listForTarget("approval", approval.id).map((log) => log.action)).toEqual(
      expect.arrayContaining(["pdm.metadata_repaired", "pdm.revision_published"])
    );
  });
});
