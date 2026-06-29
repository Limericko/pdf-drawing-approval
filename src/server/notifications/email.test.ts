import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { UserRepository } from "../repositories/users.ts";
import { sendTestEmail } from "./email.ts";
import { notifyApprovalCreated } from "./notifyApprovalCreated.ts";

describe("notifyApprovalCreated", () => {
  it("emails supervisor and process reviewer with approval details", async () => {
    const db = createDatabase(":memory:");
    const approvals = new ApprovalRepository(db);
    const users = new UserRepository(db);
    const settings = new SettingsRepository(db);
    settings.set("smtp_from", "approval@example.com");
    settings.set("app_base_url", "http://192.168.1.20:8080");
    users.create({ username: "s", password: "1", role: "supervisor", displayName: "主管", email: "s@example.com" });
    users.create({ username: "p", password: "1", role: "process", displayName: "工艺", email: "p@example.com" });
    const approval = approvals.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "from.pdf",
      currentFilePath: "to.pdf"
    });
    const transport = { sendMail: vi.fn().mockResolvedValue({}) };

    await notifyApprovalCreated(approval.id, { approvals, users, settings, transport });

    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    expect(transport.sendMail.mock.calls[0][0].subject).toContain("轴承座");
    expect(transport.sendMail.mock.calls[0][0].html).toContain("http://192.168.1.20:8080/approvals/");
  });
});

describe("sendTestEmail", () => {
  it("sends a test email to the requested recipient", async () => {
    const transport = { sendMail: vi.fn().mockResolvedValue({}) };

    const result = await sendTestEmail(
      {
        smtp_host: "smtp.example.com",
        smtp_user: "approval@example.com",
        smtp_password: "secret",
        smtp_from: "approval@example.com"
      },
      "reviewer@example.com",
      transport
    );

    expect(result).toEqual({ sent: true });
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "approval@example.com",
        to: "reviewer@example.com",
        subject: expect.stringContaining("测试邮件")
      })
    );
  });

  it("reports when smtp is not configured", async () => {
    const result = await sendTestEmail({}, "reviewer@example.com", null);

    expect(result).toEqual({ sent: false, reason: "smtp_not_configured" });
  });
});
