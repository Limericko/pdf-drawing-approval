import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { createServer, type ServerDeps } from "../server.ts";
import { BackupRunRepository } from "../repositories/backups.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { ScanRunRepository } from "../repositories/scanRuns.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { UserPreferenceRepository } from "../repositories/userPreferences.ts";
import { UserRepository } from "../repositories/users.ts";
import { saveTempUpload } from "../uploads/tempUploads.ts";
import { appVersion } from "../../shared/appVersion.ts";

const newerThanAppVersion = nextPatchVersion(appVersion);

describe("system routes", () => {
  it("lets admins request an application restart", async () => {
    vi.useFakeTimers();
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const operationLogs = new OperationLogRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const restart = vi.fn();
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, restart }
    );

    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    await request(app)
      .post("/api/system/restart")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200, { restarting: true });

    expect(restart).not.toHaveBeenCalled();
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("system.restart_requested");
    vi.advanceTimersByTime(300);
    expect(restart).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("lets admins run a manual scan and records scan counts", async () => {
    const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-scan-"));
    const submitDir = path.join(watchRoot, "01-待提交", "项目A");
    await fs.mkdir(submitDir, { recursive: true });
    await fs.writeFile(path.join(submitDir, "有效件-a0A0.pdf"), "%PDF-1.7\n");
    await fs.writeFile(path.join(submitDir, "无效件-a0A0.pdf"), "not a real pdf");

    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const approvals = new ApprovalRepository(db);
    const operationLogs = new OperationLogRepository(db);
    const scanRuns = new ScanRunRepository(db);
    const settings = new SettingsRepository(db);
    const userPreferences = new UserPreferenceRepository(db);
    const mailTransport = { sendMail: vi.fn(async (_message: { to?: string }) => undefined) };
    settings.set("watch_root", watchRoot);
    const admin = users.create({
      username: "admin",
      password: "admin123",
      role: "admin",
      displayName: "管理员",
      email: "admin@example.com"
    });
    userPreferences.upsertForUser(admin, { notificationPreferences: { email: { systemRisk: true } } });
    approvals.create({
      projectName: "项目A",
      partName: "丢失件",
      version: "a1A0",
      minorVersion: "a1",
      majorVersion: "A0",
      originalFilePath: path.join(watchRoot, "02-审批中", "项目A", "丢失件-a1A0.pdf"),
      currentFilePath: path.join(watchRoot, "02-审批中", "项目A", "丢失件-a1A0.pdf")
    });
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, approvals, settings, userPreferences, mailTransport }
    );
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app)
      .post("/api/system/scan-now")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.body.status).toBe("completed");
    expect(response.body.processedCount).toBe(2);
    expect(response.body.invalidCount).toBe(1);
    expect(response.body.missingCount).toBe(1);
    expect(scanRuns.listRecent()[0].status).toBe("completed");
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("system.scan_completed");
    expect(mailTransport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.com",
        subject: expect.stringContaining("系统运维风险")
      })
    );
  });

  it("does not let non-admin users run manual scans", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
    settings.set("watch_root", await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-scan-")));
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users, settings });
    const login = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });

    await request(app).post("/api/system/scan-now").set("Authorization", `Bearer ${login.body.token}`).expect(403);
  });

  it("lets admins list recent scan runs", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const scanRuns = new ScanRunRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const run = scanRuns.start("admin");
    scanRuns.complete(run.id, { processedCount: 3, missingCount: 1, invalidCount: 1 });
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users });
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app).get("/api/system/scan-runs").set("Authorization", `Bearer ${login.body.token}`).expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].processedCount).toBe(3);
    expect(response.body[0].missingCount).toBe(1);
    expect(response.body[0].invalidCount).toBe(1);
  });

  it("lets admins view system diagnostics", async () => {
    const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-diagnostics-route-"));
    for (const folder of ["01-待提交", "02-审批中", "03-已驳回", "04-已通过待打印", "05-已打印归档"]) {
      await fs.mkdir(path.join(watchRoot, folder), { recursive: true });
    }
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    const scanRuns = new ScanRunRepository(db);
    const backups = new BackupRunRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    settings.set("watch_root", watchRoot);
    const scan = scanRuns.start("admin");
    scanRuns.complete(scan.id, { processedCount: 3, missingCount: 0, invalidCount: 0 });
    backups.complete(backups.start("admin").id, path.join(watchRoot, "backups", "pdf-approval-test"));
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, settings, scanRuns, backups }
    );
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app).get("/api/system/diagnostics").set("Authorization", `Bearer ${login.body.token}`).expect(200);

    expect(response.body.overallStatus).toBe("ok");
    expect(response.body.database.ok).toBe(true);
    expect(response.body.watchRoot.exists).toBe(true);
    expect(response.body.latestScan.processedCount).toBe(3);
    expect(response.body.latestBackup.status).toBe("completed");
  });

  it("does not let non-admin users view diagnostics", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users });
    const login = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });

    await request(app).get("/api/system/diagnostics").set("Authorization", `Bearer ${login.body.token}`).expect(403);
  });

  it("lets admins view operational risks", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const approvals = new ApprovalRepository(db);
    const backups = new BackupRunRepository(db);
    const settings = new SettingsRepository(db);
    const signatureAssets = new SignatureAssetRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, approvals, backups, settings, signatureAssets }
    );
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app).get("/api/system/risks").set("Authorization", `Bearer ${login.body.token}`).expect(200);

    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "watch_root_missing", level: "error" }),
        expect.objectContaining({ key: "backup_missing", level: "warning" }),
        expect.objectContaining({ key: "default_credentials_active", level: "warning" }),
        expect.objectContaining({ key: "key_signatures_missing", level: "warning" })
      ])
    );
  });

  it("does not let non-admin users view operational risks", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
    const app = createServer({ port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" }, { db, users });
    const login = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });

    await request(app).get("/api/system/risks").set("Authorization", `Bearer ${login.body.token}`).expect(403);
  });

  it("lets admins read service logs from the managed dev-server log fallback", async () => {
    const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-logs-"));
    await fs.mkdir(path.join(logRoot, ".codex"), { recursive: true });
    await fs.writeFile(path.join(logRoot, ".codex", "dev-server.out.log"), "server started\nwatcher active\n");
    await fs.writeFile(path.join(logRoot, ".codex", "dev-server.err.log"), "warning line\n");
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, logRoot } as Parameters<typeof createServer>[1] & { logRoot: string }
    );
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const response = await request(app).get("/api/system/logs?lines=20").set("Authorization", `Bearer ${login.body.token}`).expect(200);

    expect(response.body.logs).toEqual([
      { name: "server.log", exists: true, content: "server started\nwatcher active\n" },
      { name: "server.err.log", exists: true, content: "warning line\n" }
    ]);
  });

  it("lets admins trigger and list database backups", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-backup-route-"));
    const databasePath = path.join(root, "pdf-approval.sqlite");
    await fs.writeFile(databasePath, "db");
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const operationLogs = new OperationLogRepository(db);
    const backups = new BackupRunRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const app = createServer(
      { port: 0, dataDir: "data", databasePath, jwtSecret: "secret" },
      { db, users, operationLogs, backups, backupRoot: path.join(root, "backups") }
    );
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const backup = await request(app).post("/api/system/backup").set("Authorization", `Bearer ${login.body.token}`).expect(200);
    const list = await request(app).get("/api/system/backups").set("Authorization", `Bearer ${login.body.token}`).expect(200);

    expect(backup.body.status).toBe("completed");
    expect(list.body[0].status).toBe("completed");
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("system.backup_completed");
  });

  it("lets admins update maintenance settings and validate backup directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-backup-validate-route-"));
    await fs.writeFile(path.join(root, "pdf-approval.sqlite"), "SQLite format 3\u0000");
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, settings }
    );
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

    const saved = await request(app)
      .put("/api/system/maintenance")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({
        autoBackup: { enabled: true, time: "01:20" },
        autoCleanup: { enabled: true, time: "03:40" }
      })
      .expect(200);
    const loaded = await request(app).get("/api/system/maintenance").set("Authorization", `Bearer ${login.body.token}`).expect(200);
    const validated = await request(app)
      .post("/api/system/backups/validate")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ path: root })
      .expect(200);

    expect(saved.body.autoBackup).toEqual({ enabled: true, time: "01:20" });
    expect(loaded.body.autoCleanup).toEqual({ enabled: true, time: "03:40" });
    expect(validated.body).toEqual({ ok: true, files: ["pdf-approval.sqlite"], message: "备份目录可读取。" });
  });

  it("lets admins check the server-hosted update manifest without exposing it to reviewers", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
    settings.set("update_manifest_url", "http://old-manual-config.example/updates/latest.json");
    const seenSourceUrls: string[] = [];
    const app = createServer(
      { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      {
        db,
        users,
        settings,
        fetchUpdateManifest: async (sourceUrl) => {
          seenSourceUrls.push(sourceUrl);
          return {
            version: newerThanAppVersion,
            notes: ["上线自动更新检查"],
            downloads: {
              clientInstaller: `../installers/client/PDF图纸审批客户端-安装包-${newerThanAppVersion}.exe`
            }
          };
        }
      } satisfies ServerDeps
    );
    const adminLogin = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    const supervisorLogin = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" });

    const response = await request(app)
      .get("/api/system/update-info")
      .set("Host", "192.168.1.20:8080")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .expect(200);
    await request(app)
      .get("/api/system/update-info")
      .set("Authorization", `Bearer ${supervisorLogin.body.token}`)
      .expect(403);

    expect(seenSourceUrls).toEqual(["http://192.168.1.20:8080/updates/latest.json"]);
    expect(response.body.updateSourceUrl).toBe("http://192.168.1.20:8080/updates/latest.json");
    expect(response.body.updateAvailable).toBe(true);
    expect(response.body.latest).toEqual(
      expect.objectContaining({
        version: newerThanAppVersion,
        downloads: {
          clientInstaller: `http://192.168.1.20:8080/installers/client/PDF%E5%9B%BE%E7%BA%B8%E5%AE%A1%E6%89%B9%E5%AE%A2%E6%88%B7%E7%AB%AF-%E5%AE%89%E8%A3%85%E5%8C%85-${newerThanAppVersion}.exe`
        }
      })
    );
    expect(response.body.releaseNotes[0]).toEqual(expect.objectContaining({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/) }));
  });

  it("allows server-side environment override for special update deployments", async () => {
    const previous = process.env.PDF_APPROVAL_UPDATE_MANIFEST_URL;
    process.env.PDF_APPROVAL_UPDATE_MANIFEST_URL = "http://updates.internal/latest.json";
    try {
      const db = createDatabase(":memory:");
      const users = new UserRepository(db);
      const seenSourceUrls: string[] = [];
      users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
      const app = createServer(
        { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
        {
          db,
          users,
          fetchUpdateManifest: async (sourceUrl) => {
            seenSourceUrls.push(sourceUrl);
            return { version: "0.9.0" };
          }
        } satisfies ServerDeps
      );
      const login = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });

      await request(app).get("/api/system/update-info").set("Authorization", `Bearer ${login.body.token}`).expect(200);

      expect(seenSourceUrls).toEqual(["http://updates.internal/latest.json"]);
    } finally {
      if (previous === undefined) {
        delete process.env.PDF_APPROVAL_UPDATE_MANIFEST_URL;
      } else {
        process.env.PDF_APPROVAL_UPDATE_MANIFEST_URL = previous;
      }
    }
  });

  it("lets ordinary users check client updates without exposing server installers", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
    const seenSourceUrls: string[] = [];
    const app = createServer(
      { port: 8080, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      {
        db,
        users,
        settings,
        fetchUpdateManifest: async (sourceUrl) => {
          seenSourceUrls.push(sourceUrl);
          return {
            version: newerThanAppVersion,
            notes: ["客户端自动检查新版"],
            downloads: {
              clientInstaller: `../installers/client/PDF图纸审批客户端-安装包-${newerThanAppVersion}.exe`,
              serverInstaller: `../installers/server/PDF图纸审批服务端-安装包-${newerThanAppVersion}.exe`
            }
          };
        }
      } satisfies ServerDeps
    );
    const login = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });

    const response = await request(app)
      .get("/api/system/client-update-info")
      .set("Host", "192.168.1.20:8080")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(seenSourceUrls).toEqual(["http://192.168.1.20:8080/updates/latest.json"]);
    expect(response.body.updateAvailable).toBe(true);
    expect(response.body.latest).toEqual(
      expect.objectContaining({
        version: newerThanAppVersion,
        downloads: {
          clientInstaller: `http://192.168.1.20:8080/installers/client/PDF%E5%9B%BE%E7%BA%B8%E5%AE%A1%E6%89%B9%E5%AE%A2%E6%88%B7%E7%AB%AF-%E5%AE%89%E8%A3%85%E5%8C%85-${newerThanAppVersion}.exe`
        }
      })
    );
    expect(response.body.latest.downloads.serverInstaller).toBeUndefined();
  });

  it("compares client update checks against the installed client version reported by the caller", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
    const app = createServer(
      { port: 8080, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      {
        db,
        users,
        fetchUpdateManifest: async () => ({
          version: appVersion,
          downloads: {
            clientInstaller: `../installers/client/PDF图纸审批客户端-安装包-${appVersion}.exe`,
            serverInstaller: `../installers/server/PDF图纸审批服务端-安装包-${appVersion}.exe`
          }
        })
      } satisfies ServerDeps
    );
    const login = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });

    const response = await request(app)
      .get("/api/system/client-update-info?currentVersion=0.8.7")
      .set("Host", "192.168.1.20:8080")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.body.currentVersion).toBe("0.8.7");
    expect(response.body.latest.version).toBe(appVersion);
    expect(response.body.updateAvailable).toBe(true);
    expect(response.body.latest.downloads.clientInstaller).toContain(`PDF%E5%9B%BE%E7%BA%B8%E5%AE%A1%E6%89%B9%E5%AE%A2%E6%88%B7%E7%AB%AF-%E5%AE%89%E8%A3%85%E5%8C%85-${appVersion}.exe`);
    expect(response.body.latest.downloads.serverInstaller).toBeUndefined();
  });

  it("treats older Electron clients without a reported version as update candidates", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
    const app = createServer(
      { port: 8080, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
      {
        db,
        users,
        fetchUpdateManifest: async () => ({
          version: appVersion,
          downloads: {
            clientInstaller: `../installers/client/PDF图纸审批客户端-安装包-${appVersion}.exe`
          }
        })
      } satisfies ServerDeps
    );
    const login = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });

    const response = await request(app)
      .get("/api/system/client-update-info")
      .set("Host", "192.168.1.20:8080")
      .set("User-Agent", "Mozilla/5.0 PDFApprovalClient Electron/42.4.1")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.body.currentVersion).toBe("0.0.0");
    expect(response.body.latest.version).toBe(appVersion);
    expect(response.body.updateAvailable).toBe(true);
  });

  it("lets admins preview and execute cleanup operations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-cleanup-route-"));
    const dataDir = path.join(root, "data");
    const upload = await saveTempUpload({ rootDir: dataDir, originalName: "临时-a0A0.pdf", buffer: Buffer.from("%PDF-1.7\n") });
    const old = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(path.dirname(upload.filePath), old, old);
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const operationLogs = new OperationLogRepository(db);
    users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
    users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
    const app = createServer(
      { port: 0, dataDir, databasePath: ":memory:", jwtSecret: "secret" },
      { db, users, operationLogs }
    );
    const adminLogin = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
    const designerLogin = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });

    await request(app)
      .post("/api/system/cleanup")
      .set("Authorization", `Bearer ${designerLogin.body.token}`)
      .send({ execute: true })
      .expect(403);

    const preview = await request(app)
      .post("/api/system/cleanup")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .send({ execute: false })
      .expect(200);

    expect(preview.body.executed).toBe(false);
    expect(preview.body.tempUploads.count).toBe(1);

    const executed = await request(app)
      .post("/api/system/cleanup")
      .set("Authorization", `Bearer ${adminLogin.body.token}`)
      .send({ execute: true })
      .expect(200);

    expect(executed.body.executed).toBe(true);
    expect(executed.body.tempUploads.count).toBe(1);
    await expect(fs.stat(upload.filePath)).rejects.toThrow();
    expect(operationLogs.listRecent().map((log) => log.action)).toContain("system.cleanup_executed");
  });
});

function nextPatchVersion(version: string) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return `${major}.${minor}.${patch + 1}`;
}
