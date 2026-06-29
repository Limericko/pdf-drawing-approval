import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createDatabase } from "../db.ts";
import { createServer } from "../server.ts";
import { ApprovalAnnotationRepository } from "../repositories/approvalAnnotations.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { UserRepository } from "../repositories/users.ts";

async function appContext() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-annotations-route-"));
  const currentFilePath = path.join(dir, "批注件-a0A0.pdf");
  await createValidPdf(currentFilePath);
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const approvalAnnotations = new ApprovalAnnotationRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const users = new UserRepository(db);
  const settings = new SettingsRepository(db);
  const supervisor = users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  const process = users.create({ username: "process", password: "123456", role: "process", displayName: "工艺" });
  const admin = users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const approval = approvals.create({
    projectName: "项目A",
    partName: "批注件",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: currentFilePath,
    currentFilePath
  });
  const app = createServer(
    { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
    { db, approvals, approvalAnnotations, users, settings, operationLogs }
  );
  const supervisorLogin = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });
  const processLogin = await request(app).post("/api/auth/login").send({ username: "process", password: "123456" });
  const adminLogin = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
  const designerLogin = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });

  return {
    app,
    db,
    approval,
    currentFilePath,
    approvals,
    approvalAnnotations,
    operationLogs,
    supervisor,
    process,
    admin,
    designer,
    supervisorToken: supervisorLogin.body.token,
    processToken: processLogin.body.token,
    adminToken: adminLogin.body.token,
    designerToken: designerLogin.body.token
  };
}

async function createValidPdf(filePath: string) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await fs.writeFile(filePath, await pdf.save());
}

function rectAnnotation(message = "标题栏材料需补充") {
  return {
    kind: "rect" as const,
    message,
    pageNumber: 1,
    xRatio: 0.1,
    yRatio: 0.2,
    widthRatio: 0.3,
    heightRatio: 0.12,
    color: "red" as const
  };
}

