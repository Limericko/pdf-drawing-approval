import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { UserPreferenceRepository } from "../repositories/userPreferences.ts";
import { UserRepository } from "../repositories/users.ts";
import { notifyApprovalEvent } from "./approvalNotifications.ts";

function setup() {
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const users = new UserRepository(db);
  const userPreferences = new UserPreferenceRepository(db);
  const settings = new SettingsRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const designer = users.create({
    username: "designer",
    password: "123456",
    role: "designer",
    displayName: "设计师",
    email: "designer@example.com"
  });
  const supervisor = users.create({
    username: "supervisor",
    password: "123456",
    role: "supervisor",
    displayName: "主管",
    email: "supervisor@example.com"
  });
  const process = users.create({
    username: "process",
    password: "123456",
    role: "process",
    displayName: "工艺",
    email: "process@example.com"
  });
  const admin = users.create({
    username: "admin",
    password: "admin123",
    role: "admin",
    displayName: "管理员",
    email: "admin@example.com"
  });
  const approval = approvals.create({
    projectName: "项目A",
    partName: "轴承座",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a0A0.pdf",
    currentFilePath: "G:\\Nutstore\\02-审批中\\项目A\\轴承座-a0A0.pdf",
    submittedBy: designer.username,
    submittedByUserId: designer.id,
    source: "web_upload",
    signatureStatus: "pending"
  });
  return { approvals, users, userPreferences, settings, operationLogs, designer, supervisor, process, admin, approval };
}

describe("notifyApprovalEvent", () => {
  it("emails supervisor and process users for new review tasks when preferences allow it", async () => {
    const context = setup();
    const transport = { sendMail: vi.fn(async (_message: { to?: string }) => undefined) };

    const result = await notifyApprovalEvent({
      event: "reviewTaskCreated",
      approvalId: context.approval.id,
      approvals: context.approvals,
      users: context.users,
      userPreferences: context.userPreferences,
      settings: context.settings,
      operationLogs: context.operationLogs,
      transport
    });

    expect(result).toEqual(expect.objectContaining({ attempted: 2, sent: 2, failed: 0 }));
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    expect(transport.sendMail.mock.calls.map(([message]) => message.to)).toEqual(["supervisor@example.com", "process@example.com"]);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain("notification.email_sent");
  });

  it("skips disabled preferences and missing email addresses without throwing", async () => {
    const context = setup();
    context.userPreferences.upsertForUser(context.supervisor, {
      notificationPreferences: { email: { reviewTaskCreated: false } }
    });
    context.users.updateProfile(context.process.id, { displayName: "工艺", email: null });
    const transport = { sendMail: vi.fn(async (_message: { to?: string }) => undefined) };

    const result = await notifyApprovalEvent({
      event: "reviewTaskCreated",
      approvalId: context.approval.id,
      approvals: context.approvals,
      users: context.users,
      userPreferences: context.userPreferences,
      settings: context.settings,
      operationLogs: context.operationLogs,
      transport
    });

    expect(result).toEqual(expect.objectContaining({ attempted: 2, sent: 0, skipped: 2 }));
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(context.operationLogs.listForTarget("approval", context.approval.id).filter((log) => log.action === "notification.email_skipped")).toHaveLength(2);
  });

  it("does not block when SMTP is not configured", async () => {
    const context = setup();

    const result = await notifyApprovalEvent({
      event: "approvalRejected",
      approvalId: context.approval.id,
      approvals: context.approvals,
      users: context.users,
      userPreferences: context.userPreferences,
      settings: context.settings,
      operationLogs: context.operationLogs,
      transport: null
    });

    expect(result.sent).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain("notification.email_skipped");
  });

  it("emails the submitting designer and admins when signing fails", async () => {
    const context = setup();
    const transport = { sendMail: vi.fn(async (_message: { to?: string }) => undefined) };

    const result = await notifyApprovalEvent({
      event: "signatureFailed",
      approvalId: context.approval.id,
      approvals: context.approvals,
      users: context.users,
      userPreferences: context.userPreferences,
      settings: context.settings,
      operationLogs: context.operationLogs,
      transport
    });

    expect(result).toEqual(expect.objectContaining({ attempted: 2, sent: 2 }));
    expect(transport.sendMail.mock.calls.map(([message]) => message.to)).toEqual(["designer@example.com", "admin@example.com"]);
  });
});
