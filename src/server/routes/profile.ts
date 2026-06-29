import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import { sendTestEmail, type MailTransport } from "../notifications/email.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import {
  type NotificationEventKey,
  type UserPreferenceInput,
  type UserPreferenceRepository
} from "../repositories/userPreferences.ts";
import type { User, UserRepository } from "../repositories/users.ts";

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1),
  email: z.string().trim().email().or(z.literal("")).nullable().optional(),
  commonProjects: z.array(z.string()).optional(),
  notificationPreferences: z
    .object({
      email: z.record(z.boolean()).optional()
    })
    .optional()
});

type NotificationEventMeta = {
  key: NotificationEventKey;
  label: string;
  description: string;
};

const eventMeta: Record<NotificationEventKey, NotificationEventMeta> = {
  reviewTaskCreated: {
    key: "reviewTaskCreated",
    label: "新图纸待审核",
    description: "有新图纸进入待审核队列时提醒。"
  },
  peerReviewCompleted: {
    key: "peerReviewCompleted",
    label: "协同审核进展",
    description: "另一审核角色已完成处理、仍需你跟进时提醒。"
  },
  approvalRejected: {
    key: "approvalRejected",
    label: "图纸被驳回",
    description: "图纸被主管或工艺驳回时提醒。"
  },
  approvalApprovedForPrint: {
    key: "approvalApprovedForPrint",
    label: "图纸已通过",
    description: "主管和工艺均通过，图纸进入待打印时提醒。"
  },
  signatureFailed: {
    key: "signatureFailed",
    label: "签名生成失败",
    description: "系统自动生成签后 PDF 失败时提醒。"
  },
  approvalPrinted: {
    key: "approvalPrinted",
    label: "已打印归档",
    description: "图纸被标记为已打印归档时提醒。"
  },
  systemRisk: {
    key: "systemRisk",
    label: "系统运维风险",
    description: "文件、备份或标准目录出现运维风险时提醒。"
  }
};

const eventsByRole: Record<string, NotificationEventKey[]> = {
  designer: ["approvalRejected", "approvalApprovedForPrint", "signatureFailed", "approvalPrinted"],
  supervisor: ["reviewTaskCreated", "peerReviewCompleted", "approvalRejected", "approvalApprovedForPrint"],
  process: ["reviewTaskCreated", "peerReviewCompleted", "approvalRejected", "approvalApprovedForPrint"],
  admin: ["signatureFailed", "systemRisk"]
};

export function profileRoutes(deps: {
  users: UserRepository;
  userPreferences: UserPreferenceRepository;
  settings: SettingsRepository;
  operationLogs?: OperationLogRepository;
  mailTransport?: MailTransport | null;
  jwtSecret: string;
}) {
  const router = Router();

  router.get("/", requireAuth(deps.jwtSecret), (req, res) => {
    const user = currentUser(req.user?.id, deps.users);
    if (!user) return res.status(401).json({ error: "UNAUTHORIZED" });
    res.json(profileResponse(user, deps.userPreferences));
  });

  router.put("/", requireAuth(deps.jwtSecret), (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const existing = currentUser(req.user?.id, deps.users);
    if (!existing) return res.status(401).json({ error: "UNAUTHORIZED" });

    try {
      const user = deps.users.updateProfile(existing.id, {
        displayName: parsed.data.displayName,
        email: parsed.data.email || null
      });
      const preferenceInput = normalizePreferenceInput(user, parsed.data);
      deps.userPreferences.upsertForUser(user, preferenceInput);
      deps.operationLogs?.create({
        actorUserId: user.id,
        actorUsername: user.username,
        action: "user.profile_updated",
        targetType: "user",
        targetId: user.id,
        message: `${user.displayName}更新了个人资料`,
        metadata: { commonProjects: preferenceInput.commonProjects?.length ?? 0 }
      });
      res.json(profileResponse(user, deps.userPreferences));
    } catch (error) {
      const message = error instanceof Error ? error.message : "PROFILE_UPDATE_FAILED";
      if (message === "USER_NOT_FOUND") return res.status(404).json({ error: message });
      res.status(500).json({ error: "PROFILE_UPDATE_FAILED" });
    }
  });

  router.post("/test-email", requireAuth(deps.jwtSecret), async (req, res) => {
    const user = currentUser(req.user?.id, deps.users);
    if (!user) return res.status(401).json({ error: "UNAUTHORIZED" });
    if (!user.email?.trim()) return res.status(400).json({ error: "EMAIL_NOT_CONFIGURED" });

    try {
      const result = await sendTestEmail(deps.settings.all(), user.email, deps.mailTransport);
      if (!result.sent) {
        deps.operationLogs?.create({
          actorUserId: user.id,
          actorUsername: user.username,
          action: "user.profile_test_email_failed",
          targetType: "user",
          targetId: user.id,
          message: "个人测试邮件发送失败：邮件服务未配置",
          metadata: { reason: result.reason }
        });
        return res.status(400).json({ error: "SMTP_NOT_CONFIGURED", reason: result.reason });
      }

      deps.operationLogs?.create({
        actorUserId: user.id,
        actorUsername: user.username,
        action: "user.profile_test_email_sent",
        targetType: "user",
        targetId: user.id,
        message: `${user.displayName}给自己的邮箱发送了测试邮件`,
        metadata: { to: user.email }
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "TEST_EMAIL_FAILED";
      deps.operationLogs?.create({
        actorUserId: user.id,
        actorUsername: user.username,
        action: "user.profile_test_email_failed",
        targetType: "user",
        targetId: user.id,
        message: "个人测试邮件发送失败",
        metadata: { error: message }
      });
      res.status(500).json({ error: "TEST_EMAIL_FAILED", message });
    }
  });

  return router;
}

function currentUser(userId: number | undefined, users: UserRepository): User | null {
  return typeof userId === "number" ? users.getById(userId) : null;
}

function profileResponse(user: User, userPreferences: UserPreferenceRepository) {
  const preferences = userPreferences.getForUser(user);
  return {
    user,
    commonProjects: roleUsesCommonProjects(user.role) ? preferences.commonProjects : [],
    notificationPreferences: preferences.notificationPreferences,
    availableNotificationEvents: availableNotificationEventsForRole(user.role)
  };
}

function normalizePreferenceInput(user: Pick<User, "role">, input: z.infer<typeof updateProfileSchema>): UserPreferenceInput {
  const email = input.notificationPreferences?.email as Partial<Record<NotificationEventKey, boolean>> | undefined;
  return {
    commonProjects: roleUsesCommonProjects(user.role) ? input.commonProjects : [],
    notificationPreferences: email ? { email } : undefined
  };
}

export function availableNotificationEventsForRole(role: string): NotificationEventMeta[] {
  return (eventsByRole[role] ?? []).map((key) => eventMeta[key]);
}

function roleUsesCommonProjects(role: string) {
  return role !== "admin";
}
