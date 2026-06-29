import request from "supertest";
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { createDatabase } from "../db.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

describe("user routes", () => {
  it("lets admins create, update, and reset users", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const operationLogs = new OperationLogRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users });

    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    const created = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ username: "designer1", password: "123456", role: "designer", displayName: "设计一", email: "" })
      .expect(201);
    expect(created.body.username).toBe("designer1");
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("user.created");

    const updated = await request(app)
      .put(`/api/users/${created.body.id}`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ role: "supervisor", displayName: "主管一", email: "supervisor@example.com", active: true })
      .expect(200);
    expect(updated.body.role).toBe("supervisor");
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("user.updated");

    await request(app)
      .post(`/api/users/${created.body.id}/reset-password`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ password: "abcdef" })
      .expect(200);
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("user.password_reset");

    const relogin = await request(app).post("/api/auth/login").send({ username: "designer1", password: "abcdef" }).expect(200);
    expect(relogin.body.user.displayName).toBe("主管一");
  });

  it("does not allow creating or assigning printer users for new workflows", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users });
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ username: "printer1", password: "123456", role: "printer", displayName: "打印", email: "" })
      .expect(400);

    const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
    await request(app)
      .put(`/api/users/${designer.id}`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ role: "printer", displayName: "打印", email: "", active: true })
      .expect(400);
  });

  it("initializes without a separate printer account", () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);

    users.ensureDefaultUsers();

    expect(users.list().map((user) => user.role)).toEqual(["admin", "process", "supervisor"]);
  });

  it("hides legacy printer users and rejects their login", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    db.prepare(
      `INSERT INTO users (username, password_hash, role, display_name, active)
       VALUES (?, ?, 'printer', '旧打印', 1)`
    ).run("legacy_printer", bcrypt.hashSync("123456", 10));
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users });

    expect(users.list().map((user) => user.username)).not.toContain("legacy_printer");
    await request(app).post("/api/auth/login").send({ username: "legacy_printer", password: "123456" }).expect(401);

    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    const response = await request(app).get("/api/users").set("Authorization", `Bearer ${login.body.token}`).expect(200);
    expect(response.body.map((user: { username: string }) => user.username)).not.toContain("legacy_printer");
  });

  it("does not allow disabling the last active admin", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const admin = users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users });

    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    const response = await request(app)
      .put(`/api/users/${admin.id}`)
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ role: "admin", displayName: "管理员", email: "", active: false })
      .expect(400);
    expect(response.body.error).toBe("LAST_ADMIN_REQUIRED");
  });
});
