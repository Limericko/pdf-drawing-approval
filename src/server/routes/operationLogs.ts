import { Router } from "express";
import { requireAuth } from "../auth.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { OperationLogRepository } from "../repositories/operationLogs.ts";

export function operationLogRoutes(deps: { operationLogs: OperationLogRepository; jwtSecret: string }) {
  const router = Router();

  router.get("/", requireAuth(deps.jwtSecret, ["admin"]), (req, res) => {
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    res.json(deps.operationLogs.listRecent(normalizeLimit(limit, 100)));
  });

  return router;
}

export function approvalOperationLogRoutes(deps: {
  approvals: ApprovalRepository;
  operationLogs: OperationLogRepository;
  jwtSecret: string;
}) {
  const router = Router();

  router.get("/:id/operation-logs", requireAuth(deps.jwtSecret), (req, res) => {
    const approvalId = Number(req.params.id);
    const approval = deps.approvals.getById(approvalId);
    if (!approval) return res.status(404).json({ error: "NOT_FOUND" });

    res.json(deps.operationLogs.listForTarget("approval", approval.id));
  });

  return router;
}

function normalizeLimit(limit: number | undefined, fallback: number) {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), 500);
}
