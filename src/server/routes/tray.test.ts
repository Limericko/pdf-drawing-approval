import { describe, expect, it } from "vitest";
import request from "supertest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { BackupRunRepository } from "../repositories/backups.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

function appContext() {
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const backups = new BackupRunRepository(db);
  const settings = new SettingsRepository(db);
  const signatureAssets = new SignatureAssetRepository(db);
  const users = new UserRepository(db);
  const app = createServer(
    { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
    { db, approvals, backups, settings, signatureAssets, users }
  );
  return { app, approvals };
}

describe("tray routes", () => {
  it("requires authentication", async () => {
    const { app } = appContext();

    await request(app).get("/api/tray/summary").expect(401);
  });

  it("returns tray summary for authenticated reviewers", async () => {
    const { app, approvals } = appContext();
    approvals.create({
      projectName: "300A",
      partName: "固定支持支架",
      version: "a0A0",
      minorVersion: "0",
      majorVersion: "A0",
      originalFilePath: "a.pdf",
      currentFilePath: "a.pdf",
      submittedBy: "designer"
    });

    const login = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" }).expect(200);
    const response = await request(app)
      .get("/api/tray/summary")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.body.tasks.pendingCount).toBe(1);
    expect(response.body.tasks.latest[0]).toMatchObject({
      projectName: "300A",
      partName: "固定支持支架",
      version: "a0A0",
      href: "#/approvals/1"
    });
  });

  it("keeps admin tray risk count aligned with the system risk list", async () => {
    const { app } = appContext();
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" }).expect(200);

    const risks = await request(app).get("/api/system/risks").set("Authorization", `Bearer ${login.body.token}`).expect(200);
    const summary = await request(app).get("/api/tray/summary").set("Authorization", `Bearer ${login.body.token}`).expect(200);

    expect(summary.body.admin.riskCount).toBe(risks.body.length);
  });
});
