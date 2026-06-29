import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

function createContext() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const approvals = new ApprovalRepository(db);
  users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const approval = approvals.create({
    projectName: "项目A",
    partName: "轴承座",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "G:\\Nutstore\\01-待提交\\项目A\\轴承座-a0A0.pdf",
    currentFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a0A0.pdf"
  });
  const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, approvals, users });
  return { app, approval };
}

describe("approval comment routes", () => {
  it("lets authenticated users create and list comments", async () => {
    const { app, approval } = createContext();
    const login = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });

    const created = await request(app)
      .post(`/api/approvals/${approval.id}/comments`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ kind: "comment", message: "请复核倒角尺寸" })
      .expect(201);

    expect(created.body.message).toBe("请复核倒角尺寸");
    expect(created.body.authorDisplayName).toBe("设计师");

    const list = await request(app)
      .get(`/api/approvals/${approval.id}/comments`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].kind).toBe("comment");
  });

  it("does not let anonymous users comment", async () => {
    const { app, approval } = createContext();

    await request(app)
      .post(`/api/approvals/${approval.id}/comments`)
      .send({ kind: "comment", message: "匿名意见" })
      .expect(401);
  });

  it("lets authenticated users create and resolve issues", async () => {
    const { app, approval } = createContext();
    const login = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });

    const issue = await request(app)
      .post(`/api/approvals/${approval.id}/comments`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ kind: "issue", message: "标题栏缺少材料" })
      .expect(201);

    const resolved = await request(app)
      .post(`/api/approvals/${approval.id}/comments/${issue.body.id}/resolve`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(resolved.body.resolved).toBe(true);
    expect(resolved.body.resolvedAt).toBeTruthy();
  });
});
