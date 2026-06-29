import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { UserPreferenceRepository } from "../repositories/userPreferences.ts";
import type { User, UserRepository } from "../repositories/users.ts";
import type { SystemRisk } from "../services/systemRisks.ts";
import { createTransport, sendEmail, type MailTransport } from "./email.ts";

export type SystemRiskNotificationResult = {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
};

const sentRiskBatches = new Set<string>();

export async function notifySystemRiskEvent(input: {
  risks: SystemRisk[];
  users: UserRepository;
  userPreferences: Pick<UserPreferenceRepository, "getForUser">;
  settings: SettingsRepository;
  operationLogs?: OperationLogRepository;
  transport?: MailTransport | null;
  actorUserId?: number | null;
  actorUsername?: string | null;
  dedupeKey?: string;
}): Promise<SystemRiskNotificationResult> {
  const actionableRisks = input.risks.filter((risk) => risk.level !== "ok");
  if (actionableRisks.length === 0) return { attempted: 0, sent: 0, skipped: 0, failed: 0 };

  const recipients = uniqueUsers(input.users.findByRole("admin"));
  const batchKey = input.dedupeKey ?? riskBatchKey(actionableRisks);
  if (sentRiskBatches.has(batchKey)) {
    input.operationLogs?.create({
      actorUserId: input.actorUserId ?? null,
      actorUsername: input.actorUsername ?? "system",
      action: "notification.email_deduped",
      targetType: "system",
      targetId: null,
      message: "系统风险邮件已去重：同一批风险已发送过",
      metadata: { event: "systemRisk", riskKeys: actionableRisks.map((risk) => risk.key) }
    });
    return { attempted: 0, sent: 0, skipped: recipients.length, failed: 0 };
  }

  const settings = input.settings.all();
  const transport = input.transport === undefined ? createTransport(settings) : input.transport;
  const result: SystemRiskNotificationResult = { attempted: recipients.length, sent: 0, skipped: 0, failed: 0 };

  for (const recipient of recipients) {
    const enabled = input.userPreferences.getForUser(recipient).notificationPreferences.email.systemRisk;
    if (!enabled) {
      result.skipped += 1;
      logSystemRiskNotification(input, recipient, "notification.email_skipped", "系统风险邮件已跳过：用户关闭了该提醒", {
        reason: "preference_disabled"
      });
      continue;
    }

    if (!recipient.email?.trim()) {
      result.skipped += 1;
      logSystemRiskNotification(input, recipient, "notification.email_skipped", "系统风险邮件已跳过：用户未配置邮箱", {
        reason: "missing_email"
      });
      continue;
    }

    try {
      const sent = await sendEmail(transport, settings, buildSystemRiskEmail(actionableRisks, recipient, settings));
      if (!sent.sent) {
        result.skipped += 1;
        logSystemRiskNotification(input, recipient, "notification.email_skipped", "系统风险邮件已跳过：SMTP 未配置", {
          reason: sent.reason
        });
        continue;
      }

      result.sent += 1;
      logSystemRiskNotification(input, recipient, "notification.email_sent", "系统风险邮件已发送", {
        email: recipient.email,
        riskKeys: actionableRisks.map((risk) => risk.key)
      });
    } catch (error) {
      result.failed += 1;
      logSystemRiskNotification(input, recipient, "notification.email_failed", "系统风险邮件发送失败", {
        email: recipient.email,
        error: error instanceof Error ? error.message : "SEND_FAILED"
      });
    }
  }

  if (result.sent > 0) sentRiskBatches.add(batchKey);
  return result;
}

function buildSystemRiskEmail(risks: SystemRisk[], recipient: User, settings: Record<string, string>) {
  const appBaseUrl = (settings.app_base_url || "http://localhost:8080").replace(/\/+$/g, "");
  const riskItems = risks
    .map((risk) => `<li><strong>${escapeHtml(risk.title)}</strong>：${escapeHtml(risk.message)}</li>`)
    .join("");
  return {
    to: recipient.email!,
    subject: `系统运维风险：${risks.length} 项需要处理`,
    html: `
      <p>${escapeHtml(recipient.displayName)}，你好：</p>
      <p>PDF 审批系统检测到以下运维风险：</p>
      <ul>${riskItems}</ul>
      <p><a href="${escapeHtml(`${appBaseUrl}/settings?tab=operations`)}">打开运维追溯页面</a></p>
    `
  };
}

function logSystemRiskNotification(
  input: {
    operationLogs?: OperationLogRepository;
    actorUserId?: number | null;
    actorUsername?: string | null;
  },
  recipient: User,
  action: string,
  message: string,
  metadata: Record<string, unknown>
) {
  input.operationLogs?.create({
    actorUserId: input.actorUserId ?? null,
    actorUsername: input.actorUsername ?? "system",
    action,
    targetType: "system",
    targetId: null,
    message,
    metadata: {
      event: "systemRisk",
      ...metadata,
      recipientUserId: recipient.id,
      recipientUsername: recipient.username
    }
  });
}

function riskBatchKey(risks: SystemRisk[]) {
  return risks
    .map((risk) => `${risk.key}:${risk.level}:${risk.count ?? ""}`)
    .sort()
    .join("|");
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
