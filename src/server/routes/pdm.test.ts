import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createDatabase, type DatabaseConnection } from "../db.ts";
import { createServer } from "../server.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { PdmPartRepository } from "../repositories/pdmParts.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { SignaturePlacementRepository } from "../repositories/signaturePlacements.ts";
import { UserRepository, type User } from "../repositories/users.ts";
import { PdmReleaseService } from "../services/pdmReleaseService.ts";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");

async function createValidPdf(filePath: string) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, await pdf.save());
}

async function appContext() {
  const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-pdm-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-pdm-data-"));
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const pdmParts = new PdmPartRepository(db);
  const settings = new SettingsRepository(db);
  const signatureAssets = new SignatureAssetRepository(db);
  const signaturePlacements = new SignaturePlacementRepository(db);
  const users = new UserRepository(db);
  settings.set("watch_root", watchRoot);
  const admin = users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const otherDesigner = users.create({ username: "designer2", password: "123456", role: "designer", displayName: "设计师二" });
  const supervisor = users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  const process = users.create({ username: "process", password: "123456", role: "process", displayName: "工艺" });
  const pdmReleaseService = new PdmReleaseService({ db, approvals, operationLogs, pdmParts });
  const app = createServer(
    { port: 0, dataDir, databasePath: ":memory:", jwtSecret: "secret" },
    { db, approvals, operationLogs, settings, signatureAssets, signaturePlacements, users }
  );
  const adminLogin = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
  const designerLogin = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });
  const otherDesignerLogin = await request(app).post("/api/auth/login").send({ username: "designer2", password: "123456" });
  const supervisorLogin = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });
  const processLogin = await request(app).post("/api/auth/login").send({ username: "process", password: "123456" });
  return {
    app,
    db,
    approvals,
    operationLogs,
    pdmParts,
    pdmReleaseService,
    settings,
    signatureAssets,
    signaturePlacements,
    users,
    admin,
    designer,
    otherDesigner,
    supervisor,
    process,
    watchRoot,
    adminToken: adminLogin.body.token,
    designerToken: designerLogin.body.token,
    otherDesignerToken: otherDesignerLogin.body.token,
    supervisorToken: supervisorLogin.body.token,
    processToken: processLogin.body.token
  };
}

function setApprovalPdmMetadata(
  db: DatabaseConnection,
  approvalId: number,
  input: { documentCode?: string | null; materialCode?: string | null; drawingName?: string | null }
) {
  const documentCode = input.documentCode ?? null;
  const materialCode = input.materialCode ?? null;
  const drawingName = input.drawingName ?? null;
  const metadataStatus = !drawingName
    ? "missing_required"
    : !materialCode
      ? "missing_material_code"
      : !documentCode
        ? "missing_document_code"
        : "complete";
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
    documentCode,
    materialCode,
    drawingName,
    metadataStatus,
    publishStatus: materialCode ? "pending" : "metadata_pending"
  });
}

async function createApprovedApproval(
  context: Awaited<ReturnType<typeof appContext>>,
  input: {
    projectName: string;
    drawingName: string;
    version: string;
    materialCode?: string | null;
    documentCode?: string | null;
    submittedByUserId?: number | null;
  }
) {
  const filePath = path.join(context.watchRoot, "04-已通过待打印", input.projectName, `${input.drawingName}-${input.version}.pdf`);
  await createValidPdf(filePath);
  const approval = context.approvals.create({
    projectName: input.projectName,
    partName: input.drawingName,
    version: input.version,
    minorVersion: input.version.slice(0, 2),
    majorVersion: input.version.slice(2),
    originalFilePath: filePath,
    currentFilePath: filePath,
    status: "approved_for_print",
    submittedByUserId: input.submittedByUserId ?? context.designer.id,
    source: "web_upload",
    originalFileHash: `original-${input.materialCode}-${input.version}`,
    signatureStatus: "not_required"
  });
  setApprovalPdmMetadata(context.db, approval.id, {
    documentCode: input.documentCode === undefined ? "MP300A000072" : input.documentCode,
    materialCode: input.materialCode === undefined ? "0102A00700883" : input.materialCode,
    drawingName: input.drawingName
  });
  return approval;
}

async function publishApproval(
  context: Awaited<ReturnType<typeof appContext>>,
  input: {
    projectName: string;
    drawingName: string;
    version: string;
    materialCode?: string | null;
    documentCode?: string | null;
  }
) {
  const approval = await createApprovedApproval(context, input);
  const published = context.pdmReleaseService.publishApproval(approval.id);
  if (published.status !== "published") throw new Error(`publish failed: ${published.error ?? published.reason}`);
  return { approval, published };
}

