import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../db.ts";
import { createServer } from "../server.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { UserRepository } from "../repositories/users.ts";
import { SettingsRepository } from "../repositories/settings.ts";

describe("settings routes", () => {
  it("lets admins choose a local folder and stores watch_root", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      {
        db,
        users,
        settings,
        startFolderPicker: async () => ({ pickerId: "test-picker" }),
        pollFolderPicker: async () => ({ status: "selected", path: "D:\\Nutstore\\图纸审批" })
      }
    );

    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    const start = await request(app)
      .post("/api/settings/select-folder")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);
    expect(start.body).toEqual({ pickerId: "test-picker" });

    const response = await request(app)
      .get("/api/settings/select-folder/test-picker")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.body).toEqual({ status: "selected", path: "D:\\Nutstore\\图纸审批" });
    expect(settings.get("watch_root")).toBe("D:\\Nutstore\\图纸审批");
  });

  it("lists server directories for admins", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      {
        db,
        users,
        settings,
        listDirectories: async () => ({
          currentPath: null,
          parentPath: null,
          roots: [{ name: "D:\\", path: "D:\\" }],
          entries: [{ name: "D:\\", path: "D:\\" }]
        })
      }
    );

    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    const response = await request(app)
      .get("/api/settings/directories")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.body.entries).toEqual([{ name: "D:\\", path: "D:\\" }]);
  });

  it("prepares and reports standard approval folders", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-folders-"));
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    settings.set("watch_root", root);
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users, settings });

    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    const before = await request(app)
      .get("/api/settings/watch-root/status")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);
    expect(before.body.ready).toBe(false);

    const prepared = await request(app)
      .post("/api/settings/prepare-folders")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({})
      .expect(200);
    expect(prepared.body.folders).toHaveLength(5);
    expect(prepared.body.folders.every((folder: { status: string }) => folder.status === "created")).toBe(true);

    const after = await request(app)
      .get("/api/settings/watch-root/status")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);
    expect(after.body.ready).toBe(true);
  });

  it("lets admins send smtp test emails", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    const operationLogs = new OperationLogRepository(db);
    const mailTransport = { sendMail: vi.fn().mockResolvedValue({}) };
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    settings.set("smtp_host", "smtp.example.com");
    settings.set("smtp_user", "approval@example.com");
    settings.set("smtp_password", "secret");
    settings.set("smtp_from", "approval@example.com");
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, settings, mailTransport }
    );
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app)
      .post("/api/settings/test-smtp")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ to: "reviewer@example.com" })
      .expect(200);

    expect(response.body).toEqual({ sent: true });
    expect(mailTransport.sendMail).toHaveBeenCalledOnce();
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("settings.smtp_test_sent");
  });

  it("rejects smtp test requests without a recipient", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users, settings });
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app)
      .post("/api/settings/test-smtp")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ to: "" })
      .expect(400);

    expect(response.body.error).toBe("INVALID_INPUT");
  });

  it("returns a readable smtp test error and writes an operation log", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    const operationLogs = new OperationLogRepository(db);
    const mailTransport = { sendMail: vi.fn().mockRejectedValue(new Error("连接 SMTP 服务器失败")) };
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    settings.set("smtp_host", "smtp.example.com");
    settings.set("smtp_user", "approval@example.com");
    settings.set("smtp_password", "secret");
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, settings, mailTransport }
    );
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app)
      .post("/api/settings/test-smtp")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ to: "reviewer@example.com" })
      .expect(500);

    expect(response.body.error).toBe("SMTP_TEST_FAILED");
    expect(response.body.message).toContain("连接 SMTP 服务器失败");
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("settings.smtp_test_failed");
  });
});
