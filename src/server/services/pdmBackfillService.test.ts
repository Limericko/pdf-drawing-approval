import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { PdmPartRepository } from "../repositories/pdmParts.ts";
import { PdmReleaseService } from "./pdmReleaseService.ts";
import { PdmBackfillService } from "./pdmBackfillService.ts";

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-pdm-backfill-"));
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const pdmParts = new PdmPartRepository(db);
  const releaseService = new PdmReleaseService({ db, approvals, operationLogs, pdmParts });
  const service = new PdmBackfillService({ db, approvals, operationLogs, pdmParts, releaseService });
  return { root, db, approvals, operationLogs, pdmParts, releaseService, service };
}

async function createPdf(filePath: string, content = "%PDF-1.7\n") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

async function createHistoricalApproval(
  context: Awaited<ReturnType<typeof setup>>,
  input: {
    fileName: string;
    projectName?: string;
    status?: "approved_for_print" | "printed_archived";
    content?: string;
    materialCodeSuffix?: string;
    createFile?: boolean;
  }
) {
  const projectName = input.projectName ?? "项目A";
  const filePath = path.join(context.root, "05-已打印归档", projectName, input.fileName);
  if (input.createFile !== false) {
    await createPdf(filePath, input.content ?? "%PDF-1.7\n");
  }
  return context.approvals.create({
    projectName,
    partName: input.fileName.replace(/\.pdf$/i, ""),
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: filePath,
    currentFilePath: filePath,
    status: input.status ?? "printed_archived",
    submittedByUserId: 4,
    source: "web_upload",
    signatureStatus: "not_required"
  });
}

function approvalPdmState(context: Awaited<ReturnType<typeof setup>>, approvalId: number) {
  return context.db
    .prepare(
      `SELECT document_code, material_code, drawing_name, pdm_revision_id, pdm_metadata_status, pdm_publish_status, pdm_publish_error
       FROM approvals WHERE id = ?`
    )
    .get(approvalId) as {
    document_code: string | null;
    material_code: string | null;
    drawing_name: string | null;
    pdm_revision_id: number | null;
    pdm_metadata_status: string;
    pdm_publish_status: string;
    pdm_publish_error: string | null;
  };
}

describe("PdmBackfillService", () => {
  it("backfills published historical approvals with complete standard PDM filenames", async () => {
    const context = await setup();
    const approval = await createHistoricalApproval(context, {
      fileName: "MP300A000072 《0102A00700883 400A按键》 a0A0.pdf"
    });

    const result = await context.service.backfillApprovedDrawings();

    expect(result).toMatchObject({ scanned: 1, published: 1, skipped: 0, failed: 0 });
    expect(result.items[0]).toMatchObject({
      approvalId: approval.id,
      status: "published",
      materialCode: "0102A00700883",
      version: "a0A0"
    });
    expect(context.pdmParts.findPartByMaterialCode("0102A00700883")?.name).toBe("400A按键");
    expect(context.pdmParts.findPartByMaterialCode("0102A00700883")?.currentRevisionId).toBeTruthy();
    expect(approvalPdmState(context, approval.id)).toMatchObject({
      document_code: "MP300A000072",
      material_code: "0102A00700883",
      drawing_name: "400A按键",
      pdm_metadata_status: "complete",
      pdm_publish_status: "published"
    });
    expect(context.operationLogs.listForTarget("approval", approval.id).map((log) => log.action)).toEqual(
      expect.arrayContaining(["pdm.backfill_prepared", "pdm.revision_published"])
    );
  });

  it("skips old filenames, missing files, invalid PDFs, and duplicate material-version records", async () => {
    const context = await setup();
    await createHistoricalApproval(context, { fileName: "旧格式零件-a0A0.pdf" });
    await createHistoricalApproval(context, {
      fileName: "MP300A000073 《0102A00700884 缺文件》 a0A0.pdf",
      createFile: false
    });
    await createHistoricalApproval(context, {
      fileName: "MP300A000074 《0102A00700885 无效PDF》 a0A0.pdf",
      content: "not a pdf"
    });
    const first = await createHistoricalApproval(context, {
      fileName: "MP300A000075 《0102A00700886 重复件》 a0A0.pdf",
      projectName: "项目A"
    });
    const duplicate = await createHistoricalApproval(context, {
      fileName: "MP300A000076 《0102A00700886 重复件》 a0A0.pdf",
      projectName: "项目B"
    });

    const result = await context.service.backfillApprovedDrawings();

    expect(result.published).toBe(1);
    expect(result.skipped).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.items.map((item) => item.reason)).toEqual(
      expect.arrayContaining(["filename_not_standard_pdm", "file_missing", "invalid_pdf", "duplicate_material_version"])
    );
    expect(approvalPdmState(context, first.id).pdm_publish_status).toBe("published");
    expect(approvalPdmState(context, duplicate.id)).toMatchObject({
      pdm_publish_status: "failed",
      pdm_publish_error: "该物料号版本已存在，请确认是否重复提交或需要发布新版本"
    });
    expect(context.pdmParts.listRevisions(context.pdmParts.findPartByMaterialCode("0102A00700886")!.id)).toHaveLength(1);
  });
});
