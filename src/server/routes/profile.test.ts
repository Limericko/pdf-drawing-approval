import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { UserPreferenceRepository } from "../repositories/userPreferences.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

async function appContext() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const settings = new SettingsRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const userPreferences = new UserPreferenceRepository(db);
  const designer = users.create({
    username: "designer",
    password: "123456",
    role: "designer",
    displayName: "设计师",
    email: "old@example.com"
  });
  const admin = users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  const mailTransport = { sendMail: vi.fn(async (_message: { to?: string }) => undefined) };
  const app = createServer(
    { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
    { db, users, settings, operationLogs, userPreferences, mailTransport }
  );
  const login = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });
  const adminLogin = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
  return {
    app,
    users,
    userPreferences,
    operationLogs,
    designer,
    admin,
    mailTransport,
    token: login.body.token as string,
    adminToken: adminLogin.body.token as string
  };
}

describe("profile routes", () => {
  it("returns the authenticated user's profile with role-specific notification events", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .get("/api/profile")
      .set("Authorization", `Bearer ${context.token}`)
      .expect(200);

    expect(response.body.user).toEqual(
      expect.objectContaining({ username: "designer", role: "designer", displayName: "设计师", email: "old@example.com" })
    );
    expect(response.body.commonProjects).toEqual([]);
    expect(response.body.notificationPreferences.email.approvalRejected).toBe(true);
    expect(response.body.availableNotificationEvents.map((event: { key: string }) => event.key)).toEqual([
      "approvalRejected",
      "approvalApprovedForPrint",
      "signatureFailed",
      "approvalPrinted"
    ]);
  });

  it("updates only self-service profile fields and preferences", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .put("/api/profile")
      .set("Authorization", `Bearer ${context.token}`)
      .send({
        username: "hacked",
        role: "admin",
        active: false,
        displayName: "张工",
        email: "designer@example.com",
        commonProjects: [" 项目A ", "项目A", "项目B"],
        notificationPreferences: { email: { approvalRejected: false, approvalPrinted: true } }
      })
      .expect(200);

    expect(response.body.user).toEqual(
      expect.objectContaining({ id: context.designer.id, username: "designer", role: "designer", displayName: "张工", email: "designer@example.com" })
    );
    expect(response.body.commonProjects).toEqual(["项目A", "项目B"]);
    expect(response.body.notificationPreferences.email.approvalRejected).toBe(false);
    expect(response.body.notificationPreferences.email.approvalPrinted).toBe(true);
    expect(context.users.getById(context.designer.id)).toEqual(
      expect.objectContaining({ username: "designer", role: "designer", active: true })
    );
    expect(context.operationLogs.listRecent().map((log) => log.action)).toContain("user.profile_updated");
  });

  it("does not expose or save common projects for admins", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .put("/api/profile")
      .set("Authorization", `Bearer ${context.adminToken}`)
      .send({
        displayName: "系统管理员",
        email: "admin@example.com",
        commonProjects: ["项目A"],
        notificationPreferences: { email: { signatureFailed: true, systemRisk: true } }
      })
      .expect(200);

    expect(response.body.user).toEqual(expect.objectContaining({ username: "admin", role: "admin", displayName: "系统管理员" }));
    expect(response.body.commonProjects).toEqual([]);
    expect(context.userPreferences.getForUser(context.admin).commonProjects).toEqual([]);

    const getResponse = await request(context.app)
      .get("/api/profile")
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200);

    expect(getResponse.body.commonProjects).toEqual([]);
    expect(getResponse.body.availableNotificationEvents.map((event: { key: string }) => event.key)).toEqual([
      "signatureFailed",
      "systemRisk"
    ]);
  });

  it("sends a test email to the authenticated user's own email address", async () => {
    const context = await appContext();

    await request(context.app)
      .post("/api/profile/test-email")
      .set("Authorization", `Bearer ${context.token}`)
      .expect(200, { sent: true });

    expect(context.mailTransport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "old@example.com",
        subject: expect.stringContaining("测试邮件")
      })
    );
    expect(context.operationLogs.listRecent().map((log) => log.action)).toContain("user.profile_test_email_sent");
  });

  it("rejects unauthenticated and invalid profile requests", async () => {
    const context = await appContext();

    await request(context.app).get("/api/profile").expect(401);
    await request(context.app)
      .put("/api/profile")
      .set("Authorization", `Bearer ${context.token}`)
      .send({ displayName: "", email: "bad-email" })
      .expect(400);
  });
});
