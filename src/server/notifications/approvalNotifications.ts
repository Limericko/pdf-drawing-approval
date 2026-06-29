import type { Approval } from "../domain/approvals.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { NotificationEventKey, UserPreferenceRepository } from "../repositories/userPreferences.ts";
import type { User, UserRepository, UserRole } from "../repositories/users.ts";
import { createTransport, sendEmail, type MailTransport } from "./email.ts";

export type ApprovalNotificationResult = {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
};

export async function notifyApprovalEvent(input: {
  event: NotificationEventKey;
  approvalId: number;
  approvals: ApprovalRepository;
  users: UserRepository;
  userPreferences: Pick<UserPreferenceRepository, "getForUser">;
  settings: SettingsRepository;
  operationLogs?: OperationLogRepository;
  transport?: MailTransport | null;
  actorUserId?: number | null;
  actorUsername?: string | null;
}): Promise<ApprovalNotificationResult> {
  const approval = input.approvals.getById(input.approvalId);
  if (!approval) return { attempted: 0, sent: 0, skipped: 0, failed: 0 };

  const settings = input.settings.all();
  const transport = input.transport === undefined ? createTransport(settings) : input.transport;
  const recipients = uniqueUsers(resolveRecipients(input.event, approval, input.users));
  const result: ApprovalNotificationResult = { attempted: recipients.length, sent: 0, skipped: 0, failed: 0 };

  for (const recipient of recipients) {
    const enabled = input.userPreferences.getForUser(recipient).notificationPreferences.email[input.event];
    if (!enabled) {
      result.skipped += 1;
      logNotification(input, approval, recipient, "notification.email_skipped", "邮件通知已跳过：用户关闭了该提醒", {
        event: input.event,
        reason: "preference_disabled"
      });
      continue;
    }

    if (!recipient.email?.trim()) {
      result.skipped += 1;
      logNotification(input, approval, recipient, "notification.email_skipped", "邮件通知已跳过：用户未配置邮箱", {
        event: input.event,
        reason: "missing_email"
      });
      continue;
    }

    try {
      const sent = await sendEmail(transport, settings, buildEmail(input.event, approval, recipient, settings));
      if (!sent.sent) {
        result.skipped += 1;
        logNotification(input, approval, recipient, "notification.email_skipped", "邮件通知已跳过：SMTP 未配置", {
          event: input.event,
          reason: sent.reason
        });
        continue;
      }

      result.sent += 1;
      logNotification(input, approval, recipient, "notification.email_sent", "审批进度邮件已发送", {
        event: input.event,
        email: recipient.email
      });
    } catch (error) {
      result.failed += 1;
      logNotification(input, approval, recipient, "notification.email_failed", "审批进度邮件发送失败", {
        event: input.event,
        email: recipient.email,
        error: error instanceof Error ? error.message : "SEND_FAILED"
      });
    }
  }

  return result;
}

function resolveRecipients(event: NotificationEventKey, approval: Approval, users: UserRepository): User[] {
  if (event === "reviewTaskCreated") {
    return [...users.findByRole("supervisor"), ...users.findByRole("process")];
  }

  if (event === "peerReviewCompleted") {
    const roles: UserRole[] = [];
    if (approval.status === "pending" && approval.supervisorStatus === "pending") roles.push("supervisor");
    if (approval.status === "pending" && approval.processStatus === "pending") roles.push("process");
    return roles.flatMap((role) => users.findByRole(role));
  }

  if (event === "approvalRejected" || event === "approvalApprovedForPrint") {
    return [
      submittedDesigner(approval, users),
      ...users.findByRole("supervisor"),
      ...users.findByRole("process")
    ].filter((user): user is User => Boolean(user));
  }

  if (event === "signatureFailed") {
    return [submittedDesigner(approval, users), ...users.findByRole("admin")].filter((user): user is User => Boolean(user));
  }

  if (event === "approvalPrinted") {
    return [submittedDesigner(approval, users)].filter((user): user is User => Boolean(user));
  }

  if (event === "systemRisk") {
    return users.findByRole("admin");
  }

  return [];
}

function submittedDesigner(approval: Approval, users: UserRepository): User | null {
  if (approval.submittedByUserId) return users.getById(approval.submittedByUserId);
  if (approval.submittedBy) return users.list().find((user) => user.username === approval.submittedBy) ?? null;
  return null;
}

function uniqueUsers(users: User[]) {
  const seen = new Set<number>();
  const result: User[] = [];
  for (const user of users) {
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    result.push(user);
  }
  return result;
}

function buildEmail(event: NotificationEventKey, approval: Approval, recipient: User, settings: Record<string, string>) {
  const appBaseUrl = (settings.app_base_url || "http://localhost:8080").replace(/\/+$/g, "");
  const approvalUrl = `${appBaseUrl}/approvals/${approval.id}`;
  return {
    to: recipient.email!,
    subject: `${eventSubject(event)}：${approval.projectName} / ${approval.partName} / ${approval.version}`,
    html: `
      <p>${escapeHtml(recipient.displayName)}，你好：</p>
      <p>${escapeHtml(eventMessage(event))}</p>
      <p>项目：${escapeHtml(approval.projectName)}</p>
      <p>零件：${escapeHtml(approval.partName)}</p>
      <p>版本：${escapeHtml(approval.version)}</p>
      <p><a href="${escapeHtml(approvalUrl)}">打开审批页面</a></p>
    `
  };
}

function eventSubject(event: NotificationEventKey) {
  return {
    reviewTaskCreated: "新图纸待审核",
    peerReviewCompleted: "协同审核进展",
    approvalRejected: "图纸被驳回",
    approvalApprovedForPrint: "图纸已通过待打印",
    signatureFailed: "签后 PDF 生成失败",
    approvalPrinted: "图纸已打印归档",
    systemRisk: "系统运维风险"
  }[event];
}

function eventMessage(event: NotificationEventKey) {
  return {
    reviewTaskCreated: "有新的 PDF 图纸需要审核。",
    peerReviewCompleted: "另一审核角色已完成处理，请继续跟进当前图纸。",
    approvalRejected: "当前图纸已被驳回，请查看审核意见。",
    approvalApprovedForPrint: "当前图纸已通过主管和工艺审核，可以打印正式签字版。",
    signatureFailed: "系统自动生成签后 PDF 失败，请检查签名配置或重新生成。",
    approvalPrinted: "当前图纸已标记为已打印归档。",
    systemRisk: "系统检测到需要处理的运维风险。"
  }[event];
}

function logNotification(
  input: {
    event: NotificationEventKey;
    operationLogs?: OperationLogRepository;
    actorUserId?: number | null;
    actorUsername?: string | null;
  },
  approval: Approval,
  recipient: User,
  action: string,
  message: string,
  metadata: Record<string, unknown>
) {
  input.operationLogs?.create({
    actorUserId: input.actorUserId ?? null,
    actorUsername: input.actorUsername ?? "system",
    action,
    targetType: "approval",
    targetId: approval.id,
    message,
    metadata: {
      ...metadata,
      recipientUserId: recipient.id,
      recipientUsername: recipient.username
    }
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
