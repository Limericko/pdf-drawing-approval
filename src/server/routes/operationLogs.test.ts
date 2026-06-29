import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

function createAppContext() {
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const users = new UserRepository(db);
  users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  const approval = approvals.create({
    projectName: "项目A",
    partName: "轴承座",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "G:\\Nutstore\\01-待提交\\项目A\\轴承座-a0A0.pdf",
    currentFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a0A0.pdf"
  });
  operationLogs.create({
    actorUserId: 1,
    actorUsername: "admin",
    action: "approval.created",
    targetType: "approval",
    targetId: approval.id,
    message: "图纸进入审批",
    metadata: { version: approval.version }
  });
  operationLogs.create({
    actorUserId: 1,
    actorUsername: "admin",
    action: "system.restart_requested",
    targetType: "system",
    message: "管理员请求重启系统"
  });
  const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, approvals, users });

  return { app, approval };
}

describe("operation log routes", () => {
  it("lets admins list recent operation logs", async () => {
    const { app } = createAppContext();
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app).get("/api/operation-logs").set("Authorization", `Bearer ${login.body.token}`).expect(200);

    expect(response.body.map((log: { action: string }) => log.action)).toEqual([
      "system.restart_requested",
      "approval.created"
    ]);
    expect(response.body[1].metadata).toEqual({ version: "a0A0" });
  });

  it("lets authenticated users list logs for an approval", async () => {
    const { app, approval } = createAppContext();
    const login = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });

    const response = await request(app)
      .get(`/api/approvals/${approval.id}/operation-logs`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].action).toBe("approval.created");
  });

  it("does not let non-admin users list global operation logs", async () => {
    const { app } = createAppContext();
    const login = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });

    await request(app).get("/api/operation-logs").set("Authorization", `Bearer ${login.body.token}`).expect(403);
  });
});
