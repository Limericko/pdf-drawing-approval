import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db.ts";
import { PasswordResetTokenRepository, hashPasswordResetToken } from "../repositories/passwordResetTokens.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

describe("auth routes", () => {
  it("lets designers self-register and immediately log in", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const operationLogs = new OperationLogRepository(db);
    users.ensureDefaultUsers();
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, operationLogs }
    );

    const response = await request(app)
      .post("/api/auth/register-designer")
      .send({
        username: "designer01",
        password: "123456",
        displayName: "设计一",
        email: "designer01@example.com"
      })
      .expect(201);

    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body.user).toEqual(
      expect.objectContaining({
        username: "designer01",
        displayName: "设计一",
        role: "designer"
      })
    );
    expect(users.findByUsername("designer01")?.role).toBe("designer");
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("user.self_registered");

    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "designer01", password: "123456" })
      .expect(200);
    expect(login.body.user.role).toBe("designer");
  });

  it("rejects duplicate or invalid designer self-registration", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    users.ensureDefaultUsers();
    users.create({ username: "designer01", password: "123456", role: "designer", displayName: "设计一" });
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users });

    await request(app)
      .post("/api/auth/register-designer")
      .send({ username: "designer01", password: "123456", displayName: "设计一" })
      .expect(409, { error: "USERNAME_EXISTS" });

    await request(app)
      .post("/api/auth/register-designer")
      .send({ username: "ab", password: "123", displayName: "" })
      .expect(400, { error: "INVALID_INPUT" });
  });

  it("sends password reset email only when username and email match", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    const operationLogs = new OperationLogRepository(db);
    const passwordResetTokens = new PasswordResetTokenRepository(db);
    users.create({
      username: "designer01",
      password: "123456",
      role: "designer",
      displayName: "设计一",
      email: "designer01@example.com"
    });
    settings.set("smtp_host", "smtp.example.com");
    settings.set("smtp_user", "approval@example.com");
    settings.set("smtp_password", "secret");
    settings.set("smtp_from", "approval@example.com");
    settings.set("app_base_url", "http://127.0.0.1:8080");
    const mailTransport = { sendMail: vi.fn().mockResolvedValue({}) };
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, settings, operationLogs, passwordResetTokens, mailTransport }
    );

    await request(app)
      .post("/api/auth/password-reset/request")
      .send({ username: "designer01", email: "designer01@example.com" })
      .expect(200, { ok: true });

    expect(mailTransport.sendMail).toHaveBeenCalledTimes(1);
    const message = mailTransport.sendMail.mock.calls[0][0];
    expect(message.to).toBe("designer01@example.com");
    expect(message.subject).toContain("重置密码");
    expect(message.html).toContain("http://127.0.0.1:8080/#/reset-password?token=");
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("password_reset.email_sent");

    await request(app)
      .post("/api/auth/password-reset/request")
      .send({ username: "designer01", email: "wrong@example.com" })
      .expect(200, { ok: true });
    expect(mailTransport.sendMail).toHaveBeenCalledTimes(1);
  });

  it("does not create a reset token when smtp is not configured", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    const operationLogs = new OperationLogRepository(db);
    const passwordResetTokens = new PasswordResetTokenRepository(db);
    users.create({
      username: "designer01",
      password: "123456",
      role: "designer",
      displayName: "设计一",
      email: "designer01@example.com"
    });
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, settings, operationLogs, passwordResetTokens, mailTransport: null }
    );

    await request(app)
      .post("/api/auth/password-reset/request")
      .send({ username: "designer01", email: "designer01@example.com" })
      .expect(200, { ok: true });

    expect(passwordResetTokens.listForUser(1)).toHaveLength(0);
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("password_reset.email_failed");
  });

  it("resets password with a one-time email token", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    const passwordResetTokens = new PasswordResetTokenRepository(db);
    users.create({
      username: "designer01",
      password: "123456",
      role: "designer",
      displayName: "设计一",
      email: "designer01@example.com"
    });
    settings.set("smtp_host", "smtp.example.com");
    settings.set("smtp_user", "approval@example.com");
    settings.set("smtp_password", "secret");
    const mailTransport = { sendMail: vi.fn().mockResolvedValue({}) };
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, settings, passwordResetTokens, mailTransport }
    );

    await request(app)
      .post("/api/auth/password-reset/request")
      .send({ username: "designer01", email: "designer01@example.com" })
      .expect(200);
    const html = String(mailTransport.sendMail.mock.calls[0][0].html);
    const token = decodeURIComponent(/token=([^"'&<]+)/.exec(html)?.[1] ?? "");
    expect(token).toHaveLength(64);

    await request(app)
      .post("/api/auth/password-reset/confirm")
      .send({ token, password: "abcdef" })
      .expect(200, { ok: true });
    await request(app).post("/api/auth/login").send({ username: "designer01", password: "123456" }).expect(401);
    await request(app).post("/api/auth/login").send({ username: "designer01", password: "abcdef" }).expect(200);

    await request(app)
      .post("/api/auth/password-reset/confirm")
      .send({ token, password: "ghijkl" })
      .expect(400, { error: "INVALID_OR_EXPIRED_RESET_TOKEN" });
  });

  it("rejects expired password reset tokens", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const passwordResetTokens = new PasswordResetTokenRepository(db);
    const user = users.create({
      username: "designer01",
      password: "123456",
      role: "designer",
      displayName: "设计一",
      email: "designer01@example.com"
    });
    const rawToken = "expired-token";
    passwordResetTokens.create({
      userId: user.id,
      tokenHash: hashPasswordResetToken(rawToken),
      expiresAt: new Date(Date.now() - 60_000)
    });
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, passwordResetTokens }
    );

    await request(app)
      .post("/api/auth/password-reset/confirm")
      .send({ token: rawToken, password: "abcdef" })
      .expect(400, { error: "INVALID_OR_EXPIRED_RESET_TOKEN" });
  });
});