async function prepareSignablePdmApproval(context: Awaited<ReturnType<typeof appContext>>) {
  const sourcePath = path.join(context.watchRoot, "02-审批中", "项目A", "400A按键-a0A0.pdf");
  await createValidPdf(sourcePath);
  const signatureDir = path.join(context.watchRoot, "signatures");
  await fs.mkdir(signatureDir, { recursive: true });
  const designerSignature = path.join(signatureDir, "designer.png");
  const supervisorSignature = path.join(signatureDir, "supervisor.png");
  const processSignature = path.join(signatureDir, "process.png");
  await fs.writeFile(designerSignature, pngBytes);
  await fs.writeFile(supervisorSignature, pngBytes);
  await fs.writeFile(processSignature, pngBytes);
  const approval = context.approvals.create({
    projectName: "项目A",
    partName: "400A按键",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: sourcePath,
    currentFilePath: sourcePath,
    submittedByUserId: context.designer.id,
    source: "web_upload",
    originalFileHash: "original-hash",
    signatureStatus: "pending"
  });
  setApprovalPdmMetadata(context.db, approval.id, {
    documentCode: "MP300A000072",
    materialCode: "0102A00700883",
    drawingName: "400A按键"
  });
  context.signatureAssets.createForUser({ userId: context.designer.id, kind: "uploaded_png", filePath: designerSignature });
  context.signatureAssets.createForUser({ userId: context.supervisor.id, kind: "uploaded_png", filePath: supervisorSignature });
  context.signatureAssets.createForUser({ userId: context.process.id, kind: "uploaded_png", filePath: processSignature });
  context.signaturePlacements.upsertMany(approval.id, [
    { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
    { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
    { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
  ]);
  return approval;
}

function auth(token: string) {
  return `Bearer ${token}`;
}

describe("PDM routes", () => {
  it("lists PDM parts with keyword, project filters, and paging", async () => {
    const context = await appContext();
    await publishApproval(context, { projectName: "项目A", drawingName: "400A按键", version: "a0A0" });
    await publishApproval(context, {
      projectName: "项目B",
      drawingName: "端盖",
      version: "a0A0",
      materialCode: "0102A00700999",
      documentCode: "MP300A000099"
    });

    const keyword = await request(context.app)
      .get("/api/pdm/parts?keyword=400A&page=1&pageSize=10")
      .set("Authorization", auth(context.designerToken))
      .expect(200);
    expect(keyword.body.total).toBe(1);
    expect(keyword.body.items[0]).toEqual(
      expect.objectContaining({
        materialCode: "0102A00700883",
        name: "400A按键",
        currentVersion: "a0A0",
        currentDocumentCode: "MP300A000072",
        usageProjectCount: 1
      })
    );

    const project = await request(context.app)
      .get("/api/pdm/parts?projectName=项目B&page=1&pageSize=10")
      .set("Authorization", auth(context.supervisorToken))
      .expect(200);
    expect(project.body.items.map((item: { materialCode: string }) => item.materialCode)).toEqual(["0102A00700999"]);
  });

  it("returns a part detail with current revision, revision history, usage projects, and approval links", async () => {
    const context = await appContext();
    const first = await publishApproval(context, { projectName: "项目A", drawingName: "400A按键", version: "a0A0" });
    await publishApproval(context, { projectName: "项目B", drawingName: "400A按键", version: "a1A0" });
    const partId = first.published.part!.id;

    const response = await request(context.app)
      .get(`/api/pdm/parts/${partId}`)
      .set("Authorization", auth(context.processToken))
      .expect(200);

    expect(response.body.part).toEqual(expect.objectContaining({ id: partId, materialCode: "0102A00700883" }));
    expect(response.body.currentRevision).toEqual(expect.objectContaining({ version: "a1A0", approvalId: expect.any(Number) }));
    expect(response.body.revisions.map((revision: { version: string; releaseStatus: string }) => [revision.version, revision.releaseStatus])).toEqual([
      ["a1A0", "released"],
      ["a0A0", "superseded"]
    ]);
    expect(response.body.usages.map((usage: { projectName: string }) => usage.projectName)).toEqual(["项目A", "项目B"]);
  });

  it("lists pending metadata for admins and only the designer's own records", async () => {
    const context = await appContext();
    await createApprovedApproval(context, {
      projectName: "项目A",
      drawingName: "待补件",
      version: "a0A0",
      materialCode: null,
      documentCode: null,
      submittedByUserId: context.designer.id
    });
    await createApprovedApproval(context, {
      projectName: "项目B",
      drawingName: "他人件",
      version: "a0A0",
      materialCode: null,
      documentCode: null,
      submittedByUserId: context.otherDesigner.id
    });

    const admin = await request(context.app)
      .get("/api/pdm/pending-metadata")
      .set("Authorization", auth(context.adminToken))
      .expect(200);
    expect(admin.body.items).toHaveLength(2);

    const designer = await request(context.app)
      .get("/api/pdm/pending-metadata")
      .set("Authorization", auth(context.designerToken))
      .expect(200);
    expect(designer.body.items.map((item: { drawingName: string }) => item.drawingName)).toEqual(["待补件"]);

    await request(context.app).get("/api/pdm/pending-metadata").set("Authorization", auth(context.supervisorToken)).expect(403);
  });

  it("allows admins and owning designers to repair metadata while denying reviewers and other designers", async () => {
    const context = await appContext();
    const own = await createApprovedApproval(context, {
      projectName: "项目A",
      drawingName: "待补件",
      version: "a0A0",
      materialCode: null,
      documentCode: null,
      submittedByUserId: context.designer.id
    });
    const other = await createApprovedApproval(context, {
      projectName: "项目B",
      drawingName: "他人件",
      version: "a0A0",
      materialCode: null,
      documentCode: null,
      submittedByUserId: context.otherDesigner.id
    });

    const repaired = await request(context.app)
      .post(`/api/pdm/approvals/${own.id}/repair-metadata`)
      .set("Authorization", auth(context.designerToken))
      .send({ documentCode: "MP300A000072", materialCode: "0102A00700883", drawingName: "待补件" })
      .expect(200);
    expect(repaired.body.metadataStatus).toBe("complete");

    await request(context.app)
      .post(`/api/pdm/approvals/${other.id}/repair-metadata`)
      .set("Authorization", auth(context.designerToken))
      .send({ documentCode: "MP300A000073", materialCode: "0102A00700884", drawingName: "他人件" })
      .expect(403);
    await request(context.app)
      .post(`/api/pdm/approvals/${other.id}/repair-metadata`)
      .set("Authorization", auth(context.supervisorToken))
      .send({ documentCode: "MP300A000073", materialCode: "0102A00700884", drawingName: "他人件" })
      .expect(403);
    await request(context.app)
      .post(`/api/pdm/approvals/${other.id}/repair-metadata`)
      .set("Authorization", auth(context.adminToken))
      .send({ documentCode: "MP300A000073", materialCode: "0102A00700884", drawingName: "他人件" })
      .expect(200);
  });

  it("allows admins and owning designers to retry PDM publishing while denying reviewers", async () => {
    const context = await appContext();
    const approval = await createApprovedApproval(context, {
      projectName: "项目A",
      drawingName: "待发布件",
      version: "a0A0",
      materialCode: null,
      documentCode: null,
      submittedByUserId: context.designer.id
    });
    context.pdmReleaseService.publishApproval(approval.id);
    await request(context.app)
      .post(`/api/pdm/approvals/${approval.id}/repair-metadata`)
      .set("Authorization", auth(context.designerToken))
      .send({ documentCode: "MP300A000072", materialCode: "0102A00700883", drawingName: "待发布件" })
      .expect(200);

    await request(context.app).post(`/api/pdm/approvals/${approval.id}/publish`).set("Authorization", auth(context.supervisorToken)).expect(403);
    const published = await request(context.app)
      .post(`/api/pdm/approvals/${approval.id}/publish`)
      .set("Authorization", auth(context.designerToken))
      .expect(200);

    expect(published.body.status).toBe("published");
    expect(published.body.revision.version).toBe("a0A0");
  });

  it("publishes PDM revision automatically when an eligible approval passes both reviews", async () => {
    const context = await appContext();
    const approval = await prepareSignablePdmApproval(context);

    await request(context.app)
      .post(`/api/approvals/${approval.id}/review`)
      .set("Authorization", auth(context.supervisorToken))
      .send({ role: "supervisor", decision: "approved", comment: "同意" })
      .expect(200);
    const final = await request(context.app)
      .post(`/api/approvals/${approval.id}/review`)
      .set("Authorization", auth(context.processToken))
      .send({ role: "process", decision: "approved", comment: "同意" })
      .expect(200);

    expect(final.body.signatureStatus).toBe("generated");
    expect(final.body.pdmPublishStatus).toBe("published");
    expect(context.pdmParts.findPartByMaterialCode("0102A00700883")?.currentRevisionId).toBeTruthy();
    expect(context.pdmParts.listRevisions(context.pdmParts.findPartByMaterialCode("0102A00700883")!.id)).toHaveLength(1);
  });
});
