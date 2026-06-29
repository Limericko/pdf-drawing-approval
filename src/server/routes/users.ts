import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";
import type { UserRepository } from "../repositories/users.ts";

const roleSchema = z.enum(["designer", "supervisor", "process", "admin"]);

export function userRoutes(deps: { users: UserRepository; operationLogs?: OperationLogRepository; jwtSecret: string }) {
  const router = Router();

  router.get("/", requireAuth(deps.jwtSecret, ["admin"]), (_req, res) => {
    res.json(deps.users.list());
  });

  router.post("/", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    const parsed = z
      .object({
        username: z.string().trim().min(2),
        password: z.string().min(6),
        role: roleSchema,
        email: z.string().trim().email().or(z.literal("")).optional(),
        displayName: z.string().trim().min(1)
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const user = deps.users.create({
        ...parsed.data,
        email: parsed.data.email || null
      });
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "user.created",
        targetType: "user",
        targetId: user.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}创建了用户 ${user.username}`,
        metadata: { username: user.username, role: user.role }
      });
      res.status(201).json(user);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("UNIQUE")) return res.status(409).json({ error: "USERNAME_EXISTS" });
      res.status(500).json({ error: "CREATE_USER_FAILED" });
    }
  });

  router.put("/:id", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    const parsed = z
      .object({
        role: roleSchema,
        email: z.string().trim().email().or(z.literal("")).optional(),
        displayName: z.string().trim().min(1),
        active: z.boolean()
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const user = deps.users.update(Number(req.params.id), {
          ...parsed.data,
          email: parsed.data.email || null
        });
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "user.updated",
        targetType: "user",
        targetId: user.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}更新了用户 ${user.username}`,
        metadata: { username: user.username, role: user.role, active: user.active }
      });
      res.json(user);
    } catch (error) {
      const message = error instanceof Error ? error.message : "UPDATE_USER_FAILED";
      if (message === "USER_NOT_FOUND") return res.status(404).json({ error: message });
      if (message === "LAST_ADMIN_REQUIRED") return res.status(400).json({ error: message });
      res.status(500).json({ error: "UPDATE_USER_FAILED" });
    }
  });

  router.post("/:id/reset-password", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    const parsed = z.object({ password: z.string().min(6) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const user = deps.users.resetPassword(Number(req.params.id), parsed.data.password);
      deps.operationLogs?.create({
        actorUserId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        action: "user.password_reset",
        targetType: "user",
        targetId: user.id,
        message: `${req.user?.displayName ?? req.user?.username ?? "管理员"}重置了用户 ${user.username} 的密码`,
        metadata: { username: user.username }
      });
      res.json(user);
    } catch (error) {
      const message = error instanceof Error ? error.message : "RESET_PASSWORD_FAILED";
      if (message === "USER_NOT_FOUND") return res.status(404).json({ error: message });
      res.status(500).json({ error: "RESET_PASSWORD_FAILED" });
    }
  });

  return router;
}