describe("approval annotation routes", () => {
  it("lets authenticated users list annotations", async () => {
    const context = await appContext();
    context.approvalAnnotations.create({
      approvalId: context.approval.id,
      authorUserId: context.supervisor.id,
      ...rectAnnotation()
    });

    const response = await request(context.app)
      .get(`/api/approvals/${context.approval.id}/annotations`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({
        kind: "rect",
        message: "标题栏材料需补充",
        authorDisplayName: "主管",
        resolved: false
      })
    ]);
  });

  it("lets reviewers and admins create annotations but rejects designers", async () => {
    const context = await appContext();

    const created = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/annotations`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send(rectAnnotation())
      .expect(201);

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/annotations`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send(rectAnnotation("设计师不能新增"))
      .expect(403);

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/annotations`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ ...rectAnnotation("管理员批注"), color: "blue" })
      .expect(201);

    expect(created.body).toEqual(expect.objectContaining({ id: expect.any(Number), authorRole: "supervisor" }));
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain(
      "approval.annotation_created"
    );
  });

  it("accepts custom annotation colors through the API", async () => {
    const context = await appContext();
    const customStyleJson = JSON.stringify({ strokeColor: "#7c3aed" });

    const created = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/annotations`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ ...rectAnnotation("自定义颜色批注"), color: "custom", styleJson: customStyleJson })
      .expect(201);

    expect(created.body).toEqual(
      expect.objectContaining({
        color: "custom",
        styleJson: customStyleJson
      })
    );

    const updatedStyleJson = JSON.stringify({ strokeColor: "#176b87" });
    const updated = await request(context.app)
      .put(`/api/approvals/${context.approval.id}/annotations/${created.body.id}`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ ...rectAnnotation("更新自定义颜色"), color: "custom", styleJson: updatedStyleJson })
      .expect(200);

    expect(updated.body).toEqual(
      expect.objectContaining({
        color: "custom",
        styleJson: updatedStyleJson
      })
    );
  });

  it("allows only annotation authors and admins to update or delete unresolved annotations", async () => {
    const context = await appContext();
    const annotation = context.approvalAnnotations.create({
      approvalId: context.approval.id,
      authorUserId: context.supervisor.id,
      ...rectAnnotation()
    });

    await request(context.app)
      .put(`/api/approvals/${context.approval.id}/annotations/${annotation.id}`)
      .set("Authorization", `Bearer ${context.processToken}`)
      .send({ ...rectAnnotation("工艺不能改主管批注"), color: "amber" })
      .expect(403);

    const updated = await request(context.app)
      .put(`/api/approvals/${context.approval.id}/annotations/${annotation.id}`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ ...rectAnnotation("主管更新批注"), color: "green" })
      .expect(200);

    expect(updated.body).toEqual(expect.objectContaining({ message: "主管更新批注", color: "green" }));

    await request(context.app)
      .delete(`/api/approvals/${context.approval.id}/annotations/${annotation.id}`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200);

    expect(context.approvalAnnotations.listForApproval(context.approval.id)).toEqual([]);
  });

  it("lets designers resolve annotations", async () => {
    const context = await appContext();
    const annotation = context.approvalAnnotations.create({
      approvalId: context.approval.id,
      authorUserId: context.supervisor.id,
      ...rectAnnotation()
    });

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/annotations/${annotation.id}/resolve`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);

    expect(response.body.resolved).toBe(true);
    expect(response.body.resolvedByUserId).toBe(context.designer.id);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain(
      "approval.annotation_resolved"
    );
  });

  it("rejects annotation edits on readonly approvals", async () => {
    const context = await appContext();
    context.approvals.voidApproval(context.approval.id);

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/annotations`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send(rectAnnotation())
      .expect(409);
  });

  it("lets reviewers reset annotations to the initial unannotated state", async () => {
    const context = await appContext();
    context.approvalAnnotations.create({
      approvalId: context.approval.id,
      authorUserId: context.supervisor.id,
      ...rectAnnotation("第一条批注")
    });
    context.approvalAnnotations.create({
      approvalId: context.approval.id,
      authorUserId: context.process.id,
      ...rectAnnotation("第二条批注")
    });

    const response = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/annotations/reset`)
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .expect(200);

    expect(response.body).toEqual({ reset: true, deletedCount: 2 });
    expect(context.approvalAnnotations.listForApproval(context.approval.id)).toEqual([]);
    const resetLog = context.operationLogs
      .listForTarget("approval", context.approval.id)
      .find((log) => log.action === "approval.annotations_reset");
    expect(resetLog).toEqual(expect.objectContaining({ actorUsername: "supervisor" }));
    expect(resetLog?.metadata).toEqual(expect.objectContaining({ deletedCount: 2 }));
  });

  it("rejects annotation reset from designers and readonly approvals", async () => {
    const context = await appContext();
    context.approvalAnnotations.create({
      approvalId: context.approval.id,
      authorUserId: context.supervisor.id,
      ...rectAnnotation()
    });

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/annotations/reset`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(403);

    context.approvals.voidApproval(context.approval.id);

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/annotations/reset`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(409);

    expect(context.approvalAnnotations.listForApproval(context.approval.id)).toHaveLength(1);
  });

  it("returns a separate annotated review PDF and records an operation log", async () => {
    const context = await appContext();
    context.approvalAnnotations.create({
      approvalId: context.approval.id,
      authorUserId: context.supervisor.id,
      ...rectAnnotation()
    });
    const source = await fs.readFile(context.currentFilePath);

    const response = await request(context.app)
      .get(`/api/approvals/${context.approval.id}/annotated-file?token=${context.designerToken}`)
      .expect(200);

    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.from(response.body).subarray(0, 5).toString()).toBe("%PDF-");
    expect(response.body.length).toBeGreaterThan(source.length);
    expect(await fs.readFile(context.currentFilePath)).toEqual(source);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain(
      "approval.annotated_pdf_opened"
    );
  });

  it("returns 404 when the annotated PDF source file is missing", async () => {
    const context = await appContext();
    await fs.rm(context.currentFilePath, { force: true });

    await request(context.app)
      .get(`/api/approvals/${context.approval.id}/annotated-file?token=${context.designerToken}`)
      .expect(404);
  });

  it("returns INVALID_PDF_FILE when the annotated PDF source is not a real PDF", async () => {
    const context = await appContext();
    await fs.writeFile(context.currentFilePath, "not a pdf");

    const response = await request(context.app)
      .get(`/api/approvals/${context.approval.id}/annotated-file?token=${context.designerToken}`)
      .expect(422);

    expect(response.body.error).toBe("INVALID_PDF_FILE");
  });
});
