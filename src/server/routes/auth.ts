import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { login } from "../auth.ts";
import { createTransport, sendEmail, type MailTransport } from "../notifications/email.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import { hashPasswordResetToken, passwordResetTokenTtlMs, type PasswordResetTokenRepository } from "../repositories/passwordResetTokens.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { UserRepository } from "../repositories/users.ts";

export function authRoutes(deps: {
  users: UserRepository;
  settings: SettingsRepository;
  operationLogs?: OperationLogRepository;
  passwordResetTokens: PasswordResetTokenRepository;
  mailTransport?: MailTransport | null;
  jwtSecret: string;
}) {
  const router = Router();
  const schema = z.object({
    username: z.string().min(1),
    password: z.string().min(1)
  });
  const registerDesignerSchema = z.object({
    username: z.string().trim().min(3),
    password: z.string().min(6),
    displayName: z.string().trim().min(1),
    email: z.string().trim().email().or(z.literal("")).optional()
  });
  const passwordResetRequestSchema = z.object({
    username: z.string().trim().min(1),
    email: z.string().trim().email()
  });
  const passwordResetConfirmSchema = z.object({
    token: z.string().trim().min(1),
    password: z.string().min(6)
  });

  router.post("/login", (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      res.json(login(deps.users, deps.jwtSecret, parsed.data.username, parsed.data.password));
    } catch {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }
  });

  router.post("/register-designer", (req, res) => {
    const parsed = registerDesignerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const user = deps.users.create({
        username: parsed.data.username,
        password: parsed.data.password,
        role: "designer",
        displayName: parsed.data.displayName,
        email: parsed.data.email || null
      });
      deps.operationLogs?.create({
        actorUserId: user.id,
        actorUsername: user.username,
        action: "user.self_registered",
        targetType: "user",
        targetId: user.id,
        message: `${user.displayName}自行注册了设计师账号`,
        metadata: { username: user.username, role: user.role }
      });
      res.status(201).json(login(deps.users, deps.jwtSecret, parsed.data.username, parsed.data.password));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("UNIQUE")) return res.status(409).json({ error: "USERNAME_EXISTS" });
      res.status(500).json({ error: "REGISTER_DESIGNER_FAILED" });
    }
  });

  router.post("/password-reset/request", async (req, res) => {
    const parsed = passwordResetRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const genericResponse = { ok: true };
    const user = deps.users.findByUsername(parsed.data.username);
    if (!user || !emailMatches(user.email, parsed.data.email)) {
      return res.json(genericResponse);
    }

    const settings = deps.settings.all();
    const transport = deps.mailTransport === undefined ? createTransport(settings) : deps.mailTransport;
    if (!transport) {
      deps.operationLogs?.create({
        actorUserId: user.id,
        actorUsername: user.username,
        action: "password_reset.email_failed",
        targetType: "user",
        targetId: user.id,
        message: "密码重置邮件发送失败：SMTP 未配置",
        metadata: { reason: "smtp_not_configured" }
      });
      return res.json(genericResponse);
    }

    const rawToken = randomBytes(32).toString("hex");
    const resetToken = deps.passwordResetTokens.create({
      userId: user.id,
      tokenHash: hashPasswordResetToken(rawToken),
      expiresAt: new Date(Date.now() + passwordResetTokenTtlMs)
    });
    const resetUrl = `${baseUrlForRequest(req, deps.settings)}/#/reset-password?token=${encodeURIComponent(rawToken)}`;

    try {
      await sendEmail(transport, settings, {
        to: user.email!,
        subject: "PDF 图纸审批系统重置密码",
        html: `
          <p>${user.displayName}，你好：</p>
          <p>你正在重置 PDF 图纸审批系统的登录密码。请在 30 分钟内打开以下链接设置新密码：</p>
          <p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>
          <p>如果不是你本人操作，可以忽略此邮件。</p>
        `
      });
      deps.operationLogs?.create({
        actorUserId: user.id,
        actorUsername: user.username,
        action: "password_reset.email_sent",
        targetType: "user",
        targetId: user.id,
        message: `${user.displayName}申请了密码重置邮件`,
        metadata: { expiresAt: resetToken.expiresAt }
      });
    } catch (error) {
      deps.passwordResetTokens.markUsed(resetToken.id);
      deps.operationLogs?.create({
        actorUserId: user.id,
        actorUsername: user.username,
        action: "password_reset.email_failed",
        targetType: "user",
        targetId: user.id,
        message: "密码重置邮件发送失败",
        metadata: { error: error instanceof Error ? error.message : "SEND_FAILED" }
      });
    }

    res.json(genericResponse);
  });

  router.post("/password-reset/confirm", (req, res) => {
    const parsed = passwordResetConfirmSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const resetToken = deps.passwordResetTokens.consumeValid(hashPasswordResetToken(parsed.data.token));
    if (!resetToken) return res.status(400).json({ error: "INVALID_OR_EXPIRED_RESET_TOKEN" });

    try {
      const user = deps.users.resetPassword(resetToken.userId, parsed.data.password);
      deps.operationLogs?.create({
        actorUserId: user.id,
        actorUsername: user.username,
        action: "password_reset.completed",
        targetType: "user",
        targetId: user.id,
        message: `${user.displayName}通过邮件链接重置了密码`,
        metadata: { tokenId: resetToken.id }
      });
      res.json({ ok: true });
    } catch {
      res.status(400).json({ error: "INVALID_OR_EXPIRED_RESET_TOKEN" });
    }
  });

  return router;
}

function emailMatches(userEmail: string | null | undefined, requestedEmail: string) {
  return Boolean(userEmail && userEmail.trim().toLowerCase() === requestedEmail.trim().toLowerCase());
}

function baseUrlForRequest(req: Request, settings: SettingsRepository) {
  const configured = settings.get("app_base_url")?.trim().replace(/\/+$/g, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host") ?? "127.0.0.1:8080"}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
