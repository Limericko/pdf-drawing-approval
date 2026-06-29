import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { BatchSubmissionRepository } from "../repositories/batchSubmissions.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignaturePlacementRepository } from "../repositories/signaturePlacements.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

async function appContext() {
  const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-submit-root-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-submit-data-"));
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const batchSubmissions = new BatchSubmissionRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const settings = new SettingsRepository(db);
  const signaturePlacements = new SignaturePlacementRepository(db);
  const users = new UserRepository(db);
  settings.set("watch_root", watchRoot);
  users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  const app = createServer(
    { port: 0, dataDir, databasePath: ":memory:", jwtSecret: "secret" },
    { db, approvals, batchSubmissions, operationLogs, settings, users, signaturePlacements }
  );
  const designerLogin = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });
  const supervisorLogin = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });
  const adminLogin = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
  return {
    app,
    approvals,
    batchSubmissions,
    operationLogs,
    signaturePlacements,
    watchRoot,
    dataDir,
    designerToken: designerLogin.body.token,
    supervisorToken: supervisorLogin.body.token,
    adminToken: adminLogin.body.token
  };
}

function requiredPlacements() {
  return [
    { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
    { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
    { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
  ];
}

function uploadPdf(app: ReturnType<typeof createServer>, token: string, fileName = "轴承座-a0A0.pdf") {
  return request(app)
    .post("/api/submissions/upload")
    .query({ fileName })
    .set("Authorization", `Bearer ${token}`)
    .set("Content-Type", "application/pdf")
    .send(Buffer.from("%PDF-1.7\n"));
}

function uploadBatchPdfs(
  app: ReturnType<typeof createServer>,
  token: string,
  files: Array<{ fileName: string; content?: string }>
) {
  return request(app)
    .post("/api/submissions/batch-upload")
    .set("Authorization", `Bearer ${token}`)
    .send({
      files: files.map((file) => ({
        fileName: file.fileName,
        contentBase64: Buffer.from(file.content ?? "%PDF-1.7\n").toString("base64")
      }))
    });
}

describe("submission routes", () => {
  it("lets designers upload a valid PDF and parses the drawing filename", async () => {
    const context = await appContext();

    const response = await uploadPdf(context.app, context.designerToken).expect(200);

    expect(response.body.uploadId).toMatch(/^upload-/);
    expect(response.body.originalName).toBe("轴承座-a0A0.pdf");
    expect(response.body.parsed).toEqual({
      partName: "轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      documentCode: null,
      materialCode: null,
      drawingName: "轴承座",
      metadataStatus: "missing_material_code"
    });
    expect(context.operationLogs.listRecent().map((log) => log.action)).toContain("submission.uploaded");
  });

  it("includes existing same-part versions in upload previews when the project is known", async () => {
    const context = await appContext();
    context.approvals.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "old.pdf",
      currentFilePath: "old.pdf"
    });

    const response = await request(context.app)
      .post("/api/submissions/upload")
      .query({ fileName: "轴承座-a1A0.pdf", projectName: "项目A" })
      .set("Authorization", `Bearer ${context.designerToken}`)
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("%PDF-1.7\n"))
      .expect(200);

    expect(response.body.existingVersions.map((item: { version: string }) => item.version)).toEqual(["a0A0"]);
  });

  it("looks up existing same-part versions after project or part changes", async () => {
    const context = await appContext();
    context.approvals.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "old.pdf",
      currentFilePath: "old.pdf"
    });

    const response = await request(context.app)
      .get("/api/submissions/existing-versions?projectName=项目A&partName=轴承座")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);

    expect(response.body.map((item: { version: string }) => item.version)).toEqual(["a0A0"]);
  });

  it("rejects invalid PDF uploads and non-PDF filenames", async () => {
    const context = await appContext();

    await request(context.app)
      .post("/api/submissions/upload")
      .query({ fileName: "轴承座-a0A0.pdf" })
      .set("Authorization", `Bearer ${context.designerToken}`)
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("not a pdf"))
      .expect(422);

    await request(context.app)
      .post("/api/submissions/upload")
      .query({ fileName: "轴承座-a0A0.txt" })
      .set("Authorization", `Bearer ${context.designerToken}`)
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("%PDF-1.7\n"))
      .expect(400);
  });

  it("confirms a web upload into the standard reviewing folder with placements", async () => {
    const context = await appContext();
    const upload = await uploadPdf(context.app, context.designerToken).expect(200);

    const response = await request(context.app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        uploadId: upload.body.uploadId,
        projectName: "项目A",
        partName: "轴承座",
        version: "a0A0",
        placements: requiredPlacements()
      })
      .expect(200);

    const expectedPath = path.join(context.watchRoot, "02-审批中", "项目A", "轴承座-a0A0.pdf");
    expect(response.body.source).toBe("web_upload");
    expect(response.body.submittedByUserId).toBeGreaterThan(0);
    expect(response.body.signatureStatus).toBe("pending");
    expect(response.body.currentFilePath).toBe(expectedPath);
    await expect(fs.readFile(expectedPath, "utf8")).resolves.toContain("%PDF-1.7");
    expect(context.signaturePlacements.hasRequiredPlacements(response.body.id)).toBe(true);
    const actions = context.operationLogs.listForTarget("approval", response.body.id).map((log) => log.action);
    expect(actions).toEqual(expect.arrayContaining(["approval.created", "signature.placements_saved", "notification.email_skipped"]));
  });

  it("stores PDM metadata from the uploaded standard drawing filename", async () => {
    const context = await appContext();
    const upload = await uploadPdf(context.app, context.designerToken, "MP300A000072 《0102A00700883 400A按键》 a0A0.pdf").expect(200);

    const response = await request(context.app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        uploadId: upload.body.uploadId,
        projectName: "项目A",
        partName: "400A按键",
        version: "a0A0",
        placements: requiredPlacements()
      })
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        documentCode: "MP300A000072",
        materialCode: "0102A00700883",
        drawingName: "400A按键",
        pdmMetadataStatus: "complete",
        pdmPublishStatus: "pending"
      })
    );
  });

  it("rejects duplicate project part and version submissions", async () => {
    const context = await appContext();
    context.approvals.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "old.pdf",
      currentFilePath: "old.pdf"
    });
    const upload = await uploadPdf(context.app, context.designerToken).expect(200);

    const response = await request(context.app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        uploadId: upload.body.uploadId,
        projectName: "项目A",
        partName: "轴承座",
        version: "a0A0",
        placements: requiredPlacements()
      })
      .expect(409);

    expect(response.body.error).toBe("DUPLICATE_VERSION");
  });

  it("requires all three signature placement roles", async () => {
    const context = await appContext();
    const upload = await uploadPdf(context.app, context.designerToken).expect(200);

    const response = await request(context.app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        uploadId: upload.body.uploadId,
        projectName: "项目A",
        partName: "轴承座",
        version: "a0A0",
        placements: requiredPlacements().slice(0, 2)
      })
      .expect(400);

    expect(response.body.error).toBe("SIGNATURE_PLACEMENTS_REQUIRED");
  });

  it("rejects invalid signature placement geometry before creating an approval", async () => {
    const context = await appContext();
    const upload = await uploadPdf(context.app, context.designerToken).expect(200);
    const invalidPlacements = requiredPlacements();
    invalidPlacements[0] = { ...invalidPlacements[0], xRatio: 0.95, widthRatio: 0.1 };

    const response = await request(context.app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        uploadId: upload.body.uploadId,
        projectName: "项目A",
        partName: "轴承座",
        version: "a0A0",
        placements: invalidPlacements
      })
      .timeout({ response: 1000, deadline: 2000 })
      .expect(400);

    expect(response.body.error).toBe("INVALID_SIGNATURE_PLACEMENT");
    expect(context.approvals.list()).toHaveLength(0);
  });

  it("does not let reviewers submit drawings", async () => {
    const context = await appContext();

    await uploadPdf(context.app, context.supervisorToken).expect(403);
  });

  it("does not let admins upload or submit drawings", async () => {
    const context = await appContext();

    await uploadPdf(context.app, context.adminToken).expect(403);
    await uploadBatchPdfs(context.app, context.adminToken, [{ fileName: "轴承座-a0A0.pdf" }]).expect(403);
    await request(context.app)
      .get("/api/submissions/existing-versions?projectName=项目A&partName=轴承座")
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(403);
    await request(context.app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({
        uploadId: "upload-any",
        projectName: "项目A",
        partName: "轴承座",
        version: "a0A0",
        placements: requiredPlacements()
      })
      .expect(403);
    await request(context.app)
      .post("/api/submissions/batch")
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ projectName: "项目A", items: [] })
      .expect(403);
  });

  it("batch upload accepts multiple valid PDFs and marks invalid PDFs per item", async () => {
    const context = await appContext();

    const response = await uploadBatchPdfs(context.app, context.designerToken, [
      { fileName: "轴承座-a0A0.pdf" },
      { fileName: "端盖-a1A0.pdf" },
      { fileName: "错误-a0A0.pdf", content: "not a pdf" }
    ]).expect(200);

    expect(response.body.items).toHaveLength(3);
    expect(response.body.items.map((item: { status: string }) => item.status)).toEqual(["uploaded", "uploaded", "failed"]);
    expect(response.body.items[0].uploadId).toMatch(/^upload-/);
    expect(response.body.items[1].parsed).toEqual(expect.objectContaining({ partName: "端盖", version: "a1A0" }));
    expect(response.body.items[2]).toEqual(expect.objectContaining({ fileName: "错误-a0A0.pdf", error: "INVALID_PDF_FILE" }));
  });

  it("batch confirmation creates approvals with independent placements and returns item-level results", async () => {
    const context = await appContext();
    const upload = await uploadBatchPdfs(context.app, context.designerToken, [
      { fileName: "轴承座-a0A0.pdf" },
      { fileName: "端盖-a1A0.pdf" }
    ]).expect(200);
    const firstPlacements = requiredPlacements();
    const secondPlacements = requiredPlacements().map((placement) =>
      placement.role === "designer" ? { ...placement, xRatio: 0.5 } : placement
    );

    const response = await request(context.app)
      .post("/api/submissions/batch")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        projectName: "项目A",
        items: [
          {
            uploadId: upload.body.items[0].uploadId,
            fileName: "轴承座-a0A0.pdf",
            partName: "轴承座",
            version: "a0A0",
            placements: firstPlacements,
            placementState: "manual"
          },
          {
            uploadId: upload.body.items[1].uploadId,
            fileName: "端盖-a1A0.pdf",
            partName: "端盖",
            version: "a1A0",
            placements: secondPlacements,
            placementState: "template"
          }
        ]
      })
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({ status: "completed", totalCount: 2, successCount: 2, failedCount: 0 }));
    expect(response.body.items.map((item: { status: string }) => item.status)).toEqual(["completed", "completed"]);
    expect(context.approvals.list()).toHaveLength(2);
    const created = context.approvals.list();
    const bearing = created.find((approval) => approval.partName === "轴承座")!;
    const cover = created.find((approval) => approval.partName === "端盖")!;
    expect(context.signaturePlacements.listForApproval(bearing.id).find((placement) => placement.role === "designer")?.xRatio).toBe(0.62);
    expect(context.signaturePlacements.listForApproval(cover.id).find((placement) => placement.role === "designer")?.xRatio).toBe(0.5);
    await expect(fs.readFile(path.join(context.watchRoot, "02-审批中", "项目A", "轴承座-a0A0.pdf"), "utf8")).resolves.toContain("%PDF-1.7");
    await expect(fs.readFile(path.join(context.watchRoot, "02-审批中", "项目A", "端盖-a1A0.pdf"), "utf8")).resolves.toContain("%PDF-1.7");
  });

  it("batch confirmation keeps valid items when duplicates or incomplete placements fail", async () => {
    const context = await appContext();
    context.approvals.create({
      projectName: "项目A",
      partName: "重复件",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "old.pdf",
      currentFilePath: "old.pdf"
    });
    const upload = await uploadBatchPdfs(context.app, context.designerToken, [
      { fileName: "通过件-a0A0.pdf" },
      { fileName: "重复件-a0A0.pdf" },
      { fileName: "缺签名-a0A0.pdf" }
    ]).expect(200);

    const response = await request(context.app)
      .post("/api/submissions/batch")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        projectName: "项目A",
        items: [
          {
            uploadId: upload.body.items[0].uploadId,
            fileName: "通过件-a0A0.pdf",
            partName: "通过件",
            version: "a0A0",
            placements: requiredPlacements(),
            placementState: "manual"
          },
          {
            uploadId: upload.body.items[1].uploadId,
            fileName: "重复件-a0A0.pdf",
            partName: "重复件",
            version: "a0A0",
            placements: requiredPlacements(),
            placementState: "template"
          },
          {
            uploadId: upload.body.items[2].uploadId,
            fileName: "缺签名-a0A0.pdf",
            partName: "缺签名",
            version: "a0A0",
            placements: requiredPlacements().slice(0, 2),
            placementState: "missing"
          }
        ]
      })
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({ status: "partial", totalCount: 3, successCount: 1, failedCount: 2 }));
    expect(response.body.items.map((item: { errorMessage: string | null }) => item.errorMessage)).toEqual([
      null,
      "DUPLICATE_VERSION",
      "SIGNATURE_PLACEMENTS_REQUIRED"
    ]);
    expect(context.approvals.findVersion("项目A", "通过件", "a0A0")).toBeTruthy();
    expect(context.approvals.findVersion("项目A", "缺签名", "a0A0")).toBeNull();
  });

  it("lists batch submission history and details", async () => {
    const context = await appContext();
    const upload = await uploadBatchPdfs(context.app, context.designerToken, [{ fileName: "轴承座-a0A0.pdf" }]).expect(200);
    const batch = await request(context.app)
      .post("/api/submissions/batch")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        projectName: "项目A",
        items: [
          {
            uploadId: upload.body.items[0].uploadId,
            fileName: "轴承座-a0A0.pdf",
            partName: "轴承座",
            version: "a0A0",
            placements: requiredPlacements(),
            placementState: "manual"
          }
        ]
      })
      .expect(200);

    const list = await request(context.app)
      .get("/api/submissions/batches")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);
    const detail = await request(context.app)
      .get(`/api/submissions/batches/${batch.body.id}`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);

    expect(list.body[0]).toEqual(expect.objectContaining({ id: batch.body.id, status: "completed" }));
    expect(detail.body.items).toHaveLength(1);
  });

  it("lets admins inspect batch submission history for operations", async () => {
    const context = await appContext();
    const upload = await uploadBatchPdfs(context.app, context.designerToken, [{ fileName: "轴承座-a0A0.pdf" }]).expect(200);
    const batch = await request(context.app)
      .post("/api/submissions/batch")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({
        projectName: "项目A",
        items: [
          {
            uploadId: upload.body.items[0].uploadId,
            fileName: "轴承座-a0A0.pdf",
            partName: "轴承座",
            version: "a0A0",
            placements: requiredPlacements(),
            placementState: "manual"
          }
        ]
      })
      .expect(200);

    await request(context.app).get("/api/submissions/batches").set("Authorization", `Bearer ${context.adminToken}`).expect(200);
    await request(context.app).get(`/api/submissions/batches/${batch.body.id}`).set("Authorization", `Bearer ${context.adminToken}`).expect(200);
  });
});
