import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalCommentRepository } from "../repositories/approvalComments.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

function createContext() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const approvals = new ApprovalRepository(db);
  const approvalComments = new ApprovalCommentRepository(db);
  users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const approval = approvals.create({
    projectName: "项目A",
    partName: "轴承座",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a0A0.pdf",
    currentFilePath: "G:\\Nutstore\\04-已通过待打印\\项目A\\轴承座-a0A0.pdf",
    originalFileHash: "original-hash",
    source: "web_upload",
    signatureStatus: "pending"
  });
  approvals.review(approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
  approvals.review(approval.id, { role: "process", decision: "approved", comment: "同意" });
  approvals.setSignedFile(approval.id, "G:\\Nutstore\\04-已通过待打印\\项目A\\轴承座-a0A0-签审.pdf", "signed-hash");
  approvals.create({
    projectName: "项目A",
    partName: "轴承座",
    version: "a1A0",
    minorVersion: "a1",
    majorVersion: "A0",
    originalFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a1A0.pdf",
    currentFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a1A0.pdf"
  });
  approvalComments.create({
    approvalId: approval.id,
    authorUserId: designer.id,
    kind: "issue",
    message: "尺寸公差需要复核"
  });
  approvalComments.create({
    approvalId: approval.id,
    authorUserId: designer.id,
    kind: "comment",
    message: "已通知设计师"
  });
  approvals.create({
    projectName: "项目B",
    partName: "支架",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "G:\\Nutstore\\02-审批中\\项目B\\支架-a0A0.pdf",
    currentFilePath: "G:\\Nutstore\\02-审批中\\项目B\\支架-a0A0.pdf"
  });
  const app = createServer(
    { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
    { db, approvals, approvalComments, users }
  );
  return { app };
}

describe("approval reports", () => {
  it("lets admins export an approval traceability CSV", async () => {
    const { app } = createContext();
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app)
      .get("/api/reports/approvals.csv")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.text).toContain("审批单ID,项目,零件,版本,同零件版本数,状态,提交人,提交时间");
    expect(response.text).toContain("主管状态,主管时间,工艺状态,工艺时间,签名状态,签后文件,原始哈希,签后哈希,归档时间,最近问题/评论摘要");
    expect(response.text).toContain("项目A");
    expect(response.text).toContain("项目A,轴承座,a0A0,2,approved_for_print");
    expect(response.text).toContain("signed-hash");
    expect(response.text).toContain("问题: 尺寸公差需要复核");
    expect(response.text).toContain("评论: 已通知设计师");
  });

  it("does not let non-admin users export the report", async () => {
    const { app } = createContext();
    const login = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });

    await request(app).get("/api/reports/approvals.csv").set("Authorization", `Bearer ${login.body.token}`).expect(403);
  });

  it("filters exported approvals by project and status", async () => {
    const { app } = createContext();
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app)
      .get("/api/reports/approvals.csv?projectName=项目A&status=approved_for_print")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.text).toContain("项目A");
    expect(response.text).not.toContain("项目B");
    expect(response.text).not.toContain("支架");
  });

  it("includes records from the selected end date", async () => {
    const { app } = createContext();
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    const today = new Date().toISOString().slice(0, 10);

    const response = await request(app)
      .get(`/api/reports/approvals.csv?to=${today}`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.text).toContain("项目A");
  });
});
