import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { SignatureTemplateRepository } from "../repositories/signatureTemplates.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";
import type { SignaturePlacementInput } from "../repositories/signaturePlacements.ts";

const standardPlacements: SignaturePlacementInput[] = [
  { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
  { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
  { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
];

async function appContext() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const signatureTemplates = new SignatureTemplateRepository(db);
  users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const otherDesigner = users.create({ username: "designer2", password: "123456", role: "designer", displayName: "设计二" });
  users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  const app = createServer(
    { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
    { db, users, signatureTemplates }
  );
  const adminLogin = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
  const designerLogin = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });
  const otherDesignerLogin = await request(app).post("/api/auth/login").send({ username: "designer2", password: "123456" });
  const supervisorLogin = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });

  return {
    app,
    designer,
    otherDesigner,
    signatureTemplates,
    adminToken: adminLogin.body.token,
    designerToken: designerLogin.body.token,
    otherDesignerToken: otherDesignerLogin.body.token,
    supervisorToken: supervisorLogin.body.token
  };
}

describe("signature template routes", () => {
  it("lets designers and admins list templates for a project", async () => {
    const context = await appContext();
    context.signatureTemplates.create({
      name: "通用模板",
      projectName: null,
      createdByUserId: context.designer.id,
      placements: standardPlacements
    });
    context.signatureTemplates.create({
      name: "项目模板",
      projectName: "LS-300N",
      createdByUserId: context.designer.id,
      placements: standardPlacements
    });
    context.signatureTemplates.create({
      name: "其它项目",
      projectName: "OTHER",
      createdByUserId: context.designer.id,
      placements: standardPlacements
    });

    const designerResponse = await request(context.app)
      .get("/api/signature-templates?projectName=LS-300N")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);
    expect(designerResponse.body.map((template: { name: string }) => template.name)).toEqual(["项目模板", "通用模板"]);

    await request(context.app)
      .get("/api/signature-templates")
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200);
  });

  it("lets admins list all templates when no project filter is supplied", async () => {
    const context = await appContext();
    context.signatureTemplates.create({
      name: "通用模板",
      projectName: null,
      createdByUserId: context.designer.id,
      placements: standardPlacements
    });
    context.signatureTemplates.create({
      name: "项目模板",
      projectName: "LS-300N",
      createdByUserId: context.designer.id,
      placements: standardPlacements
    });

    const response = await request(context.app)
      .get("/api/signature-templates")
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200);

    expect(response.body.map((template: { name: string }) => template.name)).toEqual(["项目模板", "通用模板"]);
  });

  it("lets designers create templates but rejects reviewers", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .post("/api/signature-templates")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ name: "A3 标准图框", projectName: "LS-300N", placements: standardPlacements })
      .expect(201);

    expect(response.body).toEqual(expect.objectContaining({ name: "A3 标准图框", projectName: "LS-300N" }));
    expect(response.body.createdByUserId).toBe(context.designer.id);

    await request(context.app)
      .post("/api/signature-templates")
      .set("Authorization", `Bearer ${context.supervisorToken}`)
      .send({ name: "主管模板", placements: standardPlacements })
      .expect(403);
  });

  it("lets admins update and delete any template", async () => {
    const context = await appContext();
    const template = context.signatureTemplates.create({
      name: "设计师模板",
      projectName: null,
      createdByUserId: context.designer.id,
      placements: standardPlacements
    });

    const updated = await request(context.app)
      .put(`/api/signature-templates/${template.id}`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({ name: "管理员调整", projectName: "项目A", placements: standardPlacements })
      .expect(200);
    expect(updated.body).toEqual(expect.objectContaining({ name: "管理员调整", projectName: "项目A" }));

    await request(context.app)
      .delete(`/api/signature-templates/${template.id}`)
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200, { deleted: true, templateId: template.id });
    expect(context.signatureTemplates.getById(template.id)).toBeNull();
  });

  it("does not let designers update or delete another user's template", async () => {
    const context = await appContext();
    const template = context.signatureTemplates.create({
      name: "他人模板",
      projectName: null,
      createdByUserId: context.otherDesigner.id,
      placements: standardPlacements
    });

    await request(context.app)
      .put(`/api/signature-templates/${template.id}`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ name: "越权修改", projectName: null, placements: standardPlacements })
      .expect(403);

    await request(context.app)
      .delete(`/api/signature-templates/${template.id}`)
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(403);
  });

  it("rejects templates without all required placement roles", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .post("/api/signature-templates")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ name: "缺少工艺", placements: standardPlacements.filter((placement) => placement.role !== "process") })
      .expect(400);

    expect(response.body.error).toBe("INVALID_SIGNATURE_TEMPLATE");
  });
});
