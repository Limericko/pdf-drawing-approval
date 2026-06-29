import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import { sendTestEmail, type MailTransport } from "../notifications/email.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import { listDirectories } from "../services/listDirectories.ts";
import { pollFolderPicker, startFolderPicker, type FolderPickerPollResult, type FolderPickerStartResult } from "../services/selectFolder.ts";
import { inspectStandardFolders, prepareStandardFolders } from "../services/standardFolders.ts";

export function settingsRoutes(deps: {
  settings: SettingsRepository;
  operationLogs?: OperationLogRepository;
  mailTransport?: MailTransport | null;
  jwtSecret: string;
  startFolderPicker?: () => Promise<FolderPickerStartResult>;
  pollFolderPicker?: (pickerId: string) => Promise<FolderPickerPollResult>;
  listDirectories?: (currentPath?: string) => Promise<Awaited<ReturnType<typeof listDirectories>>>;
}) {
  const router = Router();

  router.get("/", requireAuth(deps.jwtSecret, ["admin"]), (_req, res) => {
    const all = deps.settings.all();
    if (all.smtp_password) all.smtp_password = "";
    res.json(all);
  });

  router.get("/directories", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    try {
      const currentPath = typeof req.query.path === "string" && req.query.path ? req.query.path : undefined;
      res.json(await (deps.listDirectories ?? listDirectories)(currentPath));
    } catch (error) {
      res.status(400).json({
        error: "DIRECTORY_LIST_FAILED",
        message: error instanceof Error ? error.message : "Unable to list directories"
      });
    }
  });

  router.get("/watch-root/status", requireAuth(deps.jwtSecret, ["admin"]), async (_req, res) => {
    res.json(await inspectStandardFolders(deps.settings.get("watch_root")));
  });

  router.post("/", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    const schema = z.record(z.string());
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    for (const [key, value] of Object.entries(parsed.data)) {
      if (key === "smtp_password" && !value) continue;
      deps.settings.set(key, value);
    }

    res.json({ ok: true });
  });

  router.post("/prepare-folders", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const parsed = z.object({ watchRoot: z.string().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const watchRoot = parsed.data.watchRoot?.trim() || deps.settings.get("watch_root");
    if (!watchRoot) return res.status(400).json({ error: "WATCH_ROOT_REQUIRED" });

    try {
      res.json(await prepareStandardFolders(watchRoot));
    } catch (error) {
      res.status(500).json({
        error: "PREPARE_FOLDERS_FAILED",
        message: error instanceof Error ? error.message : "Unable to prepare folders"
      });
    }
  });

  router.post("/test-smtp", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    const parsed = z.object({ to: z.string().trim().email() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const result = await sendTestEmail(deps.settings.all(), parsed.data.to, deps.mailTransport);
      if (!result.sent) {
        deps.operationLogs?.create({
          actorUserId: req.user?.id ?? null,
          actorUsername: req.user?.username ?? null,
          action: "settings.smtp_test_failed",
          targetType: "settings",
          targetId: null,
          message: "SMTP 测试邮件发送失败：邮件服务未配置",
          metadata: { to: parsed.data.to, reason: result.reason }
        });
        return res.status(400).json({ error: "SMTP_NOT_CONFIGURED", reason: result.reason });
      }

      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "settings.smtp_test_sent",
        targetType: "settings",
        targetId: null,
        message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}发送了 SMTP 测试邮件`,
        metadata: { to: parsed.data.to }
      });
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "SMTP test failed";
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "settings.smtp_test_failed",
        targetType: "settings",
        targetId: null,
        message: "SMTP 测试邮件发送失败",
        metadata: { to: parsed.data.to, error: message }
      });
      return res.status(500).json({ error: "SMTP_TEST_FAILED", message });
    }
  });

  router.post("/select-folder", requireAuth(deps.jwtSecret, ["admin"]), async (_req, res) => {
    try {
      const result = await (deps.startFolderPicker ?? startFolderPicker)();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: "FOLDER_PICKER_FAILED",
        message: error instanceof Error ? error.message : "Unable to open folder picker"
      });
    }
  });

  router.get("/select-folder/:pickerId", requireAuth(deps.jwtSecret, ["admin"]), async (req, res) => {
    try {
      const result = await (deps.pollFolderPicker ?? pollFolderPicker)(req.params.pickerId);
      if (result.status === "selected") {
        deps.settings.set("watch_root", result.path);
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: "FOLDER_PICKER_FAILED",
        message: error instanceof Error ? error.message : "Unable to read folder picker result"
      });
    }
  });

  return router;
}
