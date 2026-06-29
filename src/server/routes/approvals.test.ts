import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createDatabase } from "../db.ts";
import { createServer } from "../server.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { ApprovalAnnotationRepository } from "../repositories/approvalAnnotations.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { SignaturePlacementRepository } from "../repositories/signaturePlacements.ts";
import { SignatureTemplateRepository } from "../repositories/signatureTemplates.ts";
import { UserRepository } from "../repositories/users.ts";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");

async function createValidPdf(filePath: string) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await fs.writeFile(filePath, await pdf.save());
}

async function prepareSignatureApproval(context: Awaited<ReturnType<typeof appContext>>, input: { status?: "pending" | "approved_for_print" } = {}) {
  const sourceDir = path.join(context.watchRoot, "02-审批中", "项目A");
  const sourcePath = path.join(sourceDir, `签名件-${Date.now()}-a0A0.pdf`);
  await createValidPdf(sourcePath);
  const signatureDir = path.join(context.watchRoot, "signatures");
  await fs.mkdir(signatureDir, { recursive: true });
  const designerSignature = path.join(signatureDir, `designer-${Date.now()}.png`);
  const supervisorSignature = path.join(signatureDir, `supervisor-${Date.now()}.png`);
  const processSignature = path.join(signatureDir, `process-${Date.now()}.png`);
  await fs.writeFile(designerSignature, pngBytes);
  await fs.writeFile(supervisorSignature, pngBytes);
  await fs.writeFile(processSignature, pngBytes);
  const approval = context.approvals.create({
    projectName: "项目A",
    partName: `签名件-${Date.now()}`,
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: sourcePath,
    currentFilePath: sourcePath,
    submittedByUserId: context.designer.id,
    source: "web_upload",
    signatureStatus: "pending"
  });
  context.signatureAssets.replaceActiveForUser({ userId: context.designer.id, kind: "uploaded_png", filePath: designerSignature });
  context.signatureAssets.replaceActiveForUser({ userId: context.supervisor.id, kind: "uploaded_png", filePath: supervisorSignature });
  context.signatureAssets.replaceActiveForUser({ userId: context.process.id, kind: "uploaded_png", filePath: processSignature });
  context.signaturePlacements.upsertMany(approval.id, [
    { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
    { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
    { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
  ]);

  if (input.status === "approved_for_print") {
    context.approvals.review(approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    context.approvals.review(approval.id, { role: "process", decision: "approved", comment: "同意" });
  }

  return context.approvals.getById(approval.id)!;
}

async function appContext() {
  const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-api-"));
  const currentDir = path.join(watchRoot, "02-审批中", "项目A");
  await fs.mkdir(currentDir, { recursive: true });
  const currentFilePath = path.join(currentDir, "轴承座-a0A0.pdf");
  await fs.writeFile(currentFilePath, "pdf");
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const approvalAnnotations = new ApprovalAnnotationRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const signatureAssets = new SignatureAssetRepository(db);
  const signaturePlacements = new SignaturePlacementRepository(db);
  const signatureTemplates = new SignatureTemplateRepository(db);
  const users = new UserRepository(db);
  const settings = new SettingsRepository(db);
  settings.set("watch_root", watchRoot);
  const supervisor = users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  const process = users.create({ username: "process", password: "123456", role: "process", displayName: "工艺" });
  users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const approval = approvals.create({
    projectName: "项目A",
    partName: "轴承座",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: currentFilePath,
    currentFilePath
  });
  const app = createServer(
    { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
    { db, approvals, users, settings, signatureAssets, signaturePlacements, signatureTemplates }
  );
  const supervisorLogin = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });
  const processLogin = await request(app).post("/api/auth/login").send({ username: "process", password: "123456" });
  const adminLogin = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
  const designerLogin = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });
  return {
    app,
    approval,
    approvals,
    approvalAnnotations,
    watchRoot,
    operationLogs,
    signatureAssets,
    signaturePlacements,
    signatureTemplates,
    users,
    designer,
    supervisor,
    process,
    supervisorToken: supervisorLogin.body.token,
    processToken: processLogin.body.token,
    adminToken: adminLogin.body.token,
    designerToken: designerLogin.body.token
  };
}

describe("approval routes", () => {
  it("lists approval records and returns detail", async () => {
    const context = await appContext();
    context.approvals.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a1A0",
      minorVersion: "a1",
      majorVersion: "A0",
      originalFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a1A0.pdf",
      currentFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a1A0.pdf"
    });
    context.approvals.create({
      projectName: "项目B",
      partName: "轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "G:\\Nutstore\\02-审批中\\项目B\\轴承座-a0A0.pdf",
      currentFilePath: "G:\\Nutstore\\02-审批中\\项目B\\轴承座-a0A0.pdf"
    });

    const list = await request(context.app).get("/api/approvals").set("Authorization", `Bearer ${context.supervisorToken}`).expect(200);
    expect(list.body).toHaveLength(3);

    const detail = await request(context.app).get(`/api/approvals/${context.approval.id}`).set("Authorization", `Bearer ${context.supervisorToken}`).expect(200);
    expect(detail.body.history).toHaveLength(2);
    expect(detail.body.relatedVersions.map((item: { version: string }) => item.version)).toEqual(["a1A0"]);
  });

  it("lists approval records with server-side paging and keyword search", async () => {
    const context = await appContext();
    context.approvals.create({
      projectName: "项目A",
      partName: "端盖",
      version: "a1A0",
      minorVersion: "a1",
      majorVersion: "A0",
      originalFilePath: "G:\\Nutstore\\02-审批中\\项目A\\端盖-a1A0.pdf",
      currentFilePath: "G:\\Nutstore\\02-审批中\\项目A\\端盖-a1A0.pdf"
    });
    context.approvals.create({
      projectName: "项目B",
      partName: "支架",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "G:\\Nutstore\\02-审批中\\项目B\\支架-a0A0.pdf",
      currentFilePath: "G:\\Nutstore\\02-审批中\\项目B\\支架-a0A0.pdf"
    });

    const response = await request(context.app)
      .get("/api/approvals?page=1&pageSize=1&keyword=项目")
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        total: 3,
        page: 1,
        pageSize: 1
      })
    );
    expect(response.body.items).toHaveLength(1);

    const keyword = await request(context.app)
      .get("/api/approvals?page=1&pageSize=20&keyword=端盖")
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(200);

    expect(keyword.body.total).toBe(1);
    expect(keyword.body.items[0].partName).toBe("端盖");
  });

  it("rejects files that do not contain a PDF header", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .get(`/api/approvals/${context.approval.id}/file`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(422);

    expect(response.body.error).toBe("INVALID_PDF_FILE");

    await request(context.app)
      .head(`/api/approvals/${context.approval.id}/file`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(422);
  });

  it("approves in parallel and moves final file to approved folder", async () => {
    const context = await appContext();

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/review`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ role: "supervisor", decision: "approved", comment: "同意" })
      .expect(200);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain("approval.reviewed");

    const final = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/review`)
      .set("Authorization", `Bearer ${context.processToken}`)
      .send({ role: "process", decision: "approved", comment: "同意" })
      .expect(200);

    expect(final.body.status).toBe("approved_for_print");
    expect(final.body.currentFilePath).toContain("04-已通过待打印");

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/mark-printed`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain("approval.printed");
  });

  it("does not expose reviewer queues to designers", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .get("/api/approvals?mine=1")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it("filters approval records by signature status", async () => {
    const context = await appContext();
    const failed = await prepareSignatureApproval(context, { status: "approved_for_print" });
    context.approvals.setSignatureStatus(failed.id, "failed", "MISSING_SIGNATURE");

    const response = await request(context.app)
      .get("/api/approvals?signatureStatus=failed")
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200);

    expect(response.body.map((approval: { id: number }) => approval.id)).toEqual([failed.id]);
  });

  it("does not let reviewers mark drawings as printed", async () => {
    const context = await appContext();
    context.approvals.review(context.approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    context.approvals.review(context.approval.id, { role: "process", decision: "approved", comment: "同意" });

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/mark-printed`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(403);
  });

  it("rejects print archival before an approval is approved for print", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/mark-printed`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(400);

    expect(response.body.error).toBe("APPROVAL_NOT_PRINTABLE");
    expect(context.approvals.getById(context.approval.id)?.status).toBe("pending");
  });

  it("rejects print archival for signature-enabled approvals without a generated signed PDF", async () => {
    const context = await appContext();
    const approval = await prepareSignatureApproval(context, { status: "approved_for_print" });
    context.approvals.setSignatureStatus(approval.id, "failed", "missing signature");

    const response = await request(context.app)
      .post(`/api/approvals/${approval.id}/mark-printed`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(400);

    expect(response.body.error).toBe("SIGNED_PDF_REQUIRED");
    expect(context.approvals.getById(approval.id)?.status).toBe("approved_for_print");
  });

  it("moves the signed PDF into the printed archive folder when marking a signed drawing as printed", async () => {
    const context = await appContext();
    const approval = await prepareSignatureApproval(context, { status: "approved_for_print" });

    const generated = await request(context.app)
      .post(`/api/approvals/${approval.id}/generate-signed-pdf`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);
    const signedBeforeArchive = generated.body.signedFilePath as string;

    const response = await request(context.app)
      .post(`/api/approvals/${approval.id}/mark-printed`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);

    expect(response.body.status).toBe("printed_archived");
    expect(response.body.signedFilePath).toContain("05-已打印归档");
    await expect(fs.stat(response.body.signedFilePath)).resolves.toBeTruthy();
    await expect(fs.stat(signedBeforeArchive)).rejects.toThrow();
    expect(context.approvals.getById(approval.id)?.signedFilePath).toBe(response.body.signedFilePath);
  });

  it("generates a signed PDF when a signature-enabled approval passes both reviews", async () => {
    const context = await appContext();
    const signedSourceDir = path.join(context.watchRoot, "02-审批中", "项目A");
    const signedSourcePath = path.join(signedSourceDir, "签名件-a0A0.pdf");
    await createValidPdf(signedSourcePath);
    const signatureDir = path.join(context.watchRoot, "signatures");
    await fs.mkdir(signatureDir, { recursive: true });
    const designerSignature = path.join(signatureDir, "designer.png");
    const supervisorSignature = path.join(signatureDir, "supervisor.png");
    const processSignature = path.join(signatureDir, "process.png");
    await fs.writeFile(designerSignature, pngBytes);
    await fs.writeFile(supervisorSignature, pngBytes);
    await fs.writeFile(processSignature, pngBytes);
    const signatureApproval = context.approvals.create({
      projectName: "项目A",
      partName: "签名件",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: signedSourcePath,
      currentFilePath: signedSourcePath,
      submittedByUserId: context.designer.id,
      source: "web_upload",
      signatureStatus: "pending"
    });
    context.signatureAssets.createForUser({ userId: context.designer.id, kind: "uploaded_png", filePath: designerSignature });
    context.signatureAssets.createForUser({ userId: context.supervisor.id, kind: "uploaded_png", filePath: supervisorSignature });
    context.signatureAssets.createForUser({ userId: context.process.id, kind: "uploaded_png", filePath: processSignature });
    context.signaturePlacements.upsertMany(signatureApproval.id, [
      { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
    ]);

    await request(context.app)
      .post(`/api/approvals/${signatureApproval.id}/review`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ role: "supervisor", decision: "approved", comment: "同意" })
      .expect(200);
    const final = await request(context.app)
      .post(`/api/approvals/${signatureApproval.id}/review`)
      .set("Authorization", `Bearer ${context.processToken}`)
      .send({ role: "process", decision: "approved", comment: "同意" })
      .expect(200);

    expect(final.body.signatureStatus).toBe("generated");
    expect(final.body.signedFilePath).toContain("签名件-a0A0-签审.pdf");
    await expect(fs.stat(final.body.signedFilePath)).resolves.toBeTruthy();
    expect(context.operationLogs.listForTarget("approval", signatureApproval.id).map((log) => log.action)).toContain(
      "signature.generated"
    );

    const signedFile = await request(context.app)
      .get(`/api/approvals/${signatureApproval.id}/signed-file`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(200);
    expect(signedFile.headers["content-type"]).toContain("application/pdf");
    expect(signedFile.headers["cache-control"]).toContain("no-store");
  });

  it("returns 404 when a signed PDF is not available", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .get(`/api/approvals/${context.approval.id}/signed-file`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(404);

    expect(response.body.error).toBe("SIGNED_FILE_NOT_FOUND");
  });

  it("lets admins retry signed PDF generation", async () => {
    const context = await appContext();
    const approval = await prepareSignatureApproval(context, { status: "approved_for_print" });
    context.approvals.setSignatureStatus(approval.id, "failed", "previous failure");

    const response = await request(context.app)
      .post(`/api/approvals/${approval.id}/generate-signed-pdf`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200);

    expect(response.body.signatureStatus).toBe("generated");
    expect(response.body.signedFilePath).toContain("-签审.pdf");
  });

  it("lets designers regenerate signed PDFs for approved drawings", async () => {
    const context = await appContext();
    const approval = await prepareSignatureApproval(context, { status: "approved_for_print" });
    context.approvals.setSignatureStatus(approval.id, "failed", "previous failure");

    const response = await request(context.app)
      .post(`/api/approvals/${approval.id}/generate-signed-pdf`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);

    expect(response.body.signatureStatus).toBe("generated");
    expect(response.body.signedFilePath).toContain("-签审.pdf");
  });

  it("rejects signed PDF retry requests from reviewers", async () => {
    const context = await appContext();
    const approval = await prepareSignatureApproval(context, { status: "approved_for_print" });

    await request(context.app)
      .post(`/api/approvals/${approval.id}/generate-signed-pdf`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(403);
  });

  it("rejects signed PDF generation before both reviews pass", async () => {
    const context = await appContext();
    const approval = await prepareSignatureApproval(context);

    const response = await request(context.app)
      .post(`/api/approvals/${approval.id}/generate-signed-pdf`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(400);

    expect(response.body.error).toBe("APPROVAL_NOT_SIGNABLE");
    expect(context.approvals.getById(approval.id)?.signatureStatus).toBe("pending");
  });

  it("rejects signed PDF generation for approvals that do not require signing", async () => {
    const context = await appContext();
    context.approvals.review(context.approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    context.approvals.review(context.approval.id, { role: "process", decision: "approved", comment: "同意" });

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/generate-signed-pdf`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(400);

    expect(response.body.error).toBe("SIGNATURE_NOT_REQUIRED");
  });

  it("batch regenerates signed PDFs with per-approval results for designers and admins only", async () => {
    const context = await appContext();
    const signable = await prepareSignatureApproval(context, { status: "approved_for_print" });
    const pending = await prepareSignatureApproval(context);

    const response = await request(context.app)
      .post("/api/approvals/batch/generate-signed-pdf")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ approvalIds: [signable.id, pending.id, 99999] })
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        total: 3,
        success: 1,
        failed: 2
      })
    );
    expect(response.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ approvalId: signable.id, status: "completed" }),
        expect.objectContaining({ approvalId: pending.id, status: "failed", error: "APPROVAL_NOT_SIGNABLE" }),
        expect.objectContaining({ approvalId: 99999, status: "failed", error: "APPROVAL_NOT_FOUND" })
      ])
    );
    expect(context.approvals.getById(signable.id)?.signatureStatus).toBe("generated");
    expect(context.approvals.getById(signable.id)?.signedFilePath).toContain("-签审.pdf");

    await request(context.app)
      .post("/api/approvals/batch/generate-signed-pdf")
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ approvalIds: [signable.id] })
      .expect(403);
  });

  it("batch marks printable approvals as archived and reports missing signed PDFs per item", async () => {
    const context = await appContext();
    const ready = await prepareSignatureApproval(context, { status: "approved_for_print" });
    const missingSignedPdf = await prepareSignatureApproval(context, { status: "approved_for_print" });
    const generated = await request(context.app)
      .post(`/api/approvals/${ready.id}/generate-signed-pdf`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);
    const signedBeforeArchive = generated.body.signedFilePath as string;

    const response = await request(context.app)
      .post("/api/approvals/batch/mark-printed")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ approvalIds: [ready.id, missingSignedPdf.id] })
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        total: 2,
        success: 1,
        failed: 1
      })
    );
    expect(response.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ approvalId: ready.id, status: "completed" }),
        expect.objectContaining({ approvalId: missingSignedPdf.id, status: "failed", error: "SIGNED_PDF_REQUIRED" })
      ])
    );
    const archived = context.approvals.getById(ready.id);
    expect(archived?.status).toBe("printed_archived");
    expect(archived?.signedFilePath).toContain("05-已打印归档");
    await expect(fs.stat(archived!.signedFilePath!)).resolves.toBeTruthy();
    await expect(fs.stat(signedBeforeArchive)).rejects.toThrow();
    expect(context.approvals.getById(missingSignedPdf.id)?.status).toBe("approved_for_print");
  });

  it("lets admins save signature placements for folder-submitted approvals", async () => {
    const context = await appContext();
    context.approvals.setSignatureStatus(context.approval.id, "placement_required");

    const response = await request(context.app)
      .put(`/api/approvals/${context.approval.id}/signature-placements`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({
        placements: [
          { role: "designer", pageNumber: 1, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
          { role: "supervisor", pageNumber: 1, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
          { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
        ]
      })
      .expect(200);

    expect(response.body.approval.signatureStatus).toBe("pending");
    expect(response.body.placements.map((placement: { role: string }) => placement.role)).toEqual(["designer", "supervisor", "process"]);
    expect(context.signaturePlacements.hasRequiredPlacements(context.approval.id)).toBe(true);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain(
      "signature.placements_saved"
    );
  });

  it("lets designers save signature placements but rejects reviewers", async () => {
    const context = await appContext();
    context.approvals.setSignatureStatus(context.approval.id, "placement_required");
    const placements = [
      { role: "designer", pageNumber: 1, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
    ];

    await request(context.app)
      .put(`/api/approvals/${context.approval.id}/signature-placements`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ placements })
      .expect(403);

    const response = await request(context.app)
      .put(`/api/approvals/${context.approval.id}/signature-placements`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ placements })
      .expect(200);

    expect(response.body.approval.signatureStatus).toBe("pending");
  });

  it("rejects duplicate signature placement roles without mixing old positions", async () => {
    const context = await appContext();
    context.approvals.setSignatureStatus(context.approval.id, "placement_required");
    const originalPlacements = [
      { role: "designer", pageNumber: 1, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
    ];
    context.signaturePlacements.upsertMany(context.approval.id, originalPlacements as never);

    const response = await request(context.app)
      .put(`/api/approvals/${context.approval.id}/signature-placements`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        placements: [
          { role: "designer", pageNumber: 1, xRatio: 0.1, yRatio: 0.1, widthRatio: 0.12, heightRatio: 0.055 },
          { role: "designer", pageNumber: 1, xRatio: 0.2, yRatio: 0.2, widthRatio: 0.12, heightRatio: 0.055 },
          { role: "supervisor", pageNumber: 1, xRatio: 0.3, yRatio: 0.3, widthRatio: 0.12, heightRatio: 0.055 }
        ]
      })
      .expect(400);

    expect(response.body.error).toBe("SIGNATURE_PLACEMENTS_REQUIRED");
    expect(context.signaturePlacements.listForApproval(context.approval.id).map(({ role, xRatio }) => ({ role, xRatio }))).toEqual([
      { role: "designer", xRatio: 0.58 },
      { role: "supervisor", xRatio: 0.72 },
      { role: "process", xRatio: 0.86 }
    ]);
  });

  it("lists saved signature placements for an approval", async () => {
    const context = await appContext();
    context.signaturePlacements.upsertMany(context.approval.id, [
      { role: "designer", pageNumber: 1, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
    ]);

    const response = await request(context.app)
      .get(`/api/approvals/${context.approval.id}/signature-placements`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(200);

    expect(response.body.map((placement: { role: string }) => placement.role)).toEqual(["designer", "supervisor", "process"]);
  });

  it("lets designers save current approval placements as a signature template", async () => {
    const context = await appContext();
    context.signaturePlacements.upsertMany(context.approval.id, [
      { role: "designer", pageNumber: 1, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
    ]);

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/signature-templates`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ name: "A3 标准图框", projectName: "项目A" })
      .expect(201);

    expect(response.body).toEqual(expect.objectContaining({ name: "A3 标准图框", projectName: "项目A" }));
    expect(response.body.createdByUserId).toBe(context.designer.id);
    expect(response.body.placements.map((placement: { role: string }) => placement.role)).toEqual(["designer", "supervisor", "process"]);
    expect(context.signatureTemplates.list({ projectName: "项目A" }).map((template) => template.id)).toContain(response.body.id);
  });

  it("rejects saving a signature template when approval placements are incomplete", async () => {
    const context = await appContext();
    context.signaturePlacements.upsertMany(context.approval.id, [
      { role: "designer", pageNumber: 1, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
    ]);

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/signature-templates`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ name: "不完整模板", projectName: "项目A" })
      .expect(400);

    expect(response.body.error).toBe("SIGNATURE_PLACEMENTS_REQUIRED");
    expect(context.signatureTemplates.list({ projectName: "项目A" })).toHaveLength(0);
  });

  it("generates a signed PDF after placements are saved on an already approved approval", async () => {
    const context = await appContext();
    const signedSourcePath = path.join(context.watchRoot, "02-审批中", "项目A", "补签件-a0A0.pdf");
    await createValidPdf(signedSourcePath);
    const signatureDir = path.join(context.watchRoot, "signatures");
    await fs.mkdir(signatureDir, { recursive: true });
    const designerSignature = path.join(signatureDir, "designer-late.png");
    const supervisorSignature = path.join(signatureDir, "supervisor-late.png");
    const processSignature = path.join(signatureDir, "process-late.png");
    await fs.writeFile(designerSignature, pngBytes);
    await fs.writeFile(supervisorSignature, pngBytes);
    await fs.writeFile(processSignature, pngBytes);
    const approval = context.approvals.create({
      projectName: "项目A",
      partName: "补签件",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: signedSourcePath,
      currentFilePath: signedSourcePath,
      submittedByUserId: context.designer.id,
      source: "folder_watch",
      signatureStatus: "placement_required"
    });
    context.signatureAssets.replaceActiveForUser({ userId: context.designer.id, kind: "uploaded_png", filePath: designerSignature });
    context.signatureAssets.replaceActiveForUser({ userId: context.supervisor.id, kind: "uploaded_png", filePath: supervisorSignature });
    context.signatureAssets.replaceActiveForUser({ userId: context.process.id, kind: "uploaded_png", filePath: processSignature });

    await request(context.app)
      .post(`/api/approvals/${approval.id}/review`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ role: "supervisor", decision: "approved", comment: "同意" })
      .expect(200);
    const approved = await request(context.app)
      .post(`/api/approvals/${approval.id}/review`)
      .set("Authorization", `Bearer ${context.processToken}`)
      .send({ role: "process", decision: "approved", comment: "同意" })
      .expect(200);
    expect(approved.body.signatureStatus).toBe("failed");

    const response = await request(context.app)
      .put(`/api/approvals/${approval.id}/signature-placements`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({
        placements: [
          { role: "designer", pageNumber: 1, xRatio: 0.58, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
          { role: "supervisor", pageNumber: 1, xRatio: 0.72, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 },
          { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.12, heightRatio: 0.055 }
        ]
      })
      .expect(200);

    expect(response.body.approval.signatureStatus).toBe("generated");
    expect(response.body.approval.signedFilePath).toContain("补签件-a0A0-签审.pdf");
    await expect(fs.stat(response.body.approval.signedFilePath)).resolves.toBeTruthy();
  });

  it("requires rejection comment", async () => {
    const context = await appContext();

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/review`)
      .set("Authorization", `Bearer ${context.processToken}`)
      .send({ role: "process", decision: "rejected" })
      .expect(400);
  });

  it("allows rejection without text when the drawing has an open annotation", async () => {
    const context = await appContext();
    context.approvalAnnotations.create({
      approvalId: context.approval.id,
      authorUserId: context.process.id,
      kind: "rect",
      message: "标题栏材料需补充",
      pageNumber: 1,
      xRatio: 0.1,
      yRatio: 0.2,
      widthRatio: 0.3,
      heightRatio: 0.12,
      color: "red"
    });

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/review`)
      .set("Authorization", `Bearer ${context.processToken}`)
      .send({ role: "process", decision: "rejected" })
      .expect(200);

    expect(response.body.status).toBe("rejected");
    expect(response.body.processComment).toBeNull();
  });

  it("rejects review requests after an approval is already printable", async () => {
    const context = await appContext();
    context.approvals.review(context.approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    context.approvals.review(context.approval.id, { role: "process", decision: "approved", comment: "同意" });

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/review`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ role: "supervisor", decision: "rejected", comment: "重新驳回" })
      .expect(400);

    expect(response.body.error).toBe("APPROVAL_NOT_REVIEWABLE");
    expect(context.approvals.getById(context.approval.id)?.status).toBe("approved_for_print");
  });

  it("does not include file missing approvals in reviewer task queues", async () => {
    const context = await appContext();
    context.approvals.markFileMissing(context.approval.id);

    const response = await request(context.app)
      .get("/api/approvals?mine=1")
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it("lets admins void an approval with a reason", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/void`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ reason: "提交错版本" })
      .expect(200);

    expect(response.body.status).toBe("voided");
    const logs = context.operationLogs.listForTarget("approval", context.approval.id);
    expect(logs.map((log) => log.action)).toContain("approval.voided");
    expect(logs.at(-1)?.metadata).toEqual({ reason: "提交错版本" });
  });

  it("does not include voided approvals in reviewer task queues", async () => {
    const context = await appContext();

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/void`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ reason: "提交错版本" })
      .expect(200);

    const response = await request(context.app)
      .get("/api/approvals?mine=1")
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it("rejects void requests from non-admin users", async () => {
    const context = await appContext();

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/void`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ reason: "提交错版本" })
      .expect(403);
  });

  it("rejects void requests without a reason", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/void`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ reason: " " })
      .expect(400);

    expect(response.body.error).toBe("INVALID_INPUT");
  });

  it("lets admins delete an approval and its managed files", async () => {
    const context = await appContext();
    const reviewingProjectDir = path.dirname(context.approval.currentFilePath);
    const signedPath = path.join(context.watchRoot, "04-已通过待打印", "项目A", "轴承座-a0A0-签审-3.pdf");
    const signedProjectDir = path.dirname(signedPath);
    const firstSignedPath = path.join(context.watchRoot, "04-已通过待打印", "项目A", "轴承座-a0A0-签审.pdf");
    const secondSignedPath = path.join(context.watchRoot, "04-已通过待打印", "项目A", "轴承座-a0A0-签审-2.pdf");
    const otherVersionSignedPath = path.join(context.watchRoot, "04-已通过待打印", "项目A", "轴承座-a1A0-签审.pdf");
    await fs.mkdir(path.dirname(signedPath), { recursive: true });
    await fs.writeFile(firstSignedPath, "%PDF-1.7\nsigned");
    await fs.writeFile(secondSignedPath, "%PDF-1.7\nsigned");
    await fs.writeFile(signedPath, "%PDF-1.7\nsigned");
    await fs.writeFile(otherVersionSignedPath, "%PDF-1.7\nother version");
    context.approvals.setSignedFile(context.approval.id, signedPath, "signed-hash");
    context.signaturePlacements.upsertMany(context.approval.id, [
      { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
      { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
    ]);
    context.approvalAnnotations.create({
      approvalId: context.approval.id,
      authorUserId: context.supervisor.id,
      kind: "rect",
      message: "标题栏材料需补充",
      pageNumber: 1,
      xRatio: 0.1,
      yRatio: 0.2,
      widthRatio: 0.3,
      heightRatio: 0.12,
      color: "red"
    });

    const response = await request(context.app)
      .delete(`/api/approvals/${context.approval.id}`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200);

    expect(response.body.deleted).toBe(true);
    expect(context.approvals.getById(context.approval.id)).toBeNull();
    expect(context.signaturePlacements.listForApproval(context.approval.id)).toEqual([]);
    expect(context.approvalAnnotations.listForApproval(context.approval.id)).toEqual([]);
    await expect(fs.stat(context.approval.currentFilePath)).rejects.toThrow();
    await expect(fs.stat(firstSignedPath)).rejects.toThrow();
    await expect(fs.stat(secondSignedPath)).rejects.toThrow();
    await expect(fs.stat(signedPath)).rejects.toThrow();
    await expect(fs.stat(reviewingProjectDir)).rejects.toThrow();
    await expect(fs.stat(otherVersionSignedPath)).resolves.toBeTruthy();
    await expect(fs.stat(signedProjectDir)).resolves.toBeTruthy();
    expect(response.body.deletedFiles).toEqual(
      expect.arrayContaining([expect.stringContaining("轴承座-a0A0-签审.pdf"), expect.stringContaining("轴承座-a0A0-签审-2.pdf")])
    );
    expect(context.operationLogs.listRecent(5).map((log) => log.action)).toContain("approval.deleted");
  });

  it("keeps the approval record when managed file deletion fails", async () => {
    const context = await appContext();
    await fs.rm(context.approval.currentFilePath, { force: true });
    await fs.mkdir(context.approval.currentFilePath, { recursive: true });

    await request(context.app)
      .delete(`/api/approvals/${context.approval.id}`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(500);

    expect(context.approvals.getById(context.approval.id)).not.toBeNull();
  });

  it("rejects approval deletion from non-admin users", async () => {
    const context = await appContext();

    await request(context.app)
      .delete(`/api/approvals/${context.approval.id}`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(403);

    expect(context.approvals.getById(context.approval.id)).not.toBeNull();
  });

  it("lets admins rebind a missing approval to an existing valid PDF", async () => {
    const context = await appContext();
    context.approvals.markFileMissing(context.approval.id);
    const replacement = path.join(context.watchRoot, "02-审批中", "项目A", "轴承座-a1A0.pdf");
    await fs.writeFile(replacement, "%PDF-1.7\n");

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/rebind-file`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ filePath: replacement })
      .expect(200);

    expect(response.body.status).toBe("pending");
    expect(response.body.currentFilePath).toBe(replacement);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain(
      "approval.file_rebound"
    );
  });

  it("rejects rebind requests for missing files", async () => {
    const context = await appContext();
    context.approvals.markFileMissing(context.approval.id);

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/rebind-file`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ filePath: path.join(context.watchRoot, "02-审批中", "项目A", "不存在-a0A0.pdf") })
      .expect(400);

    expect(response.body.error).toBe("FILE_NOT_FOUND");
  });

  it("rejects rebind requests for invalid PDFs", async () => {
    const context = await appContext();
    context.approvals.markFileMissing(context.approval.id);
    const replacement = path.join(context.watchRoot, "02-审批中", "项目A", "无效-a0A0.pdf");
    await fs.writeFile(replacement, "not a real pdf");

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/rebind-file`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ filePath: replacement })
      .expect(422);

    expect(response.body.error).toBe("INVALID_PDF_FILE");
  });

  it("rejects rebind requests outside the watch root", async () => {
    const context = await appContext();
    context.approvals.markFileMissing(context.approval.id);
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-outside-"));
    const replacement = path.join(outsideDir, "轴承座-a1A0.pdf");
    await fs.writeFile(replacement, "%PDF-1.7\n");

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/rebind-file`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ filePath: replacement })
      .expect(400);

    expect(response.body.error).toBe("FILE_OUTSIDE_WATCH_ROOT");
  });

  it("rejects rebind requests for approvals that are not in a repairable file state", async () => {
    const context = await appContext();
    context.approvals.review(context.approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    context.approvals.review(context.approval.id, { role: "process", decision: "approved", comment: "同意" });
    const replacement = path.join(context.watchRoot, "02-审批中", "项目A", "轴承座-a1A0.pdf");
    await fs.writeFile(replacement, "%PDF-1.7\n");

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/rebind-file`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ filePath: replacement })
      .expect(400);

    expect(response.body.error).toBe("APPROVAL_NOT_REPAIRABLE");
    expect(context.approvals.getById(context.approval.id)?.status).toBe("approved_for_print");
  });

  it("lets admins retry validation and restore a valid PDF to pending", async () => {
    const context = await appContext();
    const invalid = context.approvals.create({
      projectName: "项目A",
      partName: "校验件",
      version: "a1A0",
      minorVersion: "a1",
      majorVersion: "A0",
      originalFilePath: context.approval.currentFilePath,
      currentFilePath: context.approval.currentFilePath,
      status: "invalid_pdf"
    });
    await fs.writeFile(invalid.currentFilePath, "%PDF-1.7\n");

    const response = await request(context.app)
      .post(`/api/approvals/${invalid.id}/retry-validation`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200);

    expect(response.body.status).toBe("pending");
    expect(context.operationLogs.listForTarget("approval", invalid.id).map((log) => log.action)).toContain(
      "approval.validation_retried"
    );
  });

  it("rejects retry validation for approvals that are not invalid PDFs", async () => {
    const context = await appContext();
    await createValidPdf(context.approval.currentFilePath);
    context.approvals.review(context.approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    context.approvals.review(context.approval.id, { role: "process", decision: "approved", comment: "同意" });

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/retry-validation`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(400);

    expect(response.body.error).toBe("APPROVAL_NOT_VALIDATION_RETRYABLE");
    expect(context.approvals.getById(context.approval.id)?.status).toBe("approved_for_print");
  });
});
