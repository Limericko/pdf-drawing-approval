import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { UserPreferenceRepository } from "../repositories/userPreferences.ts";
import { UserRepository } from "../repositories/users.ts";
import { notifySystemRiskEvent } from "./systemRiskNotifications.ts";

function setup() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const userPreferences = new UserPreferenceRepository(db);
  const settings = new SettingsRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const admin = users.create({
    username: "admin",
    password: "admin123",
    role: "admin",
    displayName: "管理员",
    email: "admin@example.com"
  });
  users.create({
    username: "designer",
    password: "123456",
    role: "designer",
    displayName: "设计师",
    email: "designer@example.com"
  });
  userPreferences.upsertForUser(admin, { notificationPreferences: { email: { systemRisk: true } } });
  return { users, userPreferences, settings, operationLogs, admin };
}

describe("notifySystemRiskEvent", () => {
  it("emails admins who enabled system risk notifications", async () => {
    const context = setup();
    const transport = { sendMail: vi.fn(async (_message: { to?: string }) => undefined) };

    const result = await notifySystemRiskEvent({
      risks: [{ key: "backup_missing", level: "warning", title: "暂无数据库备份", message: "请先创建一次备份。" }],
      users: context.users,
      userPreferences: context.userPreferences,
      settings: context.settings,
      operationLogs: context.operationLogs,
      transport,
      dedupeKey: "manual-scan:1"
    });

    expect(result).toEqual(expect.objectContaining({ attempted: 1, sent: 1, skipped: 0, failed: 0 }));
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.com",
        subject: expect.stringContaining("系统运维风险")
      })
    );
    expect(context.operationLogs.listRecent().filter((log) => log.targetType === "system").map((log) => log.action)).toContain("notification.email_sent");
  });

  it("dedupes repeated risk notification batches", async () => {
    const context = setup();
    const transport = { sendMail: vi.fn(async (_message: { to?: string }) => undefined) };
    const input = {
      risks: [{ key: "watch_root_missing", level: "error" as const, title: "审批根目录未配置", message: "请配置目录。" }],
      users: context.users,
      userPreferences: context.userPreferences,
      settings: context.settings,
      operationLogs: context.operationLogs,
      transport,
      dedupeKey: "same-risk"
    };

    await notifySystemRiskEvent(input);
    const second = await notifySystemRiskEvent(input);

    expect(second).toEqual(expect.objectContaining({ attempted: 0, sent: 0, skipped: 1, failed: 0 }));
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(context.operationLogs.listRecent().filter((log) => log.targetType === "system").map((log) => log.action)).toContain("notification.email_deduped");
  });
});
